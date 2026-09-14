const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// docs/V2-SPEC.md §3: /spend -> finance.fromText -> confirm card
// [💾 Simpan][🗑 Batal] + 11-category keypad, unless SPEND_CONFIRM=0.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-bridge-spend-'));
process.env.STATE_DIR = path.join(tmpRoot, '.state');
process.env.FINANCE_SHEET_ID = 'test-sheet-id';

const telegram = require('../lib/telegram');
const events = [];
let nextMessageId = 1;
telegram.sendMessage = async (chatId, text, extra) => {
	const message_id = nextMessageId++;
	events.push({ type: 'send', text, extra, message_id });
	return { message_id };
};
telegram.editMessageText = async (chatId, messageId, text, extra) => {
	events.push({ type: 'edit', text, extra, message_id: messageId });
	return { message_id: messageId };
};
telegram.sendChatAction = async () => {};
telegram.setMyCommands = async () => {};
telegram.answerCallbackQuery = async () => {};

const fixtureFiles = new Map();
telegram.getFile = async (fileId) => ({ file_id: fileId, file_path: `files/${fileId}` });
telegram.downloadFile = async (filePath) => {
	const fileId = filePath.replace('files/', '');
	if (!fixtureFiles.has(fileId)) throw new Error(`test fixture missing for file_id ${fileId}`);
	return fixtureFiles.get(fileId);
};

const models = require('../lib/models');
for (const key of Object.keys(models.MODELS)) {
	models.MODELS[key].chat = async () => JSON.stringify({ description: 'Makan siang', category: 'Makan', merchant: 'Warteg Bahari' });
}

const sheets = require('../lib/google/sheets');
const appended = [];
sheets.readMonthRows = async () => [];
sheets.appendTransaction = async (date, row) => {
	appended.push({ date, row });
};

const { env, allowedChatId } = require('../lib/config');
const { handleMessage, handleCallbackQuery } = require('../bridge');

test.after(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	delete process.env.STATE_DIR;
	delete process.env.FINANCE_SHEET_ID;
});

const msg = (text) => ({ chat: { id: allowedChatId }, text });
const tick = () => new Promise((r) => setTimeout(r, 80));

test('/spend shows a confirm card with the regex-hint amount and [💾 Simpan][🗑 Batal] + category keypad, nothing logged yet', async () => {
	appended.length = 0;
	events.length = 0;
	delete env.SPEND_CONFIRM;

	await handleMessage(msg('/spend makan siang 45rb'));
	await tick();

	assert.strictEqual(appended.length, 0, 'nothing is logged until confirmed');
	const last = events.at(-1);
	assert.match(last.text, /Makan siang/);
	assert.match(last.text, /Rp 45\.000/);
	const rows = last.extra.reply_markup.inline_keyboard;
	assert.strictEqual(rows[0][0].text, '💾 Simpan');
	assert.strictEqual(rows[0][1].text, '🗑 Batal');
	assert.ok(rows.slice(1).flat().some((b) => b.text === 'Lainnya' && b.callback_data.startsWith('spendcat:')));
});

test('[💾 Simpan] logs the transaction and shows the saved footer', async () => {
	appended.length = 0;
	events.length = 0;

	await handleMessage(msg('/spend makan siang 45rb'));
	await tick();
	const draftMsg = events.at(-1);
	const saveButton = draftMsg.extra.reply_markup.inline_keyboard[0][0];

	events.length = 0;
	await handleCallbackQuery({ id: 'cq1', data: saveButton.callback_data, message: { chat: { id: allowedChatId }, message_id: draftMsg.message_id } });
	await tick();

	assert.strictEqual(appended.length, 1);
	assert.strictEqual(appended[0].row[3], '45000');
	const confirmed = events.at(-1);
	assert.strictEqual(confirmed.type, 'edit');
	assert.match(confirmed.text, /✅ Dicatat/);
});

test('[🗑 Batal] discards the draft, nothing logged', async () => {
	appended.length = 0;
	events.length = 0;

	await handleMessage(msg('/spend ngopi 20rb'));
	await tick();
	const draftMsg = events.at(-1);
	const discardButton = draftMsg.extra.reply_markup.inline_keyboard[0][1];

	events.length = 0;
	await handleCallbackQuery({ id: 'cq2', data: discardButton.callback_data, message: { chat: { id: allowedChatId }, message_id: draftMsg.message_id } });
	await tick();

	assert.strictEqual(appended.length, 0);
	assert.match(events.at(-1).text, /Dibatalkan/);
});

test('tapping a category button updates the card and keeps the draft alive for a later Simpan', async () => {
	appended.length = 0;
	events.length = 0;

	await handleMessage(msg('/spend makan siang 45rb'));
	await tick();
	const draftMsg = events.at(-1);
	const transportButton = draftMsg.extra.reply_markup.inline_keyboard[1][1]; // ['Makan','Transport','Belanja']
	assert.strictEqual(transportButton.text, 'Transport');

	events.length = 0;
	await handleCallbackQuery({ id: 'cq3', data: transportButton.callback_data, message: { chat: { id: allowedChatId }, message_id: draftMsg.message_id } });
	await tick();

	const recategorized = events.at(-1);
	assert.strictEqual(recategorized.type, 'edit');
	assert.match(recategorized.text, /Transport/);
	assert.ok(recategorized.extra.reply_markup, 'buttons must still be attached — the draft is not done yet');

	// The draft must still be there for a subsequent Simpan.
	const saveButton = recategorized.extra.reply_markup.inline_keyboard[0][0];
	events.length = 0;
	await handleCallbackQuery({ id: 'cq4', data: saveButton.callback_data, message: { chat: { id: allowedChatId }, message_id: draftMsg.message_id } });
	await tick();
	assert.strictEqual(appended.length, 1);
	assert.strictEqual(appended[0].row[2], 'Transport', 'the recategorized value must be what gets logged');
});

test('a photo captioned /spend goes straight to the receipt confirm card, skipping the "what is this for?" prompt', async (t) => {
	appended.length = 0;
	events.length = 0;
	fixtureFiles.set('receipt-1', Buffer.from('fake receipt bytes'));
	t.mock.method(models.MODELS.gemini, 'chat', async () =>
		JSON.stringify({ merchant: 'Indomaret', date: '2026-09-14', total: 47_500, items: [{ name: 'Air mineral', amount: 5_000 }] }),
	);

	await handleMessage({ chat: { id: allowedChatId }, caption: '/spend', photo: [{ file_id: 'receipt-1' }] });
	await tick();

	assert.strictEqual(appended.length, 0, 'not logged until confirmed');
	const last = events.at(-1);
	assert.match(last.text, /Indomaret/);
	assert.match(last.text, /Rp 47\.500/);
	assert.strictEqual(last.extra.reply_markup.inline_keyboard[0][0].text, '💾 Simpan');
});

test('SPEND_CONFIRM=0 logs immediately, no confirm card', async () => {
	appended.length = 0;
	events.length = 0;
	env.SPEND_CONFIRM = '0';

	await handleMessage(msg('/spend bensin 100rb'));
	await tick();

	assert.strictEqual(appended.length, 1, 'logged immediately, no button press needed');
	const last = events.at(-1);
	assert.strictEqual(last.extra, undefined, 'no confirm-card buttons when auto-saving');
	assert.match(last.text, /✅ Dicatat/);

	delete env.SPEND_CONFIRM;
});
