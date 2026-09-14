const { test } = require('node:test');
const assert = require('node:assert');

const digest = require('../lib/digest');
const { env } = require('../lib/config');

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
		finance: { amount: 45000, type: 'out', account: null },
		...overrides,
	};
}

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
	assert.strictEqual(seenItem.finance.amount, 45000);
});

test('autoActions: FINANCE_AUTO_LOG=1 with no logTransaction wired (finance ledger not built yet) degrades to autoLogError, never throws', async () => {
	env.FINANCE_AUTO_LOG = '1';
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
