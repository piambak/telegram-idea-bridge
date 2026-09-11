const fs = require('fs');
const path = require('path');
const os = require('os');
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');
const ExcelJS = require('exceljs');
const { Document, Packer, Paragraph, HeadingLevel, TextRun } = require('docx');
const claudeCli = require('./claude');

// Word/Excel editing is the "high workload" job — routed through the local
// Claude CLI rather than the fast free models, per explicit instruction.
const TEMPLATES_DIR = path.join(os.homedir(), 'OneDrive - Kemenkeu', 'Bot Templates');
const OUTPUT_DIR = path.join(os.homedir(), 'OneDrive - Kemenkeu', 'Bot Output');

function findTemplate(name) {
	if (!name || !fs.existsSync(TEMPLATES_DIR)) return null;
	const files = fs.readdirSync(TEMPLATES_DIR);
	const lowerName = name.toLowerCase();
	return files.find((f) => f.toLowerCase().includes(lowerName)) || null;
}

// A template is only useful if it has {placeholders} for us to fill. Scanning
// for them is also the honest answer to "why did my template come back
// unchanged?" — docxtemplater renders a tag-less document verbatim.
function tagsInDocx(filePath) {
	const zip = new PizZip(fs.readFileSync(filePath, 'binary'));
	const tags = new Set();
	for (const name of Object.keys(zip.files)) {
		if (!/^word\/(document|header\d*|footer\d*)\.xml$/.test(name)) continue;
		// Word splits a typed "{content}" across several <w:r> runs; stripping
		// the XML tags first is what makes the placeholder visible again.
		const text = zip.file(name).asText().replace(/<[^>]+>/g, '');
		for (const m of text.matchAll(/\{([a-zA-Z0-9_.]+)\}/g)) tags.add(m[1]);
	}
	return [...tags];
}

async function tagsInXlsx(filePath) {
	const workbook = new ExcelJS.Workbook();
	await workbook.xlsx.readFile(filePath);
	const tags = new Set();
	workbook.eachSheet((sheet) => {
		sheet.eachRow((row) => {
			row.eachCell((cell) => {
				// cell.text throws on some empty/merged cells, so read .value only.
				const raw = cell.value;
				const v = typeof raw === 'string' ? raw : raw && typeof raw.richText === 'object' ? raw.richText.map((r) => r.text).join('') : null;
				if (!v) return;
				for (const m of v.matchAll(/\{([a-zA-Z0-9_.]+)\}/g)) tags.add(m[1]);
			});
		});
	});
	return [...tags];
}

// [{ file, ext, tags }] for every template on disk, newest name order.
async function listTemplates() {
	if (!fs.existsSync(TEMPLATES_DIR)) return [];
	const files = fs.readdirSync(TEMPLATES_DIR).filter((f) => /\.(docx|xlsx)$/i.test(f) && !f.startsWith('~$'));
	const out = [];
	for (const file of files.sort()) {
		const ext = path.extname(file).toLowerCase();
		let tags = [];
		try {
			tags = ext === '.docx' ? tagsInDocx(path.join(TEMPLATES_DIR, file)) : await tagsInXlsx(path.join(TEMPLATES_DIR, file));
		} catch {
			tags = null; // unreadable / corrupt — surfaced as such in the listing
		}
		out.push({ file, ext, tags });
	}
	return out;
}

function uniqueOutputPath(baseName, ext) {
	fs.mkdirSync(OUTPUT_DIR, { recursive: true });
	const slug = baseName.replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 60) || 'document';
	let candidate = path.join(OUTPUT_DIR, `${slug}${ext}`);
	let n = 2;
	while (fs.existsSync(candidate)) {
		candidate = path.join(OUTPUT_DIR, `${slug} (${n})${ext}`);
		n += 1;
	}
	return candidate;
}

function todayId() {
	return new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
}

// ---- Word ----

const DRAFT_PROMPT = (brief) => `You are drafting the content for an office document in an Indonesian
government tax office (Kemenkeu/DJP) context, based on this brief (which describes what kind of
document it is and what it should say): "${brief}"

Respond with EXACTLY this structure and nothing else:
TITLE: <a short, specific document title>

<the full document body — professional Indonesian office tone unless the brief is written in English,
well-organized paragraphs separated by blank lines, no markdown formatting, ready to paste into Word>`;

async function draftContent(brief) {
	const reply = await claudeCli.runHeadless(DRAFT_PROMPT(brief), { timeoutMs: 5 * 60 * 1000 });
	const titleMatch = reply.match(/^TITLE:\s*(.+)$/im);
	const title = titleMatch ? titleMatch[1].trim() : brief.slice(0, 60);
	const content = reply.replace(/^TITLE:.*$/im, '').trim();
	return { title, content };
}

function fillDocxTemplate(templatePath, data) {
	const zip = new PizZip(fs.readFileSync(templatePath, 'binary'));
	const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
	doc.render(data);
	return doc.getZip().generate({ type: 'nodebuffer' });
}

async function generateDefaultDocx({ title, content, author }) {
	const paragraphs = [
		new Paragraph({ text: title, heading: HeadingLevel.HEADING_1 }),
		new Paragraph({ text: todayId() }),
		new Paragraph({ text: '' }),
		...content.split(/\n\s*\n/).map((p) => new Paragraph({ children: [new TextRun(p.trim())] })),
	];
	if (author) paragraphs.push(new Paragraph({ text: '' }), new Paragraph({ text: author }));
	const doc = new Document({ sections: [{ children: paragraphs }] });
	return Packer.toBuffer(doc);
}

// templateName + brief -> a .docx saved into OneDrive Bot Output. Uses a
// matching template from Bot Templates (placeholders: {title} {date}
// {content} {author}) if one is found by name, else builds a clean default doc.
async function generateWordDoc({ templateName, brief, author }) {
	const { title, content } = await draftContent(brief);
	const templateFile = findTemplate(templateName);
	let buffer;
	if (templateFile) {
		buffer = fillDocxTemplate(path.join(TEMPLATES_DIR, templateFile), {
			title,
			content,
			author: author || '',
			date: todayId(),
		});
	} else {
		buffer = await generateDefaultDocx({ title, content, author });
	}
	const outputPath = uniqueOutputPath(title, '.docx');
	fs.writeFileSync(outputPath, buffer);
	return { outputPath, title, usedTemplate: !!templateFile };
}

// ---- Excel ----

const EXCEL_PROMPT = (brief) => `You convert a data description into a table for a spreadsheet.
Brief: "${brief}"

Respond with ONLY a JSON object, no code fences, no explanation, in exactly this shape:
{"title": "...", "headers": ["col1", "col2", ...], "rows": [["v1", "v2", ...], ...]}`;

async function draftTable(brief) {
	const reply = await claudeCli.runHeadless(EXCEL_PROMPT(brief), { timeoutMs: 5 * 60 * 1000 });
	const match = reply.match(/\{[\s\S]*\}/);
	if (!match) throw new Error('Could not parse table data from that brief');
	return JSON.parse(match[0]);
}

async function generateExcelDoc({ templateName, brief }) {
	const { title, headers, rows } = await draftTable(brief);
	const templateFile = findTemplate(templateName);
	const workbook = new ExcelJS.Workbook();
	if (templateFile) {
		await workbook.xlsx.readFile(path.join(TEMPLATES_DIR, templateFile));
		const sheet = workbook.worksheets[0];
		rows.forEach((row) => sheet.addRow(row));
	} else {
		const sheet = workbook.addWorksheet((title || 'Sheet1').slice(0, 31));
		sheet.addRow(headers);
		sheet.getRow(1).font = { bold: true };
		rows.forEach((row) => sheet.addRow(row));
		sheet.columns.forEach((col) => {
			col.width = 20;
		});
	}
	const outputPath = uniqueOutputPath(title, '.xlsx');
	await workbook.xlsx.writeFile(outputPath);
	return { outputPath, title, usedTemplate: !!templateFile };
}

module.exports = { generateWordDoc, generateExcelDoc, findTemplate, listTemplates, TEMPLATES_DIR, OUTPUT_DIR };
