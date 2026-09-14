const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const cp = require('child_process'); // same specifier lib/claude.js uses

// docs/V2-SPEC.md §1 "New inputs": message.document (PDF) -> the /pdf
// pipeline, message.voice -> Groq Whisper -> routed as text, photo with no
// caption -> "Foto ini untuk apa?" buttons.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-bridge-newinputs-'));
process.env.OPENKNOWLEDGE_DIR = tmpRoot;
process.env.STATE_DIR = path.join(tmpRoot, '.state');

const telegram = require('../lib/telegram');
const events = [];
let nextMessageId = 1;
telegram.sendMessage = async (chatId, text, extra) => {
	const message_id = nextMessageId++;
	events.push({ type: 'send', chatId, text, extra, message_id });
	return { message_id };
};
telegram.editMessageText = async (chatId, messageId, text, extra) => {
	events.push({ type: 'edit', chatId, messageId, text, extra });
	return { message_id: messageId };
};
telegram.sendChatAction = async () => {};
telegram.setMyCommands = async () => {};
telegram.answerCallbackQuery = async () => {};

// A stubbed Telegram file API: getFile/downloadFile driven entirely by an
// in-memory fixture map keyed by file_id, never a real network call.
const fixtureFiles = new Map();
telegram.getFile = async (fileId) => ({ file_id: fileId, file_path: `files/${fileId}` });
telegram.downloadFile = async (filePath) => {
	const fileId = filePath.replace('files/', '');
	if (!fixtureFiles.has(fileId)) throw new Error(`test fixture missing for file_id ${fileId}`);
	return fixtureFiles.get(fileId);
};

const pdf = require('../lib/pdf');
pdf.extractText = async (buffer) => buffer.toString('utf8');
pdf.isUrl = () => false;

// handleIdea fire-and-forgets a vault sync after saving — stub it so the
// voice-note test (which ends up saving an idea) never touches the real
// obsidian-vault path.
const vaultsync = require('../lib/vaultsync');
vaultsync.sync = async () => {};

// A context-aware model stub: different skills expect different JSON
// shapes, so branch on which skill's system prompt is asking.
const models = require('../lib/models');
const modelChat = async (messages) => {
	const systemPrompt = messages[0].content;
	if (systemPrompt.includes('idea-development assistant')) {
		return JSON.stringify({ title: 'Kios Pajak Digital', tags: ['pajak'], body: 'Enhanced idea body.', language: 'id', save_confidence: 0.9 });
	}
	if (systemPrompt.includes('document summarizer')) {
		return 'Ringkasan singkat dokumen.';
	}
	return 'stub reply';
};
for (const key of Object.keys(models.MODELS)) models.MODELS[key].chat = modelChat;

function fakeChild() {
	const child = new EventEmitter();
	child.stdin = { write() {}, end() {}, on() {} };
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.kill = () => {};
	return child;
}
const envelope = (obj) => Buffer.from(JSON.stringify(obj));
function mockSourceCapture(t, data) {
	t.mock.method(cp, 'spawn', () => {
		const child = fakeChild();
		setImmediate(() => {
			child.stdout.emit('data', envelope({ is_error: false, result: JSON.stringify(data) }));
			child.emit('close', 0);
		});
		return child;
	});
}

const { allowedChatId } = require('../lib/config');
const { handleMessage, handleCallbackQuery } = require('../bridge');

test.after(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	delete process.env.OPENKNOWLEDGE_DIR;
	delete process.env.STATE_DIR;
});

const tick = () => new Promise((r) => setTimeout(r, 120));

// --- message.document ---

test('message.document (PDF) runs the same capture pipeline as /pdf', async (t) => {
	fixtureFiles.set('doc-pdf-1', Buffer.from('Full extracted text of PMK 64/2026.'));
	mockSourceCapture(t, { title: 'PMK 64/2026', tags: ['pmk', 'pajak'], key_claims: [], related_notes: [], summary: 'ok' });

	events.length = 0;
	await handleMessage({
		chat: { id: allowedChatId },
		document: { file_id: 'doc-pdf-1', file_name: 'PMK-64-2026.pdf', mime_type: 'application/pdf' },
	});
	await tick();

	const last = events.at(-1);
	assert.match(last.text, /Captured/);
	const notesDir = path.join(tmpRoot, 'external-sources');
	const files = fs.readdirSync(notesDir).filter((f) => f.endsWith('.md'));
	assert.strictEqual(files.length, 1);
	const note = fs.readFileSync(path.join(notesDir, files[0]), 'utf8');
	assert.match(note, /Full extracted text of PMK 64\/2026\./, 'the full uploaded text should be captured, same as /pdf');
	assert.match(note, /pmk/, 'tags from the capture pipeline should be present');
});

test('message.document declines a non-PDF (e.g. .docx) instead of erroring — deliberately out of scope this round', async () => {
	events.length = 0;
	await handleMessage({
		chat: { id: allowedChatId },
		document: { file_id: 'doc-docx-1', file_name: 'template.docx', mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
	});
	await tick();

	const last = events.at(-1);
	assert.match(last.text, /PDF/);
	assert.match(last.text, /template\.docx/);
});

// --- message.voice ---

test('message.voice transcribes via Groq Whisper then routes the transcript as text (an idea, here)', async (t) => {
	fixtureFiles.set('voice-1', Buffer.from('raw ogg bytes'));
	t.mock.method(global, 'fetch', async (url, opts) => {
		assert.strictEqual(url, 'https://api.groq.com/openai/v1/audio/transcriptions');
		assert.ok(opts.body instanceof FormData);
		return { ok: true, json: async () => ({ text: 'Buat kios pajak digital untuk warga' }) };
	});

	events.length = 0;
	await handleMessage({ chat: { id: allowedChatId }, voice: { file_id: 'voice-1', duration: 4 } });
	await tick();

	const transcriptEvent = events.find((e) => e.text.includes('🎤'));
	assert.ok(transcriptEvent, 'the transcript should be shown to the user');
	assert.match(transcriptEvent.text, /Buat kios pajak digital untuk warga/);

	// The transcript was routed as ordinary text: since it doesn't start
	// with "/" or "?", it became an idea, going through the same
	// idea-enhance -> card flow as typed text.
	const ideaEvent = events.at(-1);
	assert.match(ideaEvent.text, /Kios Pajak Digital/);
});

test('message.voice surfaces a clear error when transcription fails, without crashing the handler', async (t) => {
	fixtureFiles.set('voice-2', Buffer.from('raw ogg bytes'));
	t.mock.method(global, 'fetch', async () => ({ ok: false, status: 500, text: async () => 'groq down' }));

	events.length = 0;
	await handleMessage({ chat: { id: allowedChatId }, voice: { file_id: 'voice-2', duration: 2 } });
	await tick();

	assert.match(events.at(-1).text, /Voice transcription failed/);
});

// --- photo without caption ---

test('a photo with no caption asks what it\'s for, with [💸 Catat struk] [🧮 Hitung] buttons', async () => {
	events.length = 0;
	await handleMessage({ chat: { id: allowedChatId }, photo: [{ file_id: 'photo-1', file_size: 100 }] });
	await tick();

	const last = events.at(-1);
	assert.match(last.text, /Foto ini untuk apa\?/);
	const buttons = last.extra.reply_markup.inline_keyboard[0];
	assert.strictEqual(buttons[0].text, '💸 Catat struk');
	assert.strictEqual(buttons[1].text, '🧮 Hitung');
	assert.match(buttons[0].callback_data, /^photoreceipt:.+$/);
	assert.match(buttons[1].callback_data, /^photocalc:.+$/);
});

test('a photo WITH a non-/calc caption is ignored (existing behavior, unchanged)', async () => {
	events.length = 0;
	await handleMessage({ chat: { id: allowedChatId }, photo: [{ file_id: 'photo-2' }], caption: 'just a memo' });
	await tick();
	assert.strictEqual(events.length, 0);
});

test('[🧮 Hitung] on a prompted photo runs the same calc-vision pipeline as /calc + photo', async (t) => {
	fixtureFiles.set('photo-calc-1', Buffer.from('fake image bytes'));
	t.mock.method(models.MODELS.gemini, 'chat', async () => JSON.stringify({ expression: '6 * 7' }));
	t.mock.method(cp, 'spawn', () => {
		throw new Error('the deep-tier fallback must not run when the fast vision call succeeds');
	});

	events.length = 0;
	await handleMessage({ chat: { id: allowedChatId }, photo: [{ file_id: 'photo-calc-1' }] });
	await tick();
	const promptMsg = events.at(-1);
	const calcButton = promptMsg.extra.reply_markup.inline_keyboard[0][1];

	events.length = 0;
	await handleCallbackQuery({ id: 'cq1', data: calcButton.callback_data, message: { chat: { id: allowedChatId }, message_id: promptMsg.message_id } });
	await tick();

	const result = events.at(-1);
	assert.strictEqual(result.type, 'edit');
	assert.strictEqual(result.messageId, promptMsg.message_id, 'the prompt message is edited in place, not replaced by a new one');
	assert.match(result.text, /<code>6 \* 7<\/code>/);
	assert.match(result.text, /<b>42<\/b>/);
});

test('[💸 Catat struk] on a prompted photo reads the receipt via receipt-vision and shows a confirm card + category keypad, not yet saved', async (t) => {
	fixtureFiles.set('photo-receipt-1', Buffer.from('fake receipt image bytes'));
	t.mock.method(models.MODELS.gemini, 'chat', async (messages) => {
		const userContent = messages[1].content;
		assert.ok(Array.isArray(userContent));
		assert.ok(userContent.some((p) => p.type === 'image_url'));
		return JSON.stringify({ merchant: 'Indomaret', date: '2026-09-14', total: 47500, items: [{ name: 'Air mineral', amount: 5000 }] });
	});

	events.length = 0;
	await handleMessage({ chat: { id: allowedChatId }, photo: [{ file_id: 'photo-receipt-1' }] });
	await tick();
	const promptMsg = events.at(-1);
	const receiptButton = promptMsg.extra.reply_markup.inline_keyboard[0][0];

	events.length = 0;
	await handleCallbackQuery({ id: 'cq2', data: receiptButton.callback_data, message: { chat: { id: allowedChatId }, message_id: promptMsg.message_id } });
	await tick();

	const result = events.at(-1);
	assert.strictEqual(result.type, 'edit');
	assert.strictEqual(result.messageId, promptMsg.message_id);
	assert.match(result.text, /Indomaret/);
	assert.match(result.text, /Air mineral/);
	assert.match(result.text, /47\.500/);
	assert.doesNotMatch(result.text, /✅ Dicatat/, 'not saved yet — the confirm card is shown first');
	const rows = result.extra.reply_markup.inline_keyboard;
	assert.match(rows[0][0].callback_data, /^spendsave:/, 'Simpan button');
	assert.match(rows[0][1].callback_data, /^spenddiscard:/, 'Batal button');
	assert.ok(rows.slice(1).flat().some((btn) => btn.callback_data.startsWith('spendcat:') && btn.text === 'Makan'), 'category keypad');
});
