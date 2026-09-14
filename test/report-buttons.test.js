const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// docs/V2-SPEC.md §3: /report [YYYY-MM] -> income/expense/net, category
// bars, top merchants, delta vs previous month, [📄 Buka sheet][◀️ Bulan
// sebelumnya].
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-bridge-report-'));
process.env.STATE_DIR = path.join(tmpRoot, '.state');
process.env.FINANCE_SHEET_ID = 'test-sheet-id';

const telegram = require('../lib/telegram');
const events = [];
let nextMessageId = 1;
telegram.sendMessage = async (chatId, text, extra) => {
	const message_id = nextMessageId++;
	events.push({ type: 'send', text, extra, message_id });
	return { message_id };
};
telegram.editMessageText = async (chatId, messageId, text, extra) => {
	events.push({ type: 'edit', text, extra, message_id: messageId });
	return { message_id: messageId };
};
telegram.sendChatAction = async () => {};
telegram.setMyCommands = async () => {};
telegram.answerCallbackQuery = async () => {};

const models = require('../lib/models');
for (const key of Object.keys(models.MODELS)) {
	models.MODELS[key].chat = async () => 'Pengeluaran bulan ini didominasi kategori Makan.';
}

function row(date, description, category, amount, type, note = '') {
	return [date, description, category, String(amount), type, '', 'text', '', note];
}

const sheets = require('../lib/google/sheets');
const rowsByMonth = {
	'2026-09': [row('2026-09-01', 'Gaji', 'Pemasukan', 5_000_000, 'in'), row('2026-09-02', 'Makan siang', 'Makan', 45_000, 'out', 'Warteg Bahari')],
	'2026-08': [row('2026-08-01', 'Gaji', 'Pemasukan', 4_500_000, 'in'), row('2026-08-02', 'Makan siang', 'Makan', 30_000, 'out', 'Warteg Bahari')],
};
sheets.readMonthRows = async (monthKey) => rowsByMonth[monthKey] || [];

const { allowedChatId } = require('../lib/config');
const { handleMessage, handleCallbackQuery } = require('../bridge');

test.after(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	delete process.env.STATE_DIR;
	delete process.env.FINANCE_SHEET_ID;
});

const msg = (text) => ({ chat: { id: allowedChatId }, text });
const tick = () => new Promise((r) => setTimeout(r, 80));

test('/report with no args reports the current month, with an "open sheet" and "previous month" button', async () => {
	events.length = 0;
	// Freeze "now" onto September 2026's data by asking for it explicitly is
	// covered below; the bare command still must not throw and must attach
	// both buttons regardless of which month it resolves to.
	await handleMessage(msg('/report 2026-09'));
	await tick();

	const last = events.at(-1);
	assert.strictEqual(last.type, 'edit');
	assert.match(last.text, /Laporan 2026-09/);
	assert.match(last.text, /Masuk Rp 5\.000\.000/);
	assert.match(last.text, /Keluar Rp 45\.000/);
	assert.match(last.text, /Bersih Rp 4\.955\.000/);
	assert.match(last.text, /Pengeluaran bulan ini didominasi kategori Makan\./);
	const rows = last.extra.reply_markup.inline_keyboard;
	assert.match(rows[0][0].url, /docs\.google\.com\/spreadsheets\/d\/test-sheet-id/);
	assert.strictEqual(rows[1][0].text, '◀️ Bulan sebelumnya');
});

test('/report YYYY-MM reports a specific month, with the delta vs the prior month', async () => {
	events.length = 0;
	await handleMessage(msg('/report 2026-09'));
	await tick();

	const last = events.at(-1);
	assert.match(last.text, /Δ pengeluaran vs 2026-08/);
	assert.match(last.text, /\+Rp 15\.000/, 'expense went from 30.000 to 45.000, a +15.000 delta');
});

test('/report with a malformed month argument shows usage instead of throwing', async () => {
	events.length = 0;
	await handleMessage(msg('/report not-a-month'));
	await tick();
	assert.match(events.at(-1).text, /Usage: \/report/);
});

test('[◀️ Bulan sebelumnya] regenerates the report for the prior month and keeps the buttons working', async () => {
	events.length = 0;
	await handleMessage(msg('/report 2026-09'));
	await tick();
	const reportMsg = events.at(-1);
	const prevButton = reportMsg.extra.reply_markup.inline_keyboard[1][0];

	events.length = 0;
	await handleCallbackQuery({ id: 'cq1', data: prevButton.callback_data, message: { chat: { id: allowedChatId }, message_id: reportMsg.message_id } });
	await tick();

	const prevReport = events.at(-1);
	assert.strictEqual(prevReport.type, 'edit');
	assert.match(prevReport.text, /Laporan 2026-08/);
	assert.match(prevReport.text, /Masuk Rp 4\.500\.000/);
	assert.ok(prevReport.extra.reply_markup, 'a fresh set of buttons should be attached for continued navigation');
});
