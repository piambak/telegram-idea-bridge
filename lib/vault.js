const fs = require('fs');
const path = require('path');
const { knowledgeBaseDir } = require('./config');

const SKIP_DIRS = new Set(['.ok', '.git', 'node_modules']);

function walkMarkdownFiles(dir) {
	const out = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walkMarkdownFiles(full));
		else if (entry.name.endsWith('.md')) out.push(full);
	}
	return out;
}

function parseFrontmatterTitle(content, fallback) {
	const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
	if (fmMatch) {
		const descMatch = fmMatch[1].match(/^description:\s*"?(.*?)"?\s*$/m);
		if (descMatch) return descMatch[1];
	}
	const headingMatch = content.match(/^#\s+(.+)$/m);
	if (headingMatch) return headingMatch[1].trim();
	return fallback;
}

function relPath(filePath) {
	return path.relative(knowledgeBaseDir, filePath).replace(/\\/g, '/');
}

function listNotes(limit = 10) {
	const files = walkMarkdownFiles(knowledgeBaseDir)
		.map((f) => ({ file: f, mtime: fs.statSync(f).mtimeMs }))
		.sort((a, b) => b.mtime - a.mtime)
		.slice(0, limit);

	return files.map(({ file }) => {
		const content = fs.readFileSync(file, 'utf8');
		return { path: relPath(file), title: parseFrontmatterTitle(content, path.basename(file, '.md')) };
	});
}

function searchNotes(query, limit = 10) {
	const q = query.toLowerCase();
	const results = [];
	for (const file of walkMarkdownFiles(knowledgeBaseDir)) {
		const content = fs.readFileSync(file, 'utf8');
		const idx = content.toLowerCase().indexOf(q);
		if (idx === -1) continue;
		const snippetStart = Math.max(0, idx - 60);
		const snippet = content.slice(snippetStart, idx + q.length + 60).replace(/\s+/g, ' ').trim();
		results.push({
			path: relPath(file),
			title: parseFrontmatterTitle(content, path.basename(file, '.md')),
			snippet: (snippetStart > 0 ? '...' : '') + snippet + '...',
		});
		if (results.length >= limit) break;
	}
	return results;
}

function readNote(relativePath) {
	const full = path.join(knowledgeBaseDir, relativePath);
	if (!full.startsWith(knowledgeBaseDir)) throw new Error('Invalid path');
	if (!fs.existsSync(full)) throw new Error('Note not found');
	return fs.readFileSync(full, 'utf8');
}

module.exports = { listNotes, searchNotes, readNote };
