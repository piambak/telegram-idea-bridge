const { test } = require('node:test');
const assert = require('node:assert');

const schedule = require('../lib/schedule');

test('parseEvent injects today\'s WIB weekday into the prompt given to the model', async () => {
	let seenPrompt;
	const chat = async (messages) => {
		seenPrompt = messages[0].content;
		return JSON.stringify({ title: 'Rapat', start: '2026-09-18T10:00', end: '2026-09-18T11:00', location: '', description: '', confidence: 0.9 });
	};

	await schedule.parseEvent('rapat Jumat depan', chat);

	// The exact "<weekday>, <date> WIB" string schedule.js computes for right
	// now — not just any weekday name, since the skill's own static example
	// text ("Senin, 2026-09-14 09:30 WIB") would otherwise make this pass
	// even if {{extra}} substitution were broken.
	const now = schedule.nowInWib();
	const expected = `${schedule.weekdayWib(now)}, ${schedule.formatWib(now)}`;
	assert.ok(
		seenPrompt.includes(expected),
		`the system prompt should contain "${expected}" (docs/ANALYSIS.md bug #15)\ngot:\n${seenPrompt}`,
	);
});

test('parseEvent keeps a confidence the model provides', async () => {
	const chat = async () =>
		JSON.stringify({ title: 'Rapat', start: '2026-09-18T10:00', end: '2026-09-18T11:00', location: '', description: '', confidence: 0.42 });
	const event = await schedule.parseEvent('rapat entah kapan', chat);
	assert.strictEqual(event.confidence, 0.42);
});

test('parseEvent defaults a missing confidence to 1 (confident), never forcing an unwanted confirm', async () => {
	const chat = async () => JSON.stringify({ title: 'Rapat', start: '2026-09-18T10:00', end: '2026-09-18T11:00', location: '', description: '' });
	const event = await schedule.parseEvent('rapat besok', chat);
	assert.strictEqual(event.confidence, 1);
});

// --- bridge.js wiring: low confidence must hold off the Radicale push ---

const telegram = require('../lib/telegram');
const sentDocs = [];
const sentMsgs = [];
telegram.sendMessage = async (chatId, text) => {
	sentMsgs.push(text);
};
telegram.sendDocument = async (chatId, buffer, filename, caption) => {
	sentDocs.push({ caption });
};
telegram.sendChatAction = async () => {};
telegram.setMyCommands = async () => {};

const models = require('../lib/models');
for (const key of Object.keys(models.MODELS)) models.MODELS[key].chat = async () => 'stub';

const radicale = require('../lib/radicale');
const pushCalls = [];
radicale.pushEvent = async (uid, ics) => {
	pushCalls.push({ uid, ics });
};

const scheduleModule = require('../lib/schedule');

const { allowedChatId } = require('../lib/config');
const { handleMessage } = require('../bridge');

const msg = (text) => ({ chat: { id: allowedChatId }, text });
const tick = () => new Promise((r) => setTimeout(r, 60));

// t.mock.method scopes the parseEvent stub to just this test (auto-restored
// after), so it never leaks into the pure-unit tests above that exercise
// the real parseEvent.
test('a low-confidence event is NOT pushed to Radicale automatically, and offers /confirm', async (t) => {
	pushCalls.length = 0;
	sentDocs.length = 0;
	t.mock.method(scheduleModule, 'parseEvent', async () => ({
		title: 'Rapat entah',
		start: '2026-09-18T10:00',
		end: '2026-09-18T11:00',
		location: '',
		description: '',
		confidence: 0.3,
	}));

	await handleMessage(msg('/schedule rapat entah kapan'));
	await tick();

	assert.strictEqual(pushCalls.length, 0, 'a low-confidence event must not reach Radicale automatically');
	assert.strictEqual(sentDocs.length, 1, 'the .ics file is still sent either way');
	assert.match(sentDocs[0].caption, /confirm/i);
});

test('/confirm pushes the pending low-confidence event to Radicale', async () => {
	// Depends on the previous test having set a pending event — node:test
	// runs top-level tests in one file sequentially by default.
	pushCalls.length = 0;
	sentMsgs.length = 0;

	await handleMessage(msg('/confirm'));
	await tick();

	assert.strictEqual(pushCalls.length, 1, '/confirm should push the event that was held back');
	assert.match(sentMsgs.at(-1), /Rapat entah/);
});

test('/confirm with nothing pending says so instead of erroring', async () => {
	sentMsgs.length = 0;
	await handleMessage(msg('/confirm')); // already confirmed above — nothing pending now
	await tick();
	assert.match(sentMsgs.at(-1), /No pending event/i);
});

test('a high-confidence event is pushed to Radicale automatically, no /confirm needed', async (t) => {
	pushCalls.length = 0;
	sentDocs.length = 0;
	t.mock.method(scheduleModule, 'parseEvent', async () => ({
		title: 'Rapat pasti',
		start: '2026-09-18T10:00',
		end: '2026-09-18T11:00',
		location: '',
		description: '',
		confidence: 0.95,
	}));

	await handleMessage(msg('/schedule rapat besok jam 10'));
	await tick();

	assert.strictEqual(pushCalls.length, 1);
	assert.match(sentDocs[0].caption, /Added to your calendar/);
});
