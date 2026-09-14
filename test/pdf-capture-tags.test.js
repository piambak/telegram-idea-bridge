const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const cp = require('child_process'); // same specifier lib/claude.js uses

// /pdf's capture step now goes through the research-capturer deep agent for
// real tags instead of always []. Sandbox the vault so writeSourceCapture
// never touches the real one.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-bridge-pdfcap-'));
process.env.OPENKNOWLEDGE_DIR = tmpRoot;

const telegram = require('../lib/telegram');
const sentMsgs = [];
telegram.sendMessage = async (chatId, text) => {
	sentMsgs.push(text);
};
telegram.sendChatAction = async () => {};
telegram.setMyCommands = async () => {};

const models = require('../lib/models');
for (const key of Object.keys(models.MODELS)) models.MODELS[key].chat = async () => 'short summary text';

const pdf = require('../lib/pdf');
pdf.resolvePdfUrl = async (input) => input;
pdf.isUrl = () => true;
pdf.fetchPdfBuffer = async (url) => ({ buffer: Buffer.from('fake pdf bytes'), finalUrl: url });
pdf.extractText = async () => 'Extracted PDF text, short enough for the fast summarizer.';

function fakeChild() {
	const child = new EventEmitter();
	child.stdin = { write() {}, end() {}, on() {} };
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.kill = () => {};
	return child;
}
const envelope = (obj) => Buffer.from(JSON.stringify(obj));

const { allowedChatId } = require('../lib/config');
const { handleMessage } = require('../bridge');

test.after(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	delete process.env.OPENKNOWLEDGE_DIR;
});

test('/pdf capture runs research-capturer and saves the tags it returns', async (t) => {
	const child = fakeChild();
	let seenArgs;
	t.mock.method(cp, 'spawn', (bin, args) => {
		seenArgs = args;
		// Reply once for the CLI call this test drives.
		setImmediate(() => {
			child.stdout.emit(
				'data',
				envelope({
					is_error: false,
					result: JSON.stringify({
						title: 'PMK 64/2026',
						tags: ['pmk', 'pajak-digital'],
						key_claims: ['Mewajibkan kios pajak digital'],
						related_notes: [],
						summary: 'Ringkasan singkat.',
					}),
				}),
			);
			child.emit('close', 0);
		});
		return child;
	});

	await handleMessage({ chat: { id: allowedChatId }, text: '/pdf https://example.com/pmk-64.pdf' });
	await new Promise((r) => setTimeout(r, 100));

	assert.ok(seenArgs.includes('--agent'));
	assert.strictEqual(seenArgs[seenArgs.indexOf('--agent') + 1], 'research-capturer');
	assert.strictEqual(seenArgs[seenArgs.indexOf('--allowedTools') + 1], 'Read,Grep,Glob');

	const notesDir = path.join(tmpRoot, 'external-sources');
	const files = fs.readdirSync(notesDir).filter((f) => f.endsWith('.md'));
	assert.strictEqual(files.length, 1);
	const note = fs.readFileSync(path.join(notesDir, files[0]), 'utf8');
	assert.match(note, /tags:.*pmk/);
	assert.match(note, /tags:.*pajak-digital/);

	assert.ok(sentMsgs.at(-1).includes('Captured'));
});

test('/pdf capture falls back to empty tags when research-capturer fails, without losing the capture', async (t) => {
	t.mock.method(cp, 'spawn', () => {
		const child = fakeChild();
		setImmediate(() => child.emit('error', new Error('spawn claude ENOENT')));
		return child;
	});
	t.mock.method(console, 'error', () => {});

	await handleMessage({ chat: { id: allowedChatId }, text: '/pdf https://example.com/other.pdf' });
	await new Promise((r) => setTimeout(r, 100));

	assert.ok(sentMsgs.at(-1).includes('Captured'), 'the capture should still succeed even if tagging fails');
});
