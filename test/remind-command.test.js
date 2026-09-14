const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// docs/V2-SPEC.md §4: /remind <text> -> reminder-parse -> stored reminder;
// /remind list · done <n> · del <n> · check; [✅ Selesai] button.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-bridge-remind-'));
process.env.STATE_DIR = path.join(tmpRoot, '.state');

const telegram = require('../lib/telegram');
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
telegram.answerCallbackQuery = async () => {};

const models = require('../lib/models');
for (const key of Object.keys(models.MODELS)) {
	models.MODELS[key].chat = async () => JSON.stringify({ title: 'Bayar listrik', rule: 'monthly{20}', leadDays: 3 });
}

const tasks = require('../lib/google/tasks');
tasks.ensureTaskList = async () => 'list-1';
tasks.createTask = async ({ title, due, notes }) => ({ id: `task-${title}-${due}`, listId: 'list-1' });
tasks.isTaskCompleted = async () => false;
tasks.completeTask = async () => {};

const { allowedChatId } = require('../lib/config');
const state = require('../lib/state');
const { handleMessage, handleCallbackQuery } = require('../bridge');

test.after(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	delete process.env.STATE_DIR;
});

const msg = (text) => ({ chat: { id: allowedChatId }, text });
const tick = () => new Promise((r) => setTimeout(r, 80));

function resetReminders() {
	state.writeJson('reminders.json', []);
}

test('/remind <text> adds a reminder parsed via reminder-parse, with its next due date shown', async () => {
	resetReminders();
	events.length = 0;

	await handleMessage(msg('/remind bayar listrik setiap tanggal 20, ingatkan 3 hari sebelumnya'));
	await tick();

	const last = events.at(-1);
	assert.match(last.text, /Bayar listrik/);
	assert.match(last.text, /setiap tanggal 20/);
	assert.match(last.text, /H-3/);
	const list = state.readJson('reminders.json', []);
	assert.strictEqual(list.length, 1);
	assert.strictEqual(list[0].rule, 'monthly{20}');
	assert.strictEqual(list[0].active, true);
});

test('/remind list shows added reminders, numbered soonest-due first', async () => {
	resetReminders();
	events.length = 0;
	state.writeJson('reminders.json', [
		{ id: 1, title: 'Bayar pajak', notes: '', rule: 'yearly{3,31}', leadDays: 7, nextDue: '2027-03-31', lastTaskId: null, lastTaskFor: null, active: true },
		{ id: 2, title: 'Bayar listrik', notes: '', rule: 'monthly{20}', leadDays: 3, nextDue: '2026-09-20', lastTaskId: null, lastTaskFor: null, active: true },
	]);

	await handleMessage(msg('/remind list'));
	await tick();

	const last = events.at(-1);
	const idxListrik = last.text.indexOf('Bayar listrik');
	const idxPajak = last.text.indexOf('Bayar pajak');
	assert.ok(idxListrik !== -1 && idxPajak !== -1 && idxListrik < idxPajak, 'soonest due date (listrik) must be listed first');
	assert.match(last.text, /1\. Bayar listrik/);
	assert.match(last.text, /2\. Bayar pajak/);
});

test('/remind done <n> rolls the numbered reminder forward and completes its task', async () => {
	resetReminders();
	events.length = 0;
	let completedId;
	tasks.completeTask = async (listId, taskId) => {
		completedId = taskId;
	};
	state.writeJson('reminders.json', [
		{ id: 9, title: 'Bayar listrik', notes: '', rule: 'monthly{20}', leadDays: 3, nextDue: '2026-09-20', lastTaskId: 'task-9', lastTaskFor: '2026-09-20', active: true },
	]);

	await handleMessage(msg('/remind done 1'));
	await tick();

	assert.strictEqual(completedId, 'task-9');
	assert.match(events.at(-1).text, /✅ Bayar listrik/);
	assert.match(events.at(-1).text, /2026-10-20/);
	const [updated] = state.readJson('reminders.json', []);
	assert.strictEqual(updated.nextDue, '2026-10-20');
	assert.strictEqual(updated.lastTaskId, null);
});

test('/remind del <n> removes the numbered reminder outright', async () => {
	resetReminders();
	events.length = 0;
	state.writeJson('reminders.json', [
		{ id: 4, title: 'Something', notes: '', rule: 'monthly{1}', leadDays: 30, nextDue: '2026-09-01', lastTaskId: null, lastTaskFor: null, active: true },
	]);

	await handleMessage(msg('/remind del 1'));
	await tick();

	assert.match(events.at(-1).text, /🗑 Dihapus: Something/);
	assert.strictEqual(state.readJson('reminders.json', []).length, 0);
});

test('/remind done <n> with no such number shows a friendly error instead of throwing', async () => {
	resetReminders();
	events.length = 0;
	state.writeJson('reminders.json', []);

	await handleMessage(msg('/remind done 1'));
	await tick();

	assert.match(events.at(-1).text, /Nomor itu tidak ada/);
});

test('/remind check runs the tick immediately and reports how many nudges it sent', async (t) => {
	resetReminders();
	events.length = 0;
	t.mock.method(tasks, 'createTask', async ({ title, due }) => ({ id: `task-${title}`, listId: 'list-1' }));
	state.writeJson('reminders.json', [
		{ id: 1, title: 'Bayar listrik', notes: '', rule: 'monthly{20}', leadDays: 3, nextDue: '2026-09-20', lastTaskId: null, lastTaskFor: null, active: true },
	]);

	const realNow = Date.now;
	Date.now = () => Date.UTC(2026, 8, 19, 3, 0, 0) - 7 * 3600 * 1000; // within the lead window
	try {
		await handleMessage(msg('/remind check'));
		await tick();
	} finally {
		Date.now = realNow;
	}

	// The progress placeholder gets edited to the final summary; the nudge
	// itself is a separate sent message with a ✅ Selesai button.
	const nudgeEvent = events.find((e) => e.text && e.text.includes('Bayar listrik') && e.extra && e.extra.reply_markup);
	assert.ok(nudgeEvent, 'a nudge card with a button should have been sent');
	assert.strictEqual(nudgeEvent.extra.reply_markup.inline_keyboard[0][0].text, '✅ Selesai');
	const summary = events.at(-1);
	assert.match(summary.text, /1 pengingat dikirim/);
});

test('[✅ Selesai] on a nudge card rolls the reminder forward and completes its task', async () => {
	resetReminders();
	events.length = 0;
	let completedId;
	tasks.completeTask = async (listId, taskId) => {
		completedId = taskId;
	};
	state.writeJson('reminders.json', [
		{ id: 3, title: 'Bayar internet', notes: '', rule: 'monthly{10}', leadDays: 2, nextDue: '2026-09-10', lastTaskId: 'task-3', lastTaskFor: '2026-09-10', active: true },
	]);

	// Simulate a nudge already having been sent (as the tick would do): a
	// pending entry pointing at reminder #3.
	const pending = require('../lib/pending');
	const pendingId = pending.create('reminder', { reminderId: 3 });
	const nudgeMsgId = 555;

	await handleCallbackQuery({ id: 'cq1', data: `reminddone:${pendingId}`, message: { chat: { id: allowedChatId }, message_id: nudgeMsgId } });
	await tick();

	assert.strictEqual(completedId, 'task-3');
	const edited = events.find((e) => e.type === 'edit' && e.message_id === nudgeMsgId);
	assert.ok(edited);
	assert.match(edited.text, /✅ Selesai/);
	const [updated] = state.readJson('reminders.json', []);
	assert.strictEqual(updated.nextDue, '2026-10-10');
});
