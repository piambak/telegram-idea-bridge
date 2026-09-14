const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-bridge-gsheets-'));
const tokenFile = path.join(tmpRoot, 'token.json');
fs.writeFileSync(tokenFile, JSON.stringify({ access_token: 'a1', refresh_token: 'r1', expiry_date: Date.now() + 3600_000 }));

const { env } = require('../lib/config');
env.GOOGLE_TOKEN_PATH = tokenFile;
env.GOOGLE_CLIENT_ID = 'client-id';
env.GOOGLE_CLIENT_SECRET = 'client-secret';
env.FINANCE_SHEET_ID = 'sheet-123';

const sheets = require('../lib/google/sheets');

test.after(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	delete env.GOOGLE_TOKEN_PATH;
	delete env.FINANCE_SHEET_ID;
});

function mockSheetsApi(t, { existingSheets, onBatchUpdate, onValuesPut, onValuesAppend } = {}) {
	t.mock.method(global, 'fetch', async (url, opts) => {
		const u = String(url);
		if (u.includes('/sheet-123?fields=sheets.properties')) {
			return { ok: true, json: async () => ({ sheets: existingSheets.map((s) => ({ properties: s })) }) };
		}
		if (u.includes(':batchUpdate')) {
			const body = JSON.parse(opts.body);
			return onBatchUpdate(body);
		}
		if (u.includes(':append')) {
			return onValuesAppend ? onValuesAppend(u, JSON.parse(opts.body)) : { ok: true, json: async () => ({}) };
		}
		if (opts.method === 'PUT') {
			return onValuesPut ? onValuesPut(u, JSON.parse(opts.body)) : { ok: true, json: async () => ({}) };
		}
		throw new Error(`unexpected fetch: ${u}`);
	});
}

test('ensureMonthTab: a tab that already exists is returned as-is, no batchUpdate call', async (t) => {
	mockSheetsApi(t, {
		existingSheets: [{ sheetId: 1, title: '2026-09' }],
		onBatchUpdate: () => {
			throw new Error('must not batchUpdate when the tab already exists');
		},
	});
	const sheetId = await sheets.ensureMonthTab('sheet-123', '2026-09');
	assert.strictEqual(sheetId, 1);
});

test('ensureMonthTab: copies the "Template" tab when one exists', async (t) => {
	mockSheetsApi(t, {
		existingSheets: [{ sheetId: 5, title: 'Template' }],
		onBatchUpdate: (body) => {
			const req = body.requests[0].duplicateSheet;
			assert.strictEqual(req.sourceSheetId, 5);
			assert.strictEqual(req.newSheetName, '2026-10');
			return { ok: true, json: async () => ({ replies: [{ duplicateSheet: { properties: { sheetId: 99 } } }] }) };
		},
	});
	const sheetId = await sheets.ensureMonthTab('sheet-123', '2026-10');
	assert.strictEqual(sheetId, 99);
});

test('ensureMonthTab: with no "Template" tab, creates a blank sheet and writes the fixed header row', async (t) => {
	let headerWritten;
	mockSheetsApi(t, {
		existingSheets: [{ sheetId: 1, title: '2026-08' }], // some other month, no Template
		onBatchUpdate: () => ({ ok: true, json: async () => ({ replies: [{ addSheet: { properties: { sheetId: 42 } } }] }) }),
		onValuesPut: (url, body) => {
			headerWritten = body.values[0];
			assert.match(url, /2026-11!A1/);
			return { ok: true, json: async () => ({}) };
		},
	});
	const sheetId = await sheets.ensureMonthTab('sheet-123', '2026-11');
	assert.strictEqual(sheetId, 42);
	assert.deepStrictEqual(headerWritten, ['Tanggal', 'Deskripsi', 'Kategori', 'Jumlah', 'Tipe', 'Akun', 'Sumber', 'Ref', 'Catatan']);
});

test('appendTransaction: ensures the month tab, then appends the row to it', async (t) => {
	let appendedRange;
	let appendedRow;
	mockSheetsApi(t, {
		existingSheets: [{ sheetId: 1, title: '2026-09' }],
		onBatchUpdate: () => {
			throw new Error('tab already exists, should not batchUpdate');
		},
		onValuesAppend: (url, body) => {
			appendedRange = url;
			appendedRow = body.values[0];
			return { ok: true, json: async () => ({}) };
		},
	});

	await sheets.appendTransaction('2026-09-14T00:00:00.000Z', ['2026-09-14', 'Makan siang', 'Makan', '45000', 'out', '', 'text', '', '']);

	assert.match(appendedRange, /2026-09!A%3AI/);
	assert.strictEqual(appendedRow[0], '2026-09-14');
});

test('appendTransaction: rejects clearly when FINANCE_SHEET_ID is not configured', async () => {
	const saved = env.FINANCE_SHEET_ID;
	delete env.FINANCE_SHEET_ID;
	try {
		await assert.rejects(() => sheets.appendTransaction('2026-09-14', []), /FINANCE_SHEET_ID/);
	} finally {
		env.FINANCE_SHEET_ID = saved;
	}
});

test('monthKeyFor: derives YYYY-MM from a Date or an ISO string', () => {
	assert.strictEqual(sheets.monthKeyFor('2026-09-14T12:00:00.000Z'), '2026-09');
	assert.strictEqual(sheets.monthKeyFor(new Date('2026-01-05T00:00:00.000Z')), '2026-01');
});
