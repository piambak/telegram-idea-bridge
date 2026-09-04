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

module.exports = { generateWordDoc, generateExcelDoc, findTemplate, TEMPLATES_DIR, OUTPUT_DIR };
