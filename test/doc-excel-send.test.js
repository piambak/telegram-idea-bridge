const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// docs/ANALYSIS.md bug #12: the generated .docx/.xlsx was only ever written
// to OneDrive, never sent back to Telegram even though sendDocument already
// existed. /doc and /excel must now send the file back too.
const telegram = require('../lib/telegram');
const sent = { messages: [], documents: [] };
let nextMessageId = 1;
telegram.sendMessage = async (chatId, text) => {
	sent.messages.push(text);
	return { message_id: nextMessageId++ };
};
telegram.editMessageText = async (chatId, messageId, text) => {
	sent.messages.push(text);
	return { message_id: messageId };
};
telegram.sendChatAction = async () => {};
telegram.setMyCommands = async () => {};
telegram.sendDocument = async (chatId, buffer, filename, caption) => {
	sent.documents.push({ buffer, filename, caption });
};

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-bridge-docsend-'));
const docgen = require('../lib/docgen');
docgen.generateWordDoc = async ({ brief }) => {
	const outputPath = path.join(tmpRoot, 'Memo.docx');
	fs.writeFileSync(outputPath, `fake docx content for: ${brief}`);
	return { outputPath, title: 'Memo', usedTemplate: false };
};
docgen.generateExcelDoc = async ({ brief }) => {
	const outputPath = path.join(tmpRoot, 'Table.xlsx');
	fs.writeFileSync(outputPath, `fake xlsx content for: ${brief}`);
	return { outputPath, title: 'Table', usedTemplate: false };
};

const { allowedChatId } = require('../lib/config');
const { handleMessage } = require('../bridge');

test.after(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const msg = (text) => ({ chat: { id: allowedChatId }, text });
const tick = () => new Promise((r) => setTimeout(r, 60));

test('/doc sends the generated .docx back via sendDocument', async () => {
	sent.documents.length = 0;
	await handleMessage(msg('/doc default | Memo reminder'));
	await tick();

	assert.strictEqual(sent.documents.length, 1);
	assert.strictEqual(sent.documents[0].filename, 'Memo.docx');
	assert.strictEqual(sent.documents[0].buffer.toString(), 'fake docx content for: Memo reminder');
	assert.match(sent.documents[0].caption, /Memo/);
});

test('/excel sends the generated .xlsx back via sendDocument', async () => {
	sent.documents.length = 0;
	await handleMessage(msg('/excel default | monthly totals'));
	await tick();

	assert.strictEqual(sent.documents.length, 1);
	assert.strictEqual(sent.documents[0].filename, 'Table.xlsx');
	assert.strictEqual(sent.documents[0].buffer.toString(), 'fake xlsx content for: monthly totals');
});
