// Smoke test: drives real bridge.js message handling end-to-end and checks
// the actual HTML Telegram would receive.
//
// Seam: bridge.js takes no test hooks and none are added to it. Instead we
// exploit Node's module cache — every lib/* module is a singleton object,
// so mutating its exported functions *before* bridge.js is first required
// replaces what bridge.js calls, because `require('./lib/x')` inside
// bridge.js returns the same cached object we just mutated. This is the
// existing convention in test-menu-args.js (see its telegram/model
// stubbing); it needs zero production-code changes and no env var/flag to
// keep in sync with bridge.js's own require list.
//
// Only lib modules whose real implementation would touch the network or the
// filesystem outside a tmp dir are stubbed. Pure logic (lib/calc.js via
// mathjs, the static /models and /help text) runs for real.
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// /todo list now creates button payloads via lib/pending.js — point
// .state/ at a tmp dir so that never touches the real repo.
const tmpStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-bridge-smoke-state-'));
process.env.STATE_DIR = tmpStateDir;

const telegram = require('./lib/telegram');
// One combined, chronological log of everything sent/edited — ui.progress
// posts a placeholder (sendMessage) then turns it into the result
// (editMessageText), so "the reply" for a progress-based handler is the
// LAST event, whichever kind it is.
const events = [];
let nextMessageId = 1;
telegram.sendMessage = async (chatId, text, extra) => {
	const message_id = nextMessageId++;
	events.push({ type: 'send', chatId, text, extra, message_id });
	return { message_id };
};
telegram.editMessageText = async (chatId, messageId, text, extra) => {
	events.push({ type: 'edit', chatId, text, extra, message_id: messageId });
	return { message_id: messageId };
};
telegram.sendChatAction = async () => {};
telegram.setMyCommands = async () => {};
telegram.setMyDescription = async () => {};
telegram.setMyShortDescription = async () => {};
telegram.answerCallbackQuery = async () => {};
telegram.sendDocument = async () => {
	throw new Error('sendDocument should not be called by this smoke test');
};
telegram.sendMediaGroup = async () => {
	throw new Error('sendMediaGroup should not be called by this smoke test');
};

// One deterministic "model" for every alias. The reply deliberately contains
// HTML-special characters so the assertions below prove bridge.js escapes
// model output before it reaches sendMessage — a raw '<script>' from a model
// must never survive into what gets sent.
const models = require('./lib/models');
const modelChat = async (messages) => {
	const userText = messages.at(-1).content;
	if (userText.includes('idea')) {
		return JSON.stringify({
			title: 'Kios Pajak & Digital',
			tags: ['pajak', 'digital'],
			body: 'An enhanced idea with a <script>alert(1)</script> tag inside it.',
			language: 'en',
			save_confidence: 0.9,
		});
	}
	return `stub reply for: ${userText}`;
};
for (const key of Object.keys(models.MODELS)) models.MODELS[key].chat = modelChat;

// knowledge/todo/vaultsync would otherwise write into the real OpenKnowledge
// vault and shell out to git — replace with in-memory fakes.
const knowledge = require('./lib/knowledge');
const writtenNotes = [];
knowledge.writeIdeaNote = ({ title, tags, rawIdea, enhancedBody }) => {
	writtenNotes.push({ title, tags, rawIdea, enhancedBody });
	return path.join('notes', `${knowledge.slugify(title)}.md`);
};

const todo = require('./lib/todo');
let todoItems = [];
todo.addItem = (text) => {
	todoItems.push({ text, done: false });
};
todo.listItems = () => todoItems.filter((i) => !i.done);
todo.markDoneMatching = (text) => {
	const item = todoItems.find((i) => !i.done && i.text === text);
	if (!item) throw new Error(`"${text}" is no longer on the list.`);
	item.done = true;
	return item.text;
};

const vaultsync = require('./lib/vaultsync');
const syncCalls = [];
vaultsync.sync = async (message) => {
	syncCalls.push(message);
};

const vault = require('./lib/vault');
vault.searchNotes = (query) => [
	{ path: 'notes/kios-pajak.md', title: 'Kios <Pajak> Digital', snippet: 'rencana & anggaran untuk kios' },
];

const { allowedChatId } = require('./lib/config');
const { handleMessage, handleCallbackQuery } = require('./bridge');

const msg = (text) => ({ chat: { id: allowedChatId }, text });
const tick = () => new Promise((r) => setTimeout(r, 80));
async function send(text) {
	events.length = 0;
	await handleMessage(msg(text));
	await tick();
	return events.at(-1);
}

(async () => {
	// /help — answered directly (not enqueued), no lib deps.
	let last = await send('/help');
	assert.ok(last.text.includes('/todo'), '/help should list the commands');

	// /start — the grouped card (docs/V2-SPEC.md §1): icon+title, sections
	// with bold labels and ▸ bullets, a footer.
	last = await send('/start');
	assert.ok(last.text.includes('👋 <b>Idea Bridge</b>'), '/start should show the icon+title card header');
	assert.ok(last.text.includes('▸ /list, /search, /get'), '/start should list bulleted commands under a section');
	assert.ok(last.text.includes('<i>/help untuk daftar lengkap perintah</i>'), '/start should have a muted footer');

	// /models — enqueued; static registry, proves the enqueue path also works
	// with no lib stubs beyond telegram.
	last = await send('/models');
	assert.ok(last.text.includes('groq'), '/models should list the groq alias');
	assert.ok(last.text.includes('⭐'), '/models should mark the default with a star');

	// Plain text idea — exercises idea-enhance -> knowledge.writeIdeaNote ->
	// vaultsync.sync -> ui.progress/ui.card, and is the main HTML-escaping
	// check: the stubbed model returns raw HTML, which must not survive
	// unescaped. ui.progress posts a placeholder then EDITS it into the
	// result, so this should be a single edit, not a second send.
	last = await send('a great idea about a tax kiosk');
	assert.strictEqual(last.type, 'edit', 'the idea card should replace the placeholder in place, not arrive as a new message');
	assert.ok(!last.text.includes('<script>'), 'raw <script> from the model must be escaped');
	assert.ok(last.text.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'escaped script tag should be present');
	assert.ok(last.text.includes('💡 <b>Kios Pajak &amp; Digital</b>'), 'card header: icon + escaped bold title');
	assert.ok(last.text.includes('<i>#pajak #digital</i>'), 'card subtitle: muted hashtags');
	assert.ok(last.text.includes('<blockquote>'), 'card body: blockquote');
	assert.ok(last.text.includes('<i>💾 notes/kios-pajak-digital.md</i>'), 'card footer: muted, points at the saved file');
	assert.strictEqual(writtenNotes.length, 1, 'the idea should be written to the vault exactly once');
	assert.strictEqual(syncCalls.length, 1, 'saving an idea should trigger exactly one vault sync');

	// /todo add + /todo list — /todo list now renders one ✅ button per item
	// (docs/V2-SPEC.md §1) instead of a numbered text list; the item text
	// lives in the (unescaped — button labels aren't HTML) button, not the
	// message body.
	last = await send('/todo Beli <susu> & roti');
	assert.ok(last.text.includes('Beli &lt;susu&gt; &amp; roti'), '/todo add should echo back the escaped item');
	last = await send('/todo list');
	assert.ok(last.text.includes('Open to-dos'), '/todo list header');
	const todoButton = last.extra.reply_markup.inline_keyboard[0][0];
	assert.strictEqual(todoButton.text, '✅ Beli <susu> & roti', 'button labels are plain text, never HTML-escaped');
	assert.match(todoButton.callback_data, /^tododone:.{6,}$/);
	assert.ok(Buffer.byteLength(todoButton.callback_data, 'utf8') <= 64, 'callback_data must fit Telegram\'s 64-byte cap');

	// Pressing that ✅ button marks the item done and refreshes the list in
	// place (same message id), proving the pending.json round-trip works.
	const cq = { id: 'cq1', data: todoButton.callback_data, message: { chat: { id: allowedChatId }, message_id: last.message_id } };
	events.length = 0;
	await handleCallbackQuery(cq);
	await tick();
	const afterButton = events.at(-1);
	assert.strictEqual(afterButton.type, 'edit');
	assert.strictEqual(afterButton.message_id, last.message_id, 'the done-button should edit the SAME message, not send a new one');
	assert.ok(afterButton.text.includes('✅ Beli &lt;susu&gt; &amp; roti'), 'the confirmation line is message text, so it IS escaped');
	assert.ok(afterButton.text.includes('No open to-dos'), 'the list should now be empty');

	// /calc — pure mathjs, no stubbing at all; proves real computation still
	// works end-to-end through the handler.
	last = await send('/calc 12*4');
	assert.ok(last.text.includes('<code>12*4</code>'), '/calc should echo the expression as <code>');
	assert.ok(last.text.includes('<b>48</b>'), '/calc should compute the real result');

	// /search — exercises the vault stub and escaping of search results.
	last = await send('/search kios');
	assert.ok(last.text.includes('Kios &lt;Pajak&gt; Digital'), '/search should escape the note title');
	assert.ok(last.text.includes('rencana &amp; anggaran'), '/search should escape the snippet');

	fs.rmSync(tmpStateDir, { recursive: true, force: true });
	console.log('test-smoke.js: all assertions passed');
})().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
