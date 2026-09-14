const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// docs/V2-SPEC.md §1: "?" prefix and /ask answer only, never save, and
// carry the last 3 turns of conversation per chat.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-bridge-ask-'));
process.env.STATE_DIR = path.join(tmpRoot, '.state');

const telegram = require('../lib/telegram');
const events = [];
let nextMessageId = 1;
telegram.sendMessage = async (chatId, text, extra) => {
	const message_id = nextMessageId++;
	events.push({ text, extra, message_id });
	return { message_id };
};
telegram.editMessageText = async (chatId, messageId, text) => {
	events.push({ text, message_id: messageId });
	return { message_id: messageId };
};
telegram.sendChatAction = async () => {};
telegram.setMyCommands = async () => {};

// Records exactly what conversation history each call receives, so the
// "last 3 turns" claim is checked against the real messages array, not
// just the final answer text.
const seenCallMessages = [];
const models = require('../lib/models');
let replyCounter = 0;
const modelChat = async (messages) => {
	seenCallMessages.push(messages);
	replyCounter++;
	return `answer #${replyCounter}`;
};
for (const key of Object.keys(models.MODELS)) models.MODELS[key].chat = modelChat;

// knowledge.writeIdeaNote must NEVER be called from an ask-mode exchange —
// that's the whole point of "never saves".
const knowledge = require('../lib/knowledge');
let writeIdeaNoteCalls = 0;
knowledge.writeIdeaNote = () => {
	writeIdeaNoteCalls++;
	return 'notes/should-not-happen.md';
};

const { allowedChatId } = require('../lib/config');
const { handleMessage } = require('../bridge');

test.after(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	delete process.env.STATE_DIR;
});

const msg = (text) => ({ chat: { id: allowedChatId }, text });
const tick = () => new Promise((r) => setTimeout(r, 80));

test('a "?"-prefixed message answers without saving anything to the vault', async () => {
	events.length = 0;
	writeIdeaNoteCalls = 0;
	await handleMessage(msg('?apa itu PPN?'));
	await tick();

	assert.strictEqual(events.at(-1).text, 'answer #1');
	assert.strictEqual(writeIdeaNoteCalls, 0, 'ask mode must never call writeIdeaNote');
	// the "?" itself must not leak into the question sent to the model
	const lastCallUserMsg = seenCallMessages.at(-1).at(-1);
	assert.strictEqual(lastCallUserMsg.content, 'apa itu PPN?');
});

test('/ask answers without saving, same as the "?" prefix', async () => {
	events.length = 0;
	writeIdeaNoteCalls = 0;
	await handleMessage(msg('/ask apa itu PPh 21?'));
	await tick();

	assert.match(events.at(-1).text, /^answer #\d+$/);
	assert.strictEqual(writeIdeaNoteCalls, 0);
});

test('bare /ask (tapped from the menu) asks via force_reply instead of calling the model — same convention as every other command', async () => {
	seenCallMessages.length = 0;
	events.length = 0;
	await handleMessage(msg('/ask'));
	await tick();
	assert.ok(events.at(-1).extra.reply_markup.force_reply);
	assert.strictEqual(seenCallMessages.length, 0);
});

test('ask mode carries the last 3 turns (6 messages) of prior ask exchanges into the next call', async () => {
	seenCallMessages.length = 0;
	// A fresh chat id so this test's history starts empty regardless of
	// earlier tests in this file.
	const chatId = allowedChatId; // single-chat bot; reuse but track from here
	const before = seenCallMessages.length;

	await handleMessage(msg('?turn A'));
	await tick();
	await handleMessage(msg('?turn B'));
	await tick();
	await handleMessage(msg('?turn C'));
	await tick();
	await handleMessage(msg('?turn D'));
	await tick();

	const lastCallMessages = seenCallMessages.at(-1);
	// [system, ...history(<=6), user]
	const history = lastCallMessages.slice(1, -1);
	assert.ok(history.length <= 6, 'history must be capped at the last 3 turns (6 messages)');
	// "turn A" (the oldest) must have fallen out of a 3-turn window by the
	// 4th exchange.
	assert.ok(!history.some((m) => m.content === 'turn A'), 'older than 3 turns back must be dropped');
	assert.ok(history.some((m) => m.content === 'turn C'), 'the most recent prior turns must still be present');
	assert.strictEqual(lastCallMessages.at(-1).content, 'turn D');
});

test('a plain (non-ask, non-"?") message is unaffected by ask history — still routes as an idea/command normally', async () => {
	// Sanity: '?' is a prefix check, not a mode switch — a later plain
	// message must not be misrouted as an ask.
	events.length = 0;
	writeIdeaNoteCalls = 0;
	await handleMessage(msg('/models'));
	await tick();
	assert.match(events.at(-1).text, /groq/);
});
