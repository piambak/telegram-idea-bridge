const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-bridge-reminders-'));
process.env.STATE_DIR = path.join(tmpRoot, '.state');

const reminders = require('../lib/reminders');
const tasks = require('../lib/google/tasks');

test.after(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	delete process.env.STATE_DIR;
});

// --- date maths ----------------------------------------------------------

test('nextOccurrence: monthly{31} clamps to the last day of February (non-leap and leap)', () => {
	assert.strictEqual(reminders.nextOccurrence('monthly{31}', '2027-02-01'), '2027-02-28', '2027 is not a leap year');
	assert.strictEqual(reminders.nextOccurrence('monthly{31}', '2028-02-01'), '2028-02-29', '2028 is a leap year');
});

test('nextOccurrence: monthly{31} in March is the real 31st, not still clamped from February', () => {
	assert.strictEqual(reminders.nextOccurrence('monthly{31}', '2027-03-01'), '2027-03-31');
});

test('nextOccurrence: monthly{20} on/after the 20th itself is this month; after it, rolls to next month', () => {
	assert.strictEqual(reminders.nextOccurrence('monthly{20}', '2026-09-20'), '2026-09-20');
	assert.strictEqual(reminders.nextOccurrence('monthly{20}', '2026-09-21'), '2026-10-20');
	assert.strictEqual(reminders.nextOccurrence('monthly{20}', '2026-12-25'), '2027-01-20', 'wraps the year boundary');
});

test('nextOccurrence: weekly{5} (Friday) finds the next Friday on/after the given date', () => {
	assert.strictEqual(reminders.nextOccurrence('weekly{5}', '2026-09-14'), '2026-09-18', '2026-09-14 is a Monday');
	assert.strictEqual(reminders.nextOccurrence('weekly{5}', '2026-09-18'), '2026-09-18', 'a Friday itself counts');
});

test('nextOccurrence: yearly{12,25} finds this year\'s Dec 25 or next year\'s', () => {
	assert.strictEqual(reminders.nextOccurrence('yearly{12,25}', '2026-06-01'), '2026-12-25');
	assert.strictEqual(reminders.nextOccurrence('yearly{12,25}', '2026-12-26'), '2027-12-25');
});

test('nextOccurrence: once{date} is itself if not yet passed, null once it has', () => {
	assert.strictEqual(reminders.nextOccurrence('once{2026-10-01}', '2026-09-01'), '2026-10-01');
	assert.strictEqual(reminders.nextOccurrence('once{2026-10-01}', '2026-10-01', { strictlyAfter: true }), null);
});

test('nextOccurrence: rejects a malformed rule instead of silently guessing', () => {
	assert.throws(() => reminders.nextOccurrence('monthly{}', '2026-09-01'), /Invalid reminder rule/);
	assert.throws(() => reminders.nextOccurrence('daily', '2026-09-01'), /Invalid reminder rule/);
});

test('daysBetween: whole-day difference, sign indicates direction', () => {
	assert.strictEqual(reminders.daysBetween('2026-09-14', '2026-09-17'), 3);
	assert.strictEqual(reminders.daysBetween('2026-09-17', '2026-09-14'), -3);
	assert.strictEqual(reminders.daysBetween('2026-09-14', '2026-09-14'), 0);
});

// --- tick lifecycle --------------------------------------------------------

// Seeds .state/reminders.json directly — the same file lib/reminders.js
// itself reads/writes — so a test can start from an exact known state
// instead of going through addReminder()'s model call.
function seed(reminder) {
	const state = require('../lib/state');
	const all = state.readJson('reminders.json', []);
	all.push(reminder);
	state.writeJson('reminders.json', all);
}

function resetState() {
	const state = require('../lib/state');
	state.writeJson('reminders.json', []);
}

test('tick: outside the lead window, no task is created and no nudge is sent', async (t) => {
	resetState();
	t.mock.method(tasks, 'createTask', async () => {
		throw new Error('must not create a task outside the lead window');
	});
	seed({ id: 1, title: 'Bayar listrik', notes: '', rule: 'monthly{20}', leadDays: 3, nextDue: '2026-09-25', lastTaskId: null, lastTaskFor: null, active: true });

	const realNow = Date.now;
	Date.now = () => Date.UTC(2026, 8, 14, 3, 0, 0) - 7 * 3600 * 1000; // 2026-09-14 WIB
	try {
		const nudges = await reminders.tick();
		assert.strictEqual(nudges.length, 0);
	} finally {
		Date.now = realNow;
	}
});

test('tick: inside the lead window, creates a task and nudges exactly once for that cycle', async (t) => {
	resetState();
	let createCalls = 0;
	t.mock.method(tasks, 'createTask', async ({ title, due }) => {
		createCalls++;
		assert.strictEqual(title, 'Bayar listrik');
		assert.strictEqual(due, '2026-09-20');
		return { id: 'task-1', listId: 'list-1' };
	});
	t.mock.method(tasks, 'ensureTaskList', async () => 'list-1');
	t.mock.method(tasks, 'isTaskCompleted', async () => false);
	seed({ id: 1, title: 'Bayar listrik', notes: '', rule: 'monthly{20}', leadDays: 3, nextDue: '2026-09-20', lastTaskId: null, lastTaskFor: null, active: true });

	const realNow = Date.now;
	Date.now = () => Date.UTC(2026, 8, 18, 3, 0, 0) - 7 * 3600 * 1000; // 2026-09-18 WIB, 2 days before due
	try {
		const nudges = await reminders.tick();
		assert.strictEqual(createCalls, 1);
		assert.strictEqual(nudges.length, 1);
		assert.strictEqual(nudges[0].reminder.id, 1);
		assert.strictEqual(nudges[0].dueOrOverdue, false);
	} finally {
		Date.now = realNow;
	}
});

test('tick: no double task in one cycle — a second tick the same day (or any day before rollover) does not create another task', async (t) => {
	resetState();
	let createCalls = 0;
	t.mock.method(tasks, 'createTask', async () => {
		createCalls++;
		return { id: 'task-1', listId: 'list-1' };
	});
	t.mock.method(tasks, 'ensureTaskList', async () => 'list-1');
	t.mock.method(tasks, 'isTaskCompleted', async () => false);
	seed({ id: 1, title: 'Bayar listrik', notes: '', rule: 'monthly{20}', leadDays: 3, nextDue: '2026-09-20', lastTaskId: null, lastTaskFor: null, active: true });

	const realNow = Date.now;
	Date.now = () => Date.UTC(2026, 8, 19, 3, 0, 0) - 7 * 3600 * 1000; // 2026-09-19 WIB
	try {
		await reminders.tick();
		await reminders.tick();
		assert.strictEqual(createCalls, 1, 'the second tick must see lastTaskFor already matching nextDue');
	} finally {
		Date.now = realNow;
	}
});

test('tick: due-day and overdue nudges repeat daily without creating a new task', async (t) => {
	resetState();
	let createCalls = 0;
	t.mock.method(tasks, 'createTask', async () => {
		createCalls++;
		return { id: 'task-1', listId: 'list-1' };
	});
	t.mock.method(tasks, 'ensureTaskList', async () => 'list-1');
	t.mock.method(tasks, 'isTaskCompleted', async () => false);
	seed({ id: 1, title: 'Bayar listrik', notes: '', rule: 'monthly{20}', leadDays: 3, nextDue: '2026-09-20', lastTaskId: null, lastTaskFor: null, active: true });

	const realNow = Date.now;
	try {
		Date.now = () => Date.UTC(2026, 8, 18, 3, 0, 0) - 7 * 3600 * 1000; // lead window: creates + nudges
		const first = await reminders.tick();
		assert.strictEqual(first.length, 1);

		Date.now = () => Date.UTC(2026, 8, 19, 3, 0, 0) - 7 * 3600 * 1000; // still before due, no repeat
		const middle = await reminders.tick();
		assert.strictEqual(middle.length, 0, 'a lead-window nudge does not repeat before the due date');

		Date.now = () => Date.UTC(2026, 8, 20, 3, 0, 0) - 7 * 3600 * 1000; // due day: nudges again
		const dueDay = await reminders.tick();
		assert.strictEqual(dueDay.length, 1);
		assert.strictEqual(dueDay[0].dueOrOverdue, true);

		Date.now = () => Date.UTC(2026, 8, 23, 3, 0, 0) - 7 * 3600 * 1000; // overdue: still nudges
		const overdue = await reminders.tick();
		assert.strictEqual(overdue.length, 1);
		assert.strictEqual(overdue[0].dueOrOverdue, true);

		assert.strictEqual(createCalls, 1, 'only the first tick in the cycle ever creates a task');
	} finally {
		Date.now = realNow;
	}
});

test('tick: external completion (phone) is detected and rolls nextDue forward, resetting task bookkeeping', async (t) => {
	resetState();
	t.mock.method(tasks, 'ensureTaskList', async () => 'list-1');
	t.mock.method(tasks, 'isTaskCompleted', async (listId, taskId) => {
		assert.strictEqual(listId, 'list-1');
		assert.strictEqual(taskId, 'task-1');
		return true;
	});
	t.mock.method(tasks, 'createTask', async () => {
		throw new Error('must not create a new task on the same tick that detects completion');
	});
	seed({ id: 1, title: 'Bayar listrik', notes: '', rule: 'monthly{20}', leadDays: 3, nextDue: '2026-09-20', lastTaskId: 'task-1', lastTaskFor: '2026-09-20', active: true });

	const realNow = Date.now;
	Date.now = () => Date.UTC(2026, 8, 20, 3, 0, 0) - 7 * 3600 * 1000; // due day
	try {
		const nudges = await reminders.tick();
		assert.strictEqual(nudges.length, 0, 'a just-rolled-forward reminder gets no nudge this run');
		const [updated] = reminders.listReminders();
		assert.strictEqual(updated.nextDue, '2026-10-20');
		assert.strictEqual(updated.lastTaskId, null);
		assert.strictEqual(updated.lastTaskFor, null);
	} finally {
		Date.now = realNow;
	}
});

test('markDone: rolls a "once" reminder to inactive (nothing left to schedule) and completes its task', async (t) => {
	resetState();
	let completedTaskId;
	t.mock.method(tasks, 'ensureTaskList', async () => 'list-1');
	t.mock.method(tasks, 'completeTask', async (listId, taskId) => {
		completedTaskId = taskId;
	});
	seed({ id: 5, title: 'Bayar pajak', notes: '', rule: 'once{2026-10-01}', leadDays: 0, nextDue: '2026-10-01', lastTaskId: 'task-9', lastTaskFor: '2026-10-01', active: true });

	await reminders.markDone(5);
	assert.strictEqual(completedTaskId, 'task-9');
	assert.strictEqual(reminders.listReminders().length, 0, 'a completed one-off reminder is no longer active/listed');
});

test('markDone: rolls a monthly reminder forward to its next cycle', async (t) => {
	resetState();
	t.mock.method(tasks, 'ensureTaskList', async () => 'list-1');
	t.mock.method(tasks, 'completeTask', async () => {});
	seed({ id: 7, title: 'Bayar listrik', notes: '', rule: 'monthly{20}', leadDays: 3, nextDue: '2026-09-20', lastTaskId: 'task-1', lastTaskFor: '2026-09-20', active: true });

	const updated = await reminders.markDone(7);
	assert.strictEqual(updated.nextDue, '2026-10-20');
	assert.strictEqual(updated.active, true);
	assert.strictEqual(updated.lastTaskId, null);
});

// --- addReminder (reminder-parse) -----------------------------------------

test('addReminder: parses via reminder-parse and computes the first nextDue from today', async () => {
	resetState();
	const chat = async () => JSON.stringify({ title: 'Bayar listrik', rule: 'monthly{20}', leadDays: 3 });

	const realNow = Date.now;
	Date.now = () => Date.UTC(2026, 8, 14, 3, 0, 0) - 7 * 3600 * 1000; // 2026-09-14 WIB
	try {
		const r = await reminders.addReminder('bayar listrik setiap tanggal 20, ingatkan 3 hari sebelumnya', chat);
		assert.strictEqual(r.title, 'Bayar listrik');
		assert.strictEqual(r.rule, 'monthly{20}');
		assert.strictEqual(r.leadDays, 3);
		assert.strictEqual(r.nextDue, '2026-09-20');
		assert.strictEqual(r.active, true);
		assert.strictEqual(r.lastTaskId, null);
	} finally {
		Date.now = realNow;
	}
	assert.strictEqual(reminders.listReminders().length, 1);
});

test('addReminder: rejects a malformed rule from the model instead of storing a broken reminder', async () => {
	resetState();
	const chat = async () => JSON.stringify({ title: 'x', rule: 'not-a-rule', leadDays: 0 });
	await assert.rejects(() => reminders.addReminder('x', chat), /Invalid reminder rule/);
	assert.strictEqual(reminders.listReminders().length, 0);
});

// --- scheduling ------------------------------------------------------------

test('msUntilNextWibTime: mirrors msUntilNext1stWibHour\'s daily-rollover shape at minute granularity', () => {
	const nowWib = Date.UTC(2026, 8, 14, 7, 0, 0); // 2026-09-14 07:00 WIB, before 07:15
	const nowUtc = nowWib - 7 * 3600 * 1000;
	const targetWib = Date.UTC(2026, 8, 14, 7, 15, 0);

	const realNow = Date.now;
	Date.now = () => nowUtc;
	try {
		assert.strictEqual(reminders.msUntilNextWibTime(7, 15), targetWib - nowWib);
	} finally {
		Date.now = realNow;
	}
});

test('removeReminder: deletes it outright; a re-tick never sees it again', async (t) => {
	resetState();
	t.mock.method(tasks, 'createTask', async () => {
		throw new Error('a deleted reminder must never create a task');
	});
	seed({ id: 3, title: 'Something', notes: '', rule: 'monthly{1}', leadDays: 30, nextDue: '2026-09-01', lastTaskId: null, lastTaskFor: null, active: true });

	reminders.removeReminder(3);
	assert.strictEqual(reminders.listReminders().length, 0);
	await assert.rejects(() => reminders.markDone(3), /No active reminder #3/);
});
