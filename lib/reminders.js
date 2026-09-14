const state = require('./state');
const skills = require('./skills');
const tasks = require('./google/tasks');

// docs/V2-SPEC.md §4: recurring reminders, ticked daily at 07:15 WIB.
// Every date in this module is a plain "YYYY-MM-DD" WIB-local calendar
// date, never a Date/time — lexicographic string comparison is
// chronological comparison for that format, so most of this file never
// touches a Date object except to do actual calendar arithmetic (adding a
// day, finding a weekday, clamping to a month's length).

const FILE = 'reminders.json';
const WIB_OFFSET_MS = 7 * 3600 * 1000;

function pad2(n) {
	return String(n).padStart(2, '0');
}

function ymd(y, m, d) {
	return `${y}-${pad2(m)}-${pad2(d)}`;
}

function parseYmd(dateStr) {
	const [y, m, d] = String(dateStr).split('-').map(Number);
	return { y, m, d };
}

// Last day of `month` (1-12) in `year` — the clamp target for monthly/
// yearly rules in short months (e.g. day 31 in February).
function daysInMonth(year, month) {
	return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// 1=Monday..7=Sunday, matching reminder-parse's weekday convention.
function isoWeekday(dateStr) {
	const { y, m, d } = parseYmd(dateStr);
	const jsDay = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sunday..6=Saturday
	return jsDay === 0 ? 7 : jsDay;
}

function addDays(dateStr, n) {
	const { y, m, d } = parseYmd(dateStr);
	const dt = new Date(Date.UTC(y, m - 1, d + n));
	return ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

// Whole days from `fromStr` to `toStr` (positive when `toStr` is later).
function daysBetween(fromStr, toStr) {
	const a = parseYmd(fromStr);
	const b = parseYmd(toStr);
	const msA = Date.UTC(a.y, a.m - 1, a.d);
	const msB = Date.UTC(b.y, b.m - 1, b.d);
	return Math.round((msB - msA) / 86_400_000);
}

function todayWib() {
	return new Date(Date.now() + WIB_OFFSET_MS).toISOString().slice(0, 10);
}

// "monthly{20}" / "weekly{5}" / "yearly{12,25}" / "once{2026-10-01}" -> a
// structured rule, or throws on anything else — reminder-parse is asked to
// produce exactly one of these forms, but a model can still get it wrong.
function parseRule(rule) {
	let m;
	if ((m = /^monthly\{(\d{1,2})\}$/.exec(rule))) return { type: 'monthly', day: Number(m[1]) };
	if ((m = /^weekly\{([1-7])\}$/.exec(rule))) return { type: 'weekly', weekday: Number(m[1]) };
	if ((m = /^yearly\{(\d{1,2}),(\d{1,2})\}$/.exec(rule))) return { type: 'yearly', month: Number(m[1]), day: Number(m[2]) };
	if ((m = /^once\{(\d{4}-\d{2}-\d{2})\}$/.exec(rule))) return { type: 'once', date: m[1] };
	throw new Error(`Invalid reminder rule: "${rule}"`);
}

// The next date matching `rule` on/after `fromStr` (or strictly after it,
// for rolling a just-completed cycle forward so it can't return the same
// date again). Returns null only for a "once" rule whose date has already
// passed the boundary — the reminder is then done for good.
function nextOccurrence(rule, fromStr, { strictlyAfter = false } = {}) {
	const parsed = parseRule(rule);
	const passes = (candidate) => (strictlyAfter ? candidate > fromStr : candidate >= fromStr);

	if (parsed.type === 'once') {
		return passes(parsed.date) ? parsed.date : null;
	}
	if (parsed.type === 'monthly') {
		let { y, m } = parseYmd(fromStr);
		for (let i = 0; i < 13; i++) {
			const candidate = ymd(y, m, Math.min(parsed.day, daysInMonth(y, m)));
			if (passes(candidate)) return candidate;
			m++;
			if (m > 12) {
				m = 1;
				y++;
			}
		}
	}
	if (parsed.type === 'yearly') {
		let { y } = parseYmd(fromStr);
		for (let i = 0; i < 2; i++) {
			const candidate = ymd(y, parsed.month, Math.min(parsed.day, daysInMonth(y, parsed.month)));
			if (passes(candidate)) return candidate;
			y++;
		}
	}
	if (parsed.type === 'weekly') {
		let candidate = fromStr;
		for (let i = 0; i < 8; i++) {
			if (isoWeekday(candidate) === parsed.weekday && passes(candidate)) return candidate;
			candidate = addDays(candidate, 1);
		}
	}
	throw new Error(`Could not compute the next occurrence of rule "${rule}" from ${fromStr}`);
}

// ---- Storage --------------------------------------------------------

function loadAll() {
	return state.readJson(FILE, []);
}

function saveAll(list) {
	state.writeJson(FILE, list);
}

function nextId(list) {
	return list.length ? Math.max(...list.map((r) => r.id)) + 1 : 1;
}

// Active reminders, soonest-due first — the fixed order /remind list, done
// <n>, and del <n> all resolve their position numbers against.
function listReminders() {
	return loadAll()
		.filter((r) => r.active)
		.sort((a, b) => (a.nextDue < b.nextDue ? -1 : a.nextDue > b.nextDue ? 1 : a.id - b.id));
}

function findActive(list, id) {
	const r = list.find((x) => x.active && x.id === id);
	if (!r) throw new Error(`No active reminder #${id}`);
	return r;
}

// "bayar listrik setiap tanggal 20, ingatkan 3 hari sebelumnya" ->
// reminder-parse -> a stored reminder with its first nextDue computed from
// today (docs/V2-SPEC.md §4).
async function addReminder(text, chat) {
	const parsed = await skills.runFast('reminder-parse', text, chat);
	parseRule(parsed.rule); // validate before it ever hits storage
	const list = loadAll();
	const reminder = {
		id: nextId(list),
		title: parsed.title,
		notes: '',
		rule: parsed.rule,
		leadDays: Math.max(0, Number(parsed.leadDays) || 0),
		nextDue: nextOccurrence(parsed.rule, todayWib()),
		lastTaskId: null,
		lastTaskFor: null,
		active: true,
	};
	list.push(reminder);
	saveAll(list);
	return reminder;
}

// Advances a reminder past its current nextDue, clearing this cycle's task
// bookkeeping — shared by the tick's external-completion detection and
// /remind done <n>. A "once" reminder with nothing left past this date
// goes inactive instead of getting a new (bogus) nextDue.
function rollForward(r) {
	const next = nextOccurrence(r.rule, r.nextDue, { strictlyAfter: true });
	if (next == null) r.active = false;
	else r.nextDue = next;
	r.lastTaskId = null;
	r.lastTaskFor = null;
}

// /remind done <n> (n = position from the last listReminders() order) —
// same rollover tick would give this reminder on an external (phone)
// completion, plus actually checking the Google Task off so it doesn't
// linger open there too.
async function markDone(id) {
	const list = loadAll();
	const r = findActive(list, id);
	if (r.lastTaskId) {
		try {
			const listId = await tasks.ensureTaskList();
			await tasks.completeTask(listId, r.lastTaskId);
		} catch (err) {
			console.error(`[reminders] failed to mark task #${r.lastTaskId} complete:`, err.message);
		}
	}
	rollForward(r);
	saveAll(list);
	return r;
}

function removeReminder(id) {
	const list = loadAll();
	const idx = list.findIndex((x) => x.id === id);
	if (idx === -1) throw new Error(`No reminder #${id}`);
	const [removed] = list.splice(idx, 1);
	saveAll(list);
	return removed;
}

// One run of the daily tick (or /remind check running it on demand):
//  1. For a reminder with an open task from this cycle, check whether it
//     was completed on the phone; if so, roll it forward and skip the rest
//     for today — its next cycle starts fresh on a later tick.
//  2. Otherwise, once nextDue - today <= leadDays: create the Google Task
//     and nudge exactly once per cycle (lastTaskFor tracks this, so a
//     second tick the same day/cycle never double-creates).
//  3. Once due or overdue, nudge again every day the task stays open —
//     the lead-window nudge itself does not repeat, only due/overdue does.
// Returns the reminders that should get a Telegram nudge this run; saving
// state and sending Telegram messages both stay the caller's job (bridge.js)
// so this module never needs a Telegram dependency. `errors` (Google Tasks
// failures — most importantly a dead/revoked token, code 'invalid_grant')
// used to only go to console.error, invisible on a headless Scheduled Task;
// they're returned now so the caller can actually tell the user.
async function tick() {
	const list = loadAll();
	const today = todayWib();
	const nudges = [];
	const errors = [];

	function recordError(r, err) {
		console.error(`[reminders] Google Tasks failed for #${r.id}:`, err.message);
		errors.push({ reminderId: r.id, message: err.message, code: err.code });
	}

	let changed = false;

	for (const r of list) {
		if (!r.active) continue;

		if (r.lastTaskId && r.lastTaskFor === r.nextDue) {
			let completed = false;
			try {
				const listId = await tasks.ensureTaskList();
				completed = await tasks.isTaskCompleted(listId, r.lastTaskId);
			} catch (err) {
				recordError(r, err);
			}
			if (completed) {
				rollForward(r);
				changed = true;
				continue;
			}
		}

		const daysUntilDue = daysBetween(today, r.nextDue);
		const withinLead = daysUntilDue <= r.leadDays;
		const dueOrOverdue = daysUntilDue <= 0;
		const taskExistsThisCycle = r.lastTaskFor === r.nextDue;

		if (withinLead && !taskExistsThisCycle) {
			try {
				const { id: taskId } = await tasks.createTask({ title: r.title, due: r.nextDue, notes: r.notes });
				r.lastTaskId = taskId;
				r.lastTaskFor = r.nextDue;
				changed = true;
				nudges.push({ reminder: r, dueOrOverdue });
			} catch (err) {
				recordError(r, err);
			}
		} else if (dueOrOverdue && taskExistsThisCycle) {
			nudges.push({ reminder: r, dueOrOverdue });
		}
	}

	if (changed) saveAll(list);
	return { nudges, errors };
}

// ---- Scheduling -------------------------------------------------------
// Mirrors lib/regmonitor.js's scheduleDaily/msUntilNextWibHour, but at
// minute granularity (docs/V2-SPEC.md §4: "tick daily 07:15 WIB").

function msUntilNextWibTime(hour, minute) {
	const nowUtc = Date.now();
	const nowWib = new Date(nowUtc + WIB_OFFSET_MS);
	const targetUtc = Date.UTC(nowWib.getUTCFullYear(), nowWib.getUTCMonth(), nowWib.getUTCDate(), hour, minute, 0) - WIB_OFFSET_MS;
	return targetUtc > nowUtc ? targetUtc - nowUtc : targetUtc + 24 * 3600 * 1000 - nowUtc;
}

function scheduleDailyTick(hourWib, minuteWib, callback) {
	const run = () => {
		callback().catch((err) => console.error('[reminders] scheduled tick failed:', err.message));
		setTimeout(run, msUntilNextWibTime(hourWib, minuteWib));
	};
	setTimeout(run, msUntilNextWibTime(hourWib, minuteWib));
}

module.exports = {
	parseRule,
	nextOccurrence,
	daysBetween,
	todayWib,
	addReminder,
	listReminders,
	findActive,
	markDone,
	removeReminder,
	rollForward,
	tick,
	scheduleDailyTick,
	msUntilNextWibTime,
};
