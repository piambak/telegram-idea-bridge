const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// docs/V2-SPEC.md §9: /status renders lib/status.checkAll()'s results as a
// ✅/❌ list, with the reason shown for anything not reachable.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-bridge-status-'));
process.env.STATE_DIR = path.join(tmpRoot, '.state');

const telegram = require('../lib/telegram');
const events = [];
telegram.sendMessage = async (chatId, text, extra) => {
	events.push({ type: 'send', text, extra });
	return { message_id: events.length };
};
telegram.editMessageText = async (chatId, messageId, text, extra) => {
	events.push({ type: 'edit', text, extra });
	return { message_id: messageId };
};
telegram.sendChatAction = async () => {};
telegram.setMyCommands = async () => {};

const status = require('../lib/status');
const { allowedChatId } = require('../lib/config');
const { handleMessage } = require('../bridge');

test.after(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	delete process.env.STATE_DIR;
});

const msg = (text) => ({ chat: { id: allowedChatId }, text });
const tick = () => new Promise((r) => setTimeout(r, 80));

test('/status renders every service with ✅/❌ and the reason for anything unreachable', async (t) => {
	events.length = 0;
	t.mock.method(status, 'checkAll', async () => [
		{ name: 'Groq', ok: true, reason: null },
		{ name: 'Radicale', ok: false, reason: 'fetch failed: ECONNREFUSED' },
		{ name: 'Vault mirror', ok: false, reason: 'vault directory not found: C:\\Users\\x\\obsidian-vault' },
	]);

	await handleMessage(msg('/status'));
	await tick();

	const last = events.at(-1);
	assert.strictEqual(last.type, 'edit');
	assert.match(last.text, /✅ Groq/);
	assert.match(last.text, /❌ Radicale — fetch failed: ECONNREFUSED/);
	assert.match(last.text, /❌ Vault mirror/);
});

test('/status degrades to an error message instead of throwing if checkAll() itself rejects', async (t) => {
	events.length = 0;
	t.mock.method(status, 'checkAll', async () => {
		throw new Error('unexpected failure');
	});

	await handleMessage(msg('/status'));
	await tick();

	assert.match(events.at(-1).text, /Gagal mengecek status/);
});
