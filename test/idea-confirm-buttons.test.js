const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// docs/V2-SPEC.md §1: plain text with save_confidence < 0.5 asks
// [💾 Simpan] [💬 Jawab saja] [🗑 Buang] instead of committing chit-chat to
// the vault.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-bridge-confirm-'));
process.env.STATE_DIR = path.join(tmpRoot, '.state');

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

const models = require('../lib/models');
let stubReply;
for (const key of Object.keys(models.MODELS)) models.MODELS[key].chat = async () => JSON.stringify(stubReply);

const knowledge = require('../lib/knowledge');
const writtenNotes = [];
knowledge.writeIdeaNote = ({ title, tags, rawIdea, enhancedBody }) => {
	writtenNotes.push({ title, tags, rawIdea, enhancedBody });
	return path.join('notes', `${knowledge.slugify(title)}.md`);
};

const vaultsync = require('../lib/vaultsync');
const syncCalls = [];
vaultsync.sync = async (message) => {
	syncCalls.push(message);
};

const { allowedChatId } = require('../lib/config');
const { handleMessage, handleCallbackQuery } = require('../bridge');

test.after(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	delete process.env.STATE_DIR;
});

const msg = (text) => ({ chat: { id: allowedChatId }, text });
const tick = () => new Promise((r) => setTimeout(r, 80));

test('save_confidence < 0.5 offers buttons and does NOT save immediately', async () => {
	stubReply = { title: 'ok thanks', tags: [], body: 'Baik, sama-sama!', language: 'id', save_confidence: 0.2 };
	writtenNotes.length = 0;
	syncCalls.length = 0;
	events.length = 0;

	await handleMessage(msg('ok makasih ya'));
	await tick();

	assert.strictEqual(writtenNotes.length, 0, 'a low-confidence idea must not be saved automatically');
	assert.strictEqual(syncCalls.length, 0);
	const last = events.at(-1);
	assert.strictEqual(last.type, 'edit', 'replaces the progress placeholder in place');
	const buttons = last.extra.reply_markup.inline_keyboard[0];
	assert.strictEqual(buttons[0].text, '💾 Simpan');
	assert.strictEqual(buttons[1].text, '💬 Jawab saja');
	assert.strictEqual(buttons[2].text, '🗑 Buang');
	assert.match(buttons[0].callback_data, /^ideasave:.+$/);
	assert.match(buttons[1].callback_data, /^ideaanswer:.+$/);
	assert.match(buttons[2].callback_data, /^ideadiscard:.+$/);
});

test('save_confidence >= 0.5 still saves immediately, no buttons (existing behavior unchanged)', async () => {
	stubReply = { title: 'Kios Pajak Digital', tags: ['pajak'], body: 'Ide bagus.', language: 'id', save_confidence: 0.8 };
	writtenNotes.length = 0;
	events.length = 0;

	await handleMessage(msg('bikin kios pajak digital'));
	await tick();

	assert.strictEqual(writtenNotes.length, 1);
	assert.strictEqual(events.at(-1).extra, undefined, 'a confidently-saved idea has no buttons attached');
});

test('[💾 Simpan] saves the held draft and shows the normal saved-note card', async () => {
	stubReply = { title: 'Mungkin ide', tags: ['draft'], body: 'Perlu dipikirkan lagi.', language: 'id', save_confidence: 0.3 };
	writtenNotes.length = 0;
	syncCalls.length = 0;
	events.length = 0;

	await handleMessage(msg('entah, mungkin ide bagus?'));
	await tick();
	const draftMsg = events.at(-1);
	const saveButton = draftMsg.extra.reply_markup.inline_keyboard[0][0];

	events.length = 0;
	await handleCallbackQuery({ id: 'cq1', data: saveButton.callback_data, message: { chat: { id: allowedChatId }, message_id: draftMsg.message_id } });
	await tick();

	assert.strictEqual(writtenNotes.length, 1);
	assert.deepStrictEqual(writtenNotes[0].tags, ['draft']);
	assert.strictEqual(syncCalls.length, 1, 'saving via the button should also trigger a vault sync');
	const confirmed = events.at(-1);
	assert.strictEqual(confirmed.type, 'edit');
	assert.strictEqual(confirmed.message_id, draftMsg.message_id);
	assert.match(confirmed.text, /💾 notes\//, 'the saved card should now show a footer pointing at the file');
});

test('[💬 Jawab saja] shows the enhanced content as a plain answer and never saves', async () => {
	stubReply = { title: 'Pertanyaan', tags: [], body: 'Ini jawabannya langsung, tanpa disimpan.', language: 'id', save_confidence: 0.1 };
	writtenNotes.length = 0;
	events.length = 0;

	await handleMessage(msg('berapa jam lagi ya rapatnya?'));
	await tick();
	const draftMsg = events.at(-1);
	const answerButton = draftMsg.extra.reply_markup.inline_keyboard[0][1];

	events.length = 0;
	await handleCallbackQuery({ id: 'cq2', data: answerButton.callback_data, message: { chat: { id: allowedChatId }, message_id: draftMsg.message_id } });
	await tick();

	assert.strictEqual(writtenNotes.length, 0, '"Jawab saja" must never save');
	const answered = events.at(-1);
	assert.strictEqual(answered.type, 'edit');
	assert.match(answered.text, /Ini jawabannya langsung, tanpa disimpan\./);
	assert.ok(!answered.text.includes('💾'), 'no save-file footer once discarded as a save target');
});

test('[🗑 Buang] discards the draft and never saves', async () => {
	stubReply = { title: 'Chit chat', tags: [], body: 'Haha iya betul.', language: 'id', save_confidence: 0.15 };
	writtenNotes.length = 0;
	events.length = 0;

	await handleMessage(msg('haha iya bener juga'));
	await tick();
	const draftMsg = events.at(-1);
	const discardButton = draftMsg.extra.reply_markup.inline_keyboard[0][2];

	events.length = 0;
	await handleCallbackQuery({ id: 'cq3', data: discardButton.callback_data, message: { chat: { id: allowedChatId }, message_id: draftMsg.message_id } });
	await tick();

	assert.strictEqual(writtenNotes.length, 0);
	assert.match(events.at(-1).text, /Dibuang/);
});

test('pressing a save/discard button twice only acts once (pending entry consumed)', async () => {
	stubReply = { title: 'Sekali saja', tags: [], body: 'Test idempotency.', language: 'id', save_confidence: 0.2 };
	writtenNotes.length = 0;
	events.length = 0;

	await handleMessage(msg('coba lagi deh'));
	await tick();
	const draftMsg = events.at(-1);
	const saveButton = draftMsg.extra.reply_markup.inline_keyboard[0][0];

	await handleCallbackQuery({ id: 'cq4a', data: saveButton.callback_data, message: { chat: { id: allowedChatId }, message_id: draftMsg.message_id } });
	await tick();
	assert.strictEqual(writtenNotes.length, 1);

	events.length = 0;
	await handleCallbackQuery({ id: 'cq4b', data: saveButton.callback_data, message: { chat: { id: allowedChatId }, message_id: draftMsg.message_id } });
	await tick();

	assert.strictEqual(writtenNotes.length, 1, 'a second press on the same (now-consumed) button must not save again');
	assert.strictEqual(events.length, 0, 'an expired/consumed button should not trigger any message edit');
});
