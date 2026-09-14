const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// /broadcast now offers [📤 Kirim] [🔁 Draft ulang] buttons instead of the
// old /send command (docs/V2-SPEC.md §1).
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-bridge-bcbtn-'));
process.env.STATE_DIR = path.join(tmpRoot, '.state');

const telegram = require('../lib/telegram');
const events = [];
let nextMessageId = 100;
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

const models = require('../lib/models');
let draftCount = 0;
for (const key of Object.keys(models.MODELS)) {
	models.MODELS[key].chat = async () => `Draft #${++draftCount} untuk acara kantor`;
}

const whatsapp = require('../lib/whatsapp');
const sentToGroup = [];
whatsapp.sendToGroup = async (message) => {
	sentToGroup.push(message);
	return { success: true };
};

const { allowedChatId } = require('../lib/config');
const { handleMessage, handleCallbackQuery } = require('../bridge');

test.after(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	delete process.env.STATE_DIR;
});

const tick = () => new Promise((r) => setTimeout(r, 80));

test('/broadcast drafts once and attaches [Kirim]/[Draft ulang] buttons, not a text instruction', async () => {
	events.length = 0;
	await handleMessage({ chat: { id: allowedChatId }, text: '/broadcast libur nasional besok' });
	await tick();

	const last = events.at(-1);
	assert.strictEqual(last.type, 'edit', 'the draft replaces the "Drafting..." placeholder in place');
	assert.ok(!last.text.includes('/send'), 'the old text-instruction UX ("use /send") must be gone');
	const buttons = last.extra.reply_markup.inline_keyboard[0];
	assert.strictEqual(buttons[0].text, '📤 Kirim');
	assert.strictEqual(buttons[1].text, '🔁 Draft ulang');
	assert.match(buttons[0].callback_data, /^bcsend:.+$/);
	assert.match(buttons[1].callback_data, /^bcredraft:.+$/);
});

test('[📤 Kirim] posts the exact held draft to WhatsApp and confirms in place', async () => {
	events.length = 0;
	await handleMessage({ chat: { id: allowedChatId }, text: '/broadcast pengumuman cuti bersama' });
	await tick();
	const draftMsg = events.at(-1);
	const draftText = draftMsg.text;
	const sendButton = draftMsg.extra.reply_markup.inline_keyboard[0][0];

	sentToGroup.length = 0;
	events.length = 0;
	await handleCallbackQuery({
		id: 'cq-send',
		data: sendButton.callback_data,
		message: { chat: { id: allowedChatId }, message_id: draftMsg.message_id },
	});
	await tick();

	assert.strictEqual(sentToGroup.length, 1);
	assert.strictEqual(sentToGroup[0], draftText, 'the exact drafted text should be what gets sent, unescaped-for-WhatsApp');
	const confirm = events.at(-1);
	assert.strictEqual(confirm.type, 'edit');
	assert.strictEqual(confirm.messageId, draftMsg.message_id, 'confirmation edits the SAME message, not a new one');
	assert.match(confirm.text, /Sent to the WhatsApp group/);
});

test('[🔁 Draft ulang] redrafts from the same brief and re-attaches fresh buttons', async () => {
	events.length = 0;
	await handleMessage({ chat: { id: allowedChatId }, text: '/broadcast rapat evaluasi kuartal' });
	await tick();
	const draftMsg = events.at(-1);
	const redraftButton = draftMsg.extra.reply_markup.inline_keyboard[0][1];

	events.length = 0;
	await handleCallbackQuery({
		id: 'cq-redraft',
		data: redraftButton.callback_data,
		message: { chat: { id: allowedChatId }, message_id: draftMsg.message_id },
	});
	await tick();

	const redrafted = events.at(-1);
	assert.strictEqual(redrafted.type, 'edit');
	assert.strictEqual(redrafted.messageId, draftMsg.message_id);
	assert.notStrictEqual(redrafted.text, draftMsg.text, 'a redraft should be a fresh model call, not the same cached text');
	const newButtons = redrafted.extra.reply_markup.inline_keyboard[0];
	assert.match(newButtons[0].callback_data, /^bcsend:.+$/);
	assert.notStrictEqual(newButtons[0].callback_data, draftMsg.extra.reply_markup.inline_keyboard[0][0].callback_data, 'a fresh pending id should back the redraft');
});

test('pressing a button twice (already-consumed / expired) answers gracefully instead of resending', async () => {
	events.length = 0;
	await handleMessage({ chat: { id: allowedChatId }, text: '/broadcast satu lagi' });
	await tick();
	const draftMsg = events.at(-1);
	const sendButton = draftMsg.extra.reply_markup.inline_keyboard[0][0];

	await handleCallbackQuery({ id: 'first', data: sendButton.callback_data, message: { chat: { id: allowedChatId }, message_id: draftMsg.message_id } });
	await tick();

	events.length = 0;
	sentToGroup.length = 0;
	await handleCallbackQuery({ id: 'second', data: sendButton.callback_data, message: { chat: { id: allowedChatId }, message_id: draftMsg.message_id } });
	await tick();

	assert.strictEqual(sentToGroup.length, 0, 'a consumed button must not send again');
	assert.strictEqual(events.length, 0, 'no message edit should happen for an already-expired pending id');
});
