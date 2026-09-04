const fs = require('fs');
const path = require('path');
const { knowledgeBaseDir } = require('./config');

const TODO_FILE = path.join(knowledgeBaseDir, 'notes', 'todo.md');

function ensureFile() {
	if (fs.existsSync(TODO_FILE)) return;
	fs.mkdirSync(path.dirname(TODO_FILE), { recursive: true });
	const frontmatter = [
		'---',
		'type: note',
		'description: "Quick to-do list, managed via Telegram bot."',
		`created: ${new Date().toISOString().slice(0, 10)}`,
		'author: telegram-bridge',
		'tags: ["todo"]',
		'---',
		'',
		'# To-do',
		'',
	].join('\n');
	fs.writeFileSync(TODO_FILE, frontmatter, 'utf8');
}

function parseItems(content) {
	const lines = content.split('\n');
	const items = [];
	lines.forEach((line, idx) => {
		const match = line.match(/^- \[( |x)\] (.*)$/);
		if (match) items.push({ lineIndex: idx, done: match[1] === 'x', text: match[2] });
	});
	return { lines, items };
}

function addItem(text) {
	ensureFile();
	const content = fs.readFileSync(TODO_FILE, 'utf8');
	const newContent = content.trimEnd() + `\n- [ ] ${text}\n`;
	fs.writeFileSync(TODO_FILE, newContent, 'utf8');
}

function listItems({ includeDone = false } = {}) {
	ensureFile();
	const content = fs.readFileSync(TODO_FILE, 'utf8');
	const { items } = parseItems(content);
	return includeDone ? items : items.filter((i) => !i.done);
}

function markDone(n) {
	ensureFile();
	const content = fs.readFileSync(TODO_FILE, 'utf8');
	const { lines, items } = parseItems(content);
	const open = items.filter((i) => !i.done);
	if (n < 1 || n > open.length) throw new Error(`No open item #${n}`);
	const target = open[n - 1];
	lines[target.lineIndex] = lines[target.lineIndex].replace('- [ ]', '- [x]');
	fs.writeFileSync(TODO_FILE, lines.join('\n'), 'utf8');
	return target.text;
}

module.exports = { addItem, listItems, markDone };
