const { test } = require('node:test');
const assert = require('node:assert');

const finance = require('../lib/finance');
const sheets = require('../lib/google/sheets');

function txn(overrides) {
	return finance.buildTransaction({
		date: '2026-09-14T00:00:00.000Z',
		description: 'Makan siang',
		category: 'Makan',
		amount: 45_000,
		type: 'out',
		account: '',
		source: 'email',
		ref: 'email-ref-1',
		note: '',
		...overrides,
	});
}

// --- logTransaction: ref-based dedup ---

test('logTransaction: a fresh ref is appended', async (t) => {
	let appended = null;
	t.mock.method(sheets, 'readMonthRows', async () => []);
	t.mock.method(sheets, 'appendTransaction', async (date, row) => {
		appended = { date, row };
	});

	const result = await finance.logTransaction(txn());

	assert.deepStrictEqual(result, { logged: true });
	assert.ok(appended);
	assert.strictEqual(appended.row[sheets.HEADER.indexOf('Ref')], 'email-ref-1');
});

test('logTransaction: a ref that already exists in the month\'s rows is skipped, never appended twice', async (t) => {
	const refCol = sheets.HEADER.indexOf('Ref');
	const existingRow = new Array(sheets.HEADER.length).fill('');
	existingRow[refCol] = 'email-ref-1';
	t.mock.method(sheets, 'readMonthRows', async () => [existingRow]);
	t.mock.method(sheets, 'appendTransaction', async () => {
		throw new Error('must not append a duplicate ref');
	});

	const result = await finance.logTransaction(txn());
	assert.deepStrictEqual(result, { logged: false, reason: 'duplicate ref' });
});

test('logTransaction: re-running the digest over the same email is idempotent end to end', async (t) => {
	// Simulates digest.js calling logTransaction twice for the same email
	// (e.g. the digest ran twice before the cursor advanced) — the second
	// call must be a no-op, not a second row.
	const rows = [];
	t.mock.method(sheets, 'readMonthRows', async () => rows.slice());
	t.mock.method(sheets, 'appendTransaction', async (date, row) => {
		rows.push(row);
	});

	const email = txn({ ref: 'gmail-xyz' });
	await finance.logTransaction(email);
	const second = await finance.logTransaction(email);

	assert.strictEqual(rows.length, 1, 'only one row should exist after two identical logTransaction calls');
	assert.strictEqual(second.logged, false);
});

test('logTransaction: a transaction with no ref (e.g. from /spend text) is always appended — nothing to dedup against', async (t) => {
	let calls = 0;
	t.mock.method(sheets, 'readMonthRows', async () => {
		throw new Error('should not even check for dedup when there is no ref');
	});
	t.mock.method(sheets, 'appendTransaction', async () => {
		calls++;
	});
	await finance.logTransaction(txn({ ref: '' }));
	assert.strictEqual(calls, 1);
});

// --- generateReport: the math, against a mocked ledger ---

function row(date, description, category, amount, type, note = '') {
	return [date, description, category, String(amount), type, '', 'text', '', note];
}

test('generateReport: income/expense/net, category shares, top-5 merchants, daily average', async (t) => {
	const septemberRows = [
		row('2026-09-01', 'Gaji', 'Pemasukan', 5_000_000, 'in'),
		row('2026-09-02', 'Makan siang', 'Makan', 45_000, 'out', 'Warteg Bahari'),
		row('2026-09-03', 'Bensin', 'Transport', 100_000, 'out', 'Pertamina'),
		row('2026-09-05', 'Makan malam', 'Makan', 55_000, 'out', 'Warteg Bahari'),
		row('2026-09-10', 'Belanja bulanan', 'Belanja', 300_000, 'out', 'Indomaret'),
	];
	t.mock.method(sheets, 'readMonthRows', async (monthKey) => (monthKey === '2026-09' ? septemberRows : []));

	const report = await finance.generateReport('2026-09');

	assert.strictEqual(report.income, 5_000_000);
	assert.strictEqual(report.expense, 500_000);
	assert.strictEqual(report.net, 4_500_000);
	assert.strictEqual(report.transactionCount, 5);

	const byCategory = Object.fromEntries(report.categoryBreakdown.map((c) => [c.category, c]));
	assert.strictEqual(byCategory.Makan.amount, 100_000);
	assert.strictEqual(byCategory.Makan.share, 0.2); // 100000 / 500000
	assert.strictEqual(byCategory.Belanja.amount, 300_000);
	assert.strictEqual(byCategory.Belanja.share, 0.6);

	assert.strictEqual(report.topMerchants[0].merchant, 'Indomaret');
	assert.strictEqual(report.topMerchants[0].amount, 300_000);
	assert.strictEqual(report.topMerchants[1].merchant, 'Warteg Bahari');
	assert.strictEqual(report.topMerchants[1].amount, 100_000, 'two Warteg Bahari rows should be summed together');

	// September 2026 has 30 days.
	assert.ok(Math.abs(report.dailyAverage - 500_000 / 30) < 0.001);
});

test('generateReport: top merchants are capped at 5', async (t) => {
	const rows = Array.from({ length: 8 }, (_, i) => row('2026-09-01', `Item ${i}`, 'Belanja', (i + 1) * 1000, 'out', `Merchant ${i}`));
	t.mock.method(sheets, 'readMonthRows', async () => rows);
	const report = await finance.generateReport('2026-09');
	assert.strictEqual(report.topMerchants.length, 5);
	assert.strictEqual(report.topMerchants[0].merchant, 'Merchant 7', 'highest amount first');
});

test('generateReport: delta vs. the previous month, and null when the previous month has no data', async (t) => {
	t.mock.method(sheets, 'readMonthRows', async (monthKey) => {
		if (monthKey === '2026-09') return [row('2026-09-01', 'A', 'Makan', 100_000, 'out')];
		if (monthKey === '2026-08') return [row('2026-08-01', 'B', 'Makan', 60_000, 'out')];
		return [];
	});

	const report = await finance.generateReport('2026-09');
	assert.strictEqual(report.previousMonthKey, '2026-08');
	assert.strictEqual(report.delta.expense, 40_000);

	const reportNoHistory = await finance.generateReport('2026-01');
	assert.strictEqual(reportNoHistory.previousMonthKey, '2025-12');
	assert.strictEqual(reportNoHistory.delta, null, 'no data for the previous month means no delta, not a misleading 0');
});

test('previousMonthKey: wraps the year boundary correctly', () => {
	assert.strictEqual(finance.previousMonthKey('2026-01'), '2025-12');
	assert.strictEqual(finance.previousMonthKey('2026-09'), '2026-08');
});

test('computeStats: a month with only income has 0 expense and no divide-by-zero NaN in category shares', () => {
	const stats = finance.computeStats('2026-09', [{ date: '2026-09-01', description: 'Gaji', category: 'Pemasukan', amount: 1_000_000, type: 'in' }]);
	assert.strictEqual(stats.expense, 0);
	assert.deepStrictEqual(stats.categoryBreakdown, []);
	assert.strictEqual(stats.dailyAverage, 0);
});

test('commentaryFor: calls finance-commentary with the computed stats, not raw transactions', async () => {
	let seenPrompt;
	const chat = async (messages) => {
		seenPrompt = messages[1].content;
		return 'Pengeluaran bulan ini didominasi kategori Makan.';
	};
	const report = { income: 1000, expense: 500, net: 500, categoryBreakdown: [], topMerchants: [], dailyAverage: 16, delta: null };
	const text = await finance.commentaryFor(report, chat);
	assert.strictEqual(text, 'Pengeluaran bulan ini didominasi kategori Makan.');
	const parsed = JSON.parse(seenPrompt);
	assert.strictEqual(parsed.income, 1000);
});
