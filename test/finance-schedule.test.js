const { test } = require('node:test');
const assert = require('node:assert');

const finance = require('../lib/finance');

// docs/V2-SPEC.md §3: the monthly report is auto-sent "on the 1st at 08:00"
// (previous month). msUntilNext1stWibHour is the pure-math half of that —
// no timers, just "how many ms until the next occurrence".
test('msUntilNext1stWibHour: before the target hour on the 1st, targets later the same day', () => {
	const nowWib = Date.UTC(2026, 8, 1, 3, 0, 0); // 2026-09-01 03:00 WIB
	const nowUtc = nowWib - 7 * 3600 * 1000;
	const targetWib = Date.UTC(2026, 8, 1, 8, 0, 0);
	const expectedMs = targetWib - nowWib;

	const realNow = Date.now;
	Date.now = () => nowUtc;
	try {
		assert.strictEqual(finance.msUntilNext1stWibHour(8), expectedMs);
	} finally {
		Date.now = realNow;
	}
});

test('msUntilNext1stWibHour: after the target hour on the 1st, rolls over to the 1st of next month', () => {
	const nowWib = Date.UTC(2026, 8, 1, 9, 0, 0); // 2026-09-01 09:00 WIB, past 08:00
	const nowUtc = nowWib - 7 * 3600 * 1000;
	const targetWib = Date.UTC(2026, 9, 1, 8, 0, 0); // 2026-10-01 08:00 WIB

	const realNow = Date.now;
	Date.now = () => nowUtc;
	try {
		assert.strictEqual(finance.msUntilNext1stWibHour(8), targetWib - nowWib);
	} finally {
		Date.now = realNow;
	}
});

test('msUntilNext1stWibHour: on any other day of the month, rolls over to next month\'s 1st, not tomorrow', () => {
	const nowWib = Date.UTC(2026, 8, 15, 3, 0, 0); // 2026-09-15
	const nowUtc = nowWib - 7 * 3600 * 1000;
	const targetWib = Date.UTC(2026, 9, 1, 8, 0, 0); // 2026-10-01 08:00 WIB

	const realNow = Date.now;
	Date.now = () => nowUtc;
	try {
		assert.strictEqual(finance.msUntilNext1stWibHour(8), targetWib - nowWib);
	} finally {
		Date.now = realNow;
	}
});

test('scheduleMonthlyReport: fires once at the next 1st-at-hour tick, not again before the following month', (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	let calls = 0;
	const delay = finance.msUntilNext1stWibHour(8);
	finance.scheduleMonthlyReport(8, async () => {
		calls++;
	});
	t.mock.timers.tick(delay + 10);
	assert.strictEqual(calls, 1);
});
