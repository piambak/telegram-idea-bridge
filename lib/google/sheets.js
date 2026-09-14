const auth = require('./auth');
const { env } = require('../config');

const API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

// docs/SETUP-GOOGLE.md §3: the finance ledger's one fixed header row.
const HEADER = ['Tanggal', 'Deskripsi', 'Kategori', 'Jumlah', 'Tipe', 'Akun', 'Sumber', 'Ref', 'Catatan'];
const TEMPLATE_TAB_NAME = 'Template';

async function apiFetch(accessToken, method, pathSuffix, body) {
	const res = await fetch(`${API_BASE}${pathSuffix}`, {
		method,
		headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
		body: body ? JSON.stringify(body) : undefined,
	});
	const json = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(`Google Sheets API failed: HTTP ${res.status}: ${(json.error && json.error.message) || JSON.stringify(json)}`);
	return json;
}

async function listSheets(accessToken, spreadsheetId) {
	const meta = await apiFetch(accessToken, 'GET', `/${spreadsheetId}?fields=sheets.properties`);
	return (meta.sheets || []).map((s) => s.properties);
}

// "2026-09-14T..." -> "2026-09". Accepts either a Date or an ISO string.
function monthKeyFor(date) {
	const iso = date instanceof Date ? date.toISOString() : String(date);
	return iso.slice(0, 7);
}

// Ensures a tab named `monthKey` (YYYY-MM) exists, returning its sheetId.
// Copied from a "Template" tab if one exists (keeping its formatting/
// formulas); otherwise created fresh with just the fixed header row.
// Idempotent — a tab that already exists is left untouched and returned
// as-is.
async function ensureMonthTab(spreadsheetId, monthKey) {
	const accessToken = await auth.getAccessToken();
	const sheets = await listSheets(accessToken, spreadsheetId);

	const existing = sheets.find((s) => s.title === monthKey);
	if (existing) return existing.sheetId;

	const template = sheets.find((s) => s.title === TEMPLATE_TAB_NAME);
	if (template) {
		const result = await apiFetch(accessToken, 'POST', `/${spreadsheetId}:batchUpdate`, {
			requests: [{ duplicateSheet: { sourceSheetId: template.sheetId, newSheetName: monthKey } }],
		});
		return result.replies[0].duplicateSheet.properties.sheetId;
	}

	const created = await apiFetch(accessToken, 'POST', `/${spreadsheetId}:batchUpdate`, {
		requests: [{ addSheet: { properties: { title: monthKey } } }],
	});
	const sheetId = created.replies[0].addSheet.properties.sheetId;
	await apiFetch(
		accessToken,
		'PUT',
		`/${spreadsheetId}/values/${encodeURIComponent(`${monthKey}!A1:${String.fromCharCode(64 + HEADER.length)}1`)}?valueInputOption=USER_ENTERED`,
		{ values: [HEADER] },
	);
	return sheetId;
}

// Appends one transaction row to the tab for `date`'s month, creating that
// tab first if it doesn't exist yet. `row` must already be in HEADER order.
async function appendTransaction(date, row) {
	const spreadsheetId = env.FINANCE_SHEET_ID;
	if (!spreadsheetId) throw new Error('Not configured — set FINANCE_SHEET_ID');
	const monthKey = monthKeyFor(date);
	await ensureMonthTab(spreadsheetId, monthKey);
	const accessToken = await auth.getAccessToken();
	await apiFetch(accessToken, 'POST', `/${spreadsheetId}/values/${encodeURIComponent(`${monthKey}!A:${String.fromCharCode(64 + HEADER.length)}`)}:append?valueInputOption=USER_ENTERED`, {
		values: [row],
	});
}

// Reads every data row (header excluded) from a month's tab, in HEADER
// column order. Returns [] for a month with no tab yet (nothing logged) —
// a Sheets 400 "Unable to parse range" for a nonexistent tab is a normal,
// common case here, not a real error.
async function readMonthRows(monthKey) {
	const spreadsheetId = env.FINANCE_SHEET_ID;
	if (!spreadsheetId) throw new Error('Not configured — set FINANCE_SHEET_ID');
	const accessToken = await auth.getAccessToken();
	const range = `${monthKey}!A2:${String.fromCharCode(64 + HEADER.length)}`;
	let result;
	try {
		result = await apiFetch(accessToken, 'GET', `/${spreadsheetId}/values/${encodeURIComponent(range)}`);
	} catch (err) {
		if (/unable to parse range/i.test(err.message)) return [];
		throw err;
	}
	return result.values || [];
}

module.exports = { ensureMonthTab, appendTransaction, readMonthRows, monthKeyFor, HEADER, TEMPLATE_TAB_NAME };
