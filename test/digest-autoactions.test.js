const { test } = require('node:test');
const assert = require('node:assert');

const digest = require('../lib/digest');
const { env } = require('../lib/config');
const sheets = require('../lib/google/sheets');

function meetingItem(overrides = {}) {
	return {
		message: { id: 'm1', provider: 'gmail', ics: 'BEGIN:VEVENT\r\nDTSTART:20260918T070000Z\r\nSUMMARY:Sync\r\nEND:VEVENT' },
		category: 'meeting',
		summary: 'Sync',
		action: null,
		due: null,
		priority: 'medium',
		event: { title: 'Sync', start: '2026-09-18T07:00:00.000Z', end: null, location: '', description: '' },
		...overrides,
	};
}

function financeItem(overrides = {}) {
	return {
		message: { id: 'm2', provider: 'gmail', ics: null },
		category: 'finance',
		summary: 'Pembayaran',
		action: null,
		due: null,
		priority: 'medium',
		event: null,
		transaction: {
			date: '2026-09-14T00:00:00.000Z',
			description: 'Pembayaran',
			category: 'Lainnya',
			amount: 45000,
			type: 'out',
			account: null,
			source: 'email',
			ref: 'm2',
			note: '',
		},
		...overrides,
	};
}

// beforeEach, not just afterEach: a real deployment .env can legitimately
// have FINANCE_AUTO_LOG=1/DIGEST_AUTO_CALENDAR=1 set, and afterEach alone
// only cleans up *between* tests — the very first test in the file would
// still see the real machine's actual flag value at start, silently
// changing what "unset" tests are actually asserting (or, worse, letting a
// "falls back to the real finance.logTransaction" test hit real Google
// Sheets on a machine that has real credentials configured).
test.beforeEach(() => {
	delete env.FINANCE_AUTO_LOG;
	delete env.DIGEST_AUTO_CALENDAR;
});
test.afterEach(() => {
	delete env.FINANCE_AUTO_LOG;
	delete env.DIGEST_AUTO_CALENDAR;
});

test('autoActions: DIGEST_AUTO_CALENDAR unset — meetings are left alone, no Radicale call', async () => {
	let called = false;
	const pushEvent = async () => {
		called = true;
	};
	const [item] = await digest.autoActions([meetingItem()], { pushEvent });
	assert.strictEqual(called, false);
	assert.strictEqual(item.autoCalendared, undefined);
});

test('autoActions: DIGEST_AUTO_CALENDAR=1 pushes the meeting\'s original .ics to Radicale and marks it', async () => {
	env.DIGEST_AUTO_CALENDAR = '1';
	let seenUid;
	let seenIcs;
	const pushEvent = async (uid, ics) => {
		seenUid = uid;
		seenIcs = ics;
	};
	const [item] = await digest.autoActions([meetingItem()], { pushEvent });
	assert.strictEqual(item.autoCalendared, true);
	assert.match(seenUid, /^digest-gmail-m1@/);
	assert.match(seenIcs, /SUMMARY:Sync/);
});

test('autoActions: Radicale is office-PC-only — a failed PUT degrades to autoCalendarError, never throws (the manual 📅 Tambah button is the fallback)', async () => {
	env.DIGEST_AUTO_CALENDAR = '1';
	const pushEvent = async () => {
		throw new Error('fetch failed: ECONNREFUSED');
	};
	const [item] = await digest.autoActions([meetingItem()], { pushEvent });
	assert.strictEqual(item.autoCalendared, undefined);
	assert.match(item.autoCalendarError, /ECONNREFUSED/);
});

test('autoActions: a non-meeting item is never sent to Radicale even with the flag on', async () => {
	env.DIGEST_AUTO_CALENDAR = '1';
	let called = false;
	const pushEvent = async () => {
		called = true;
	};
	await digest.autoActions([financeItem()], { pushEvent });
	assert.strictEqual(called, false);
});

test('autoActions: FINANCE_AUTO_LOG unset — transactions are left alone, no logTransaction call', async () => {
	let called = false;
	const logTransaction = async () => {
		called = true;
	};
	const [item] = await digest.autoActions([financeItem()], { logTransaction });
	assert.strictEqual(called, false);
	assert.strictEqual(item.autoLogged, undefined);
});

test('autoActions: FINANCE_AUTO_LOG=1 calls the injected logTransaction and marks the item', async () => {
	env.FINANCE_AUTO_LOG = '1';
	let seenItem;
	const logTransaction = async (item) => {
		seenItem = item;
	};
	const [item] = await digest.autoActions([financeItem()], { logTransaction });
	assert.strictEqual(item.autoLogged, true);
	assert.strictEqual(seenItem.amount, 45000, 'the bare Transaction is passed, not the triage wrapper');
});

test('autoActions: FINANCE_AUTO_LOG=1 with no logTransaction injected falls back to the real finance.logTransaction, which degrades to autoLogError (not thrown) when Sheets isn\'t configured', async (t) => {
	env.FINANCE_AUTO_LOG = '1';
	// Simulates "not configured" explicitly — must never depend on the real
	// env actually lacking FINANCE_SHEET_ID/a Google token, which on a real
	// deployment box (unlike a clean dev sandbox) it usually doesn't. Without
	// this mock, this test would silently write a fake row to the real
	// Finance sheet instead of testing the error path at all.
	t.mock.method(sheets, 'readMonthRows', async () => {
		throw new Error('Not configured — set FINANCE_SHEET_ID');
	});
	const [item] = await digest.autoActions([financeItem()]);
	assert.strictEqual(item.autoLogged, undefined);
	assert.ok(item.autoLogError);
});

test('autoActions: both flags on, mixed items — each auto-action applies only to its own category', async () => {
	env.FINANCE_AUTO_LOG = '1';
	env.DIGEST_AUTO_CALENDAR = '1';
	const pushEvent = async () => {};
	const logTransaction = async () => {};
	const [meeting, finance] = await digest.autoActions([meetingItem(), financeItem()], { pushEvent, logTransaction });
	assert.strictEqual(meeting.autoCalendared, true);
	assert.strictEqual(meeting.autoLogged, undefined);
	assert.strictEqual(finance.autoLogged, true);
	assert.strictEqual(finance.autoCalendared, undefined);
});
