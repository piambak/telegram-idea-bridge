const { test } = require('node:test');
const assert = require('node:assert');

// sendMediaGroup requires 2-10 items and errors outside that range
// (docs/ANALYSIS.md bug #6) — /banner must route 1 result through
// sendPhoto and 0 through a plain message instead.
const telegram = require('../lib/telegram');
const calls = { sendMessage: [], sendPhoto: [], sendMediaGroup: [] };
telegram.sendMessage = async (chatId, text) => {
	calls.sendMessage.push(text);
};
telegram.sendChatAction = async () => {};
telegram.setMyCommands = async () => {};
telegram.sendPhoto = async (chatId, url, caption) => {
	calls.sendPhoto.push({ url, caption });
};
telegram.sendMediaGroup = async (chatId, items) => {
	calls.sendMediaGroup.push(items);
};

const models = require('../lib/models');
for (const key of Object.keys(models.MODELS)) models.MODELS[key].chat = async () => 'stub';

const images = require('../lib/images');
images.refineKeyword = async (keyword) => keyword;
let stubPhotos = [];
images.searchImages = async () => stubPhotos;

const { allowedChatId } = require('../lib/config');
const { handleMessage } = require('../bridge');

const msg = (text) => ({ chat: { id: allowedChatId }, text });
const tick = () => new Promise((r) => setTimeout(r, 60));
async function resetAndSend(text) {
	calls.sendMessage.length = 0;
	calls.sendPhoto.length = 0;
	calls.sendMediaGroup.length = 0;
	await handleMessage(msg(text));
	await tick();
}

test('0 results: a friendly message, no photo call at all', async () => {
	stubPhotos = [];
	await resetAndSend('/banner nonexistent thing');
	assert.strictEqual(calls.sendPhoto.length, 0);
	assert.strictEqual(calls.sendMediaGroup.length, 0);
	assert.strictEqual(calls.sendMessage.length, 1);
	assert.match(calls.sendMessage[0], /No images found/);
});

test('1 result: sendPhoto, never sendMediaGroup', async () => {
	stubPhotos = [{ imageUrl: 'https://example.com/one.jpg' }];
	await resetAndSend('/banner office party');
	assert.strictEqual(calls.sendMediaGroup.length, 0);
	assert.strictEqual(calls.sendPhoto.length, 1);
	assert.strictEqual(calls.sendPhoto[0].url, 'https://example.com/one.jpg');
});

test('6 results (the normal case): sendMediaGroup, never sendPhoto', async () => {
	stubPhotos = Array.from({ length: 6 }, (_, i) => ({ imageUrl: `https://example.com/${i}.jpg` }));
	await resetAndSend('/banner office party');
	assert.strictEqual(calls.sendPhoto.length, 0);
	assert.strictEqual(calls.sendMediaGroup.length, 1);
	assert.strictEqual(calls.sendMediaGroup[0].length, 6);
});

test('more than 10 results are capped at 10 for sendMediaGroup', async () => {
	stubPhotos = Array.from({ length: 15 }, (_, i) => ({ imageUrl: `https://example.com/${i}.jpg` }));
	await resetAndSend('/banner office party');
	assert.strictEqual(calls.sendMediaGroup[0].length, 10);
});
