const fs = require('fs');
const path = require('path');
const { knowledgeBaseDir } = require('./config');

function slugify(title) {
	return (
		title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 60) || 'untitled'
	);
}

function yamlString(value) {
	return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function yamlList(values) {
	if (!values || values.length === 0) return '[]';
	return `[${values.map((v) => yamlString(v)).join(', ')}]`;
}

function uniqueFilePath(dir, slug) {
	fs.mkdirSync(dir, { recursive: true });
	let candidate = path.join(dir, `${slug}.md`);
	let n = 2;
	while (fs.existsSync(candidate)) {
		candidate = path.join(dir, `${slug}-${n}.md`);
		n += 1;
	}
	return candidate;
}

function writeIdeaNote({ title, tags, rawIdea, enhancedBody }) {
	const dir = path.join(knowledgeBaseDir, 'notes');
	const filePath = uniqueFilePath(dir, slugify(title));
	const frontmatter = [
		'---',
		'type: note',
		`description: ${yamlString(title)}`,
		`created: ${new Date().toISOString().slice(0, 10)}`,
		'author: telegram-bridge',
		`tags: ${yamlList(['idea', ...tags])}`,
		'---',
		'',
		`# ${title}`,
		'',
		'## Original idea',
		'',
		rawIdea.trim(),
		'',
		'## Enhanced',
		'',
		enhancedBody.trim(),
		'',
	].join('\n');
	fs.writeFileSync(filePath, frontmatter, 'utf8');
	return filePath;
}

function writeSourceCapture({ title, sourceUrl, tags, extractedText, notes, summary }) {
	const dir = path.join(knowledgeBaseDir, 'external-sources');
	const filePath = uniqueFilePath(dir, slugify(title));
	const frontmatter = [
		'---',
		'type: source',
		`description: ${yamlString(title)}`,
		`source_url: ${yamlString(sourceUrl || '')}`,
		`date_fetched: ${new Date().toISOString().slice(0, 10)}`,
		'preservation: text-extracted',
		`tags: ${yamlList(['source', 'pdf', ...tags])}`,
		'---',
		'',
		'## Source',
		'',
		sourceUrl ? `<${sourceUrl}>` : '',
		...(summary ? ['', '## Summary', '', summary.trim()] : []),
		'',
		'## Highlights',
		'',
		extractedText.trim(),
		'',
		'## My notes',
		'',
		(notes || '').trim(),
		'',
	].join('\n');
	fs.writeFileSync(filePath, frontmatter, 'utf8');
	return filePath;
}

module.exports = { writeIdeaNote, writeSourceCapture, slugify };
