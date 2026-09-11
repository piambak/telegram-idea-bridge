// Self-check: menu tap -> prompt -> next message runs the command with the arg.
const assert = require('assert');
const telegram = require('./lib/telegram');
const { allowedChatId } = require('./lib/config');

const sent = [];
telegram.sendMessage = async (chatId, text, extra) => { sent.push({ text, extra }); };
telegram.sendChatAction = async () => {};
telegram.setMyCommands = async () => {};

const broadcastCalls = [];
const models = require('./lib/models');
models.MODELS.__test = { chat: async (msgs) => { broadcastCalls.push(msgs.at(-1).content); return 'DRAFT'; } };
for (const k of Object.keys(models.MODELS)) if (k !== '__test') models.MODELS[k] = models.MODELS.__test;

const { handleMessage, pendingCommand } = require('./bridge');
const msg = (text) => ({ chat: { id: allowedChatId }, text });

(async () => {
	await handleMessage(msg('/broadcast'));
	assert.strictEqual(pendingCommand.get(allowedChatId), '/broadcast', 'bare command should be remembered');
	assert.ok(sent.at(-1).extra.reply_markup.force_reply, 'should ask with force_reply');

	await handleMessage(msg('libur nasional besok'));
	await new Promise((r) => setTimeout(r, 50));
	assert.strictEqual(broadcastCalls.at(-1), 'libur nasional besok', 'next message becomes the argument');
	assert.ok(!pendingCommand.has(allowedChatId), 'pending state cleared after use');

	// A new command cancels a pending prompt instead of being eaten as its arg.
	await handleMessage(msg('/news'));
	await handleMessage(msg('/models'));
	assert.ok(!pendingCommand.has(allowedChatId), 'new command cancels pending');

	// Inline form still works.
	broadcastCalls.length = 0;
	await handleMessage(msg('/broadcast rapat jam 3'));
	await new Promise((r) => setTimeout(r, 50));
	assert.strictEqual(broadcastCalls.at(-1), 'rapat jam 3', 'inline arg still works');

	console.log('all checks passed');
})();
