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

const telegram = require('./lib/telegram');
const sent = [];
telegram.sendMessage = async (chatId, text, extra) => {
	sent.push({ chatId, text, extra });
};
telegram.sendChatAction = async () => {};
telegram.setMyCommands = async () => {};
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
const { handleMessage } = require('./bridge');

const msg = (text) => ({ chat: { id: allowedChatId }, text });
const tick = () => new Promise((r) => setTimeout(r, 80));
async function send(text) {
	sent.length = 0;
	await handleMessage(msg(text));
	await tick();
	return sent.at(-1);
}

(async () => {
	// /help — answered directly (not enqueued), no lib deps.
	let last = await send('/help');
	assert.ok(last.text.includes('/todo'), '/help should list the commands');

	// /models — enqueued; static registry, proves the enqueue path also works
	// with no lib stubs beyond telegram.
	last = await send('/models');
	assert.ok(last.text.includes('groq'), '/models should list the groq alias');
	assert.ok(last.text.includes('⭐'), '/models should mark the default with a star');

	// Plain text idea — exercises enhance -> knowledge.writeIdeaNote ->
	// vaultsync.sync -> sendMessage, and is the main HTML-escaping check:
	// the stubbed model returns raw HTML, which must not survive unescaped.
	last = await send('a great idea about a tax kiosk');
	assert.ok(!last.text.includes('<script>'), 'raw <script> from the model must be escaped');
	assert.ok(last.text.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'escaped script tag should be present');
	assert.ok(last.text.includes('Kios Pajak &amp; Digital'), 'the ampersand in the title should be escaped, not rendered');
	assert.strictEqual(writtenNotes.length, 1, 'the idea should be written to the vault exactly once');
	assert.strictEqual(syncCalls.length, 1, 'saving an idea should trigger exactly one vault sync');
	assert.ok(last.text.includes('notes/kios-pajak-digital.md'), 'reply should point at the saved file');

	// /todo add + /todo list — enqueued, exercises the todo lib stub and the
	// numbered-list rendering (which itself contains escaped user text).
	last = await send('/todo Beli <susu> & roti');
	assert.ok(last.text.includes('Beli &lt;susu&gt; &amp; roti'), '/todo add should echo back the escaped item');
	last = await send('/todo list');
	assert.ok(last.text.includes('1. Beli &lt;susu&gt; &amp; roti'), '/todo list should number the open item');

	// /calc — pure mathjs, no stubbing at all; proves real computation still
	// works end-to-end through the handler.
	last = await send('/calc 12*4');
	assert.ok(last.text.includes('<code>12*4</code>'), '/calc should echo the expression as <code>');
	assert.ok(last.text.includes('<b>48</b>'), '/calc should compute the real result');

	// /search — exercises the vault stub and escaping of search results.
	last = await send('/search kios');
	assert.ok(last.text.includes('Kios &lt;Pajak&gt; Digital'), '/search should escape the note title');
	assert.ok(last.text.includes('rencana &amp; anggaran'), '/search should escape the snippet');

	console.log('test-smoke.js: all assertions passed');
})().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
