const skills = require('./skills');
const sheets = require('./google/sheets');

// docs/V2-SPEC.md §3: the confirm card's 11-category keypad, and the only
// values `category` may hold — matches .claude/skills/txn-extract/SKILL.md
// exactly.
const CATEGORIES = ['Makan', 'Transport', 'Belanja', 'Tagihan', 'Kesehatan', 'Hiburan', 'Pendidikan', 'Transfer', 'Pemasukan', 'Investasi', 'Lainnya'];

// ---- Amount parsing ----------------------------------------------------

// Finds the first amount-looking substring in free text: "Rp 1.250.000,00",
// "45rb", "1,5jt", "Rp45.000", etc. Returns the matched token, or null.
const AMOUNT_TOKEN_PATTERN = /Rp\.?\s*[\d.,]+(?:\s*(?:rb|ribu|jt|juta)\b)?|\b[\d.,]+\s*(?:rb|ribu|jt|juta)\b/i;

function findAmountToken(text) {
	const m = String(text || '').match(AMOUNT_TOKEN_PATTERN);
	return m ? m[0] : null;
}

// Parses one already-matched amount token into a whole-Rupiah number.
// Handles the colloquial "rb"/"ribu" (x1,000) and "jt"/"juta" (x1,000,000)
// suffixes — whose own numeral may use either "," or "." as its decimal
// point ("1,5jt", "2.5rb") — and plain Rp-formatted numbers, where
// Indonesian convention uses "." as the thousands separator and "," for
// decimals (the opposite of the occasional US-style sender that shows up).
function parseAmount(raw) {
	const s = String(raw || '').trim();
	if (!s) return null;

	const suffixMatch = s.match(/^(?:Rp\.?\s*)?([\d.,]+)\s*(rb|ribu|jt|juta)\b/i);
	if (suffixMatch) {
		const n = parseFloat(suffixMatch[1].replace(',', '.'));
		if (!Number.isFinite(n)) return null;
		const multiplier = /^(rb|ribu)$/i.test(suffixMatch[2]) ? 1_000 : 1_000_000;
		return Math.round(n * multiplier);
	}

	const digits = s.replace(/^Rp\.?\s*/i, '').replace(/[^\d.,]/g, '');
	if (!digits) return null;
	const lastSep = Math.max(digits.lastIndexOf('.'), digits.lastIndexOf(','));
	const normalized =
		lastSep !== -1 && digits.length - lastSep - 1 === 2
			? `${digits.slice(0, lastSep).replace(/[.,]/g, '')}.${digits.slice(lastSep + 1)}`
			: digits.replace(/[.,]/g, '');
	const n = parseFloat(normalized);
	return Number.isFinite(n) ? Math.round(n) : null;
}

// Finds and parses an amount from free text in one step.
function extractAmount(text) {
	const token = findAmountToken(text);
	return token ? parseAmount(token) : null;
}

const IN_WORDS = /\b(masuk|diterima|dapat|gaji|terima|top ?up berhasil|pengembalian|refund|received|credited)\b/i;

// ---- Transaction shape --------------------------------------------------

// The one shape every transaction ends up in, whichever source it came
// from, matching the Sheets header column-for-column:
// Tanggal|Deskripsi|Kategori|Jumlah|Tipe|Akun|Sumber|Ref|Catatan.
function buildTransaction({ date, description, category, amount, type, account, source, ref, note }) {
	if (!(amount > 0)) throw new Error(`Transaction amount must be greater than 0 (got ${amount})`);
	if (type !== 'in' && type !== 'out') throw new Error(`Invalid transaction type "${type}" — must be "in" or "out"`);
	if (!['email', 'text', 'photo'].includes(source)) throw new Error(`Invalid transaction source "${source}"`);
	return {
		date: date || new Date().toISOString(),
		description: (description || '').trim() || '(no description)',
		category: CATEGORIES.includes(category) ? category : 'Lainnya',
		amount: Math.round(amount),
		type,
		account: account || '',
		source,
		ref: ref || '',
		note: note || '',
	};
}

function transactionToRow(txn) {
	return [txn.date.slice(0, 10), txn.description, txn.category, String(txn.amount), txn.type, txn.account, txn.source, txn.ref, txn.note];
}

// ---- Source #1: /spend text ---------------------------------------------

// A regex-derived amount/type hint that stands on its own — used as the
// fallback transaction, and handed to txn-extract as context.
function regexHint(text) {
	return { amount: extractAmount(text), type: IN_WORDS.test(text) ? 'in' : 'out' };
}

// "/spend makan siang 45rb" -> regex hint (amount/type) first, then
// txn-extract refines description/category/merchant. The regex hint alone
// is a usable transaction, so a model failure never loses the amount —
// only the refinement (docs/V2-SPEC.md §3).
async function fromText(text, chat) {
	const hint = regexHint(text);
	let category = 'Lainnya';
	let description = text.trim();
	let merchant = '';
	try {
		const prompt = `Text: "${text}"\nRegex hint: amount=${hint.amount == null ? 'unknown' : hint.amount}, type=${hint.type}`;
		const refined = await skills.runFast('txn-extract', prompt, chat);
		if (refined && refined.description) description = refined.description;
		if (refined && CATEGORIES.includes(refined.category)) category = refined.category;
		if (refined && refined.merchant) merchant = refined.merchant;
	} catch {
		// txn-extract failed entirely — the regex hint (amount/type) is still
		// a complete, usable transaction on its own.
	}
	return buildTransaction({
		date: new Date().toISOString(),
		description,
		category,
		amount: hint.amount,
		type: hint.type,
		account: null,
		source: 'text',
		ref: null,
		note: merchant,
	});
}

// ---- Source #2: receipt photo --------------------------------------------

// Receipt photo -> Gemini Flash vision + receipt-vision skill -> grand
// total, merchant, date, up to 3 line items (docs/V2-SPEC.md §3).
// `chat` must be a vision-capable chat function (the caller passes
// MODELS.gemini.chat) — receipt-vision doesn't decide a category (that's
// the confirm card's keypad), so this defaults to Lainnya.
async function fromImage(buffer, chat) {
	const userContent = [
		{ type: 'text', text: 'Read this receipt and follow the system instructions.' },
		{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${buffer.toString('base64')}` } },
	];
	const data = await skills.runFast('receipt-vision', userContent, chat);
	if (!data || !(data.total > 0)) throw new Error('Could not read a total from the receipt');
	const itemsNote = (data.items || []).map((it) => `${it.name}: ${it.amount}`).join('; ');
	return buildTransaction({
		date: data.date ? new Date(data.date).toISOString() : new Date().toISOString(),
		description: data.merchant || 'Struk',
		category: 'Lainnya',
		amount: data.total,
		type: 'out',
		account: null,
		source: 'photo',
		ref: null,
		note: [data.merchant, itemsNote].filter(Boolean).join(' — '),
	});
}

// ---- Source #3: bank/e-wallet email ---------------------------------------

// ~40 Indonesian bank/e-wallet/marketplace sender domains whose
// transaction notifications this bot recognizes without needing a model
// call (docs/V2-SPEC.md §3).
const FINANCE_SENDER_DOMAINS = [
	// Banks
	'bca.co.id',
	'bni.co.id',
	'bri.co.id',
	'bankmandiri.co.id',
	'mandiri.co.id',
	'cimbniaga.co.id',
	'cimbniaga.com',
	'permatabank.co.id',
	'btn.co.id',
	'danamon.co.id',
	'ocbc.id',
	'panin.co.id',
	'maybank.co.id',
	'btpn.co.id',
	'bankmega.com',
	'bjb.co.id',
	'bankbsi.co.id',
	'bsi.co.id',
	'bankjago.com',
	'jago.com',
	'bankneocommerce.co.id',
	'digibank.co.id',
	'hsbc.co.id',
	'bankbtpn.com',
	// E-wallets / fintech
	'dana.id',
	'ovo.id',
	'gojek.com',
	'gopay.co.id',
	'grab.com',
	'shopeepay.co.id',
	'linkaja.id',
	'jenius.com',
	'seabank.co.id',
	'sakuku.co.id',
	'flip.id',
	'kredivo.com',
	'akulaku.com',
	'home-credit.co.id',
	'paypal.com',
	'wise.com',
	// Marketplaces / payment gateways that send transaction receipts
	'tokopedia.com',
	'shopee.co.id',
	'bukalapak.com',
	'blibli.com',
	'lazada.co.id',
	'midtrans.com',
	'xendit.co',
	'doku.com',
];

function isFinanceSender(email) {
	const domain = String(email || '')
		.split('@')[1]
		?.toLowerCase();
	if (!domain) return false;
	return FINANCE_SENDER_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

// Turns a normalized inbox message (lib/mail's shape) into a Transaction,
// or null when it isn't recognizable as a financial email at all (neither
// a known sender nor a readable amount). Ref = the email's own id, so
// re-running the digest and finding the same email again never double-logs
// (docs/V2-SPEC.md §3).
function fromEmail(msg) {
	const text = msg.text || msg.snippet || '';
	const amount = extractAmount(text);
	if (!isFinanceSender(msg.from.email) && amount == null) return null;
	if (amount == null || amount <= 0) return null;

	const type = IN_WORDS.test(text) ? 'in' : 'out';
	const accountMatch = text.match(/\b(?:kartu|rek(?:ening)?|akun)\s*(?:\*+|x+)?(\d{3,6})\b/i);

	return buildTransaction({
		date: msg.date || new Date().toISOString(),
		description: msg.subject || 'Transaksi',
		category: type === 'in' ? 'Pemasukan' : 'Lainnya',
		amount,
		type,
		account: accountMatch ? accountMatch[1] : null,
		source: 'email',
		ref: msg.id,
		note: msg.from.name || msg.from.email,
	});
}

// ---- Logging (with ref-based dedup) --------------------------------------

// Appends `txn` to its month's tab, unless a row with the same non-empty
// `ref` is already there — re-running the digest over the same email must
// never log it twice (docs/V2-SPEC.md §3).
async function logTransaction(txn) {
	if (txn.ref) {
		const monthKey = sheets.monthKeyFor(txn.date);
		const rows = await sheets.readMonthRows(monthKey);
		const refCol = sheets.HEADER.indexOf('Ref');
		if (rows.some((row) => row[refCol] === txn.ref)) {
			return { logged: false, reason: 'duplicate ref' };
		}
	}
	await sheets.appendTransaction(txn.date, transactionToRow(txn));
	return { logged: true };
}

// ---- /report ---------------------------------------------------------

function rowToTransaction(row) {
	const [date, description, category, amount, type, account, source, ref, note] = row;
	const amountNum = Number(amount);
	if (!date || !Number.isFinite(amountNum)) return null; // a stray/malformed row, e.g. hand-edited
	return { date, description, category, amount: amountNum, type, account, source, ref, note };
}

async function readMonthTransactions(monthKey) {
	const rows = await sheets.readMonthRows(monthKey);
	return rows.map(rowToTransaction).filter(Boolean);
}

// "2026-09" -> "2026-08"; wraps the year boundary ("2026-01" -> "2025-12").
function previousMonthKey(monthKey) {
	const [y, m] = monthKey.split('-').map(Number);
	const prevMonth = m === 1 ? 12 : m - 1;
	const prevYear = m === 1 ? y - 1 : y;
	return `${prevYear}-${String(prevMonth).padStart(2, '0')}`;
}

// The pure math half of /report — income/expense/net, category shares
// (of expense), top-5 merchants (by expense), and a daily average —
// entirely computable from a list of transactions, no model call and no
// network (docs/V2-SPEC.md §3).
function computeStats(monthKey, txns) {
	const income = txns.filter((t) => t.type === 'in').reduce((sum, t) => sum + t.amount, 0);
	const expenseTxns = txns.filter((t) => t.type === 'out');
	const expense = expenseTxns.reduce((sum, t) => sum + t.amount, 0);

	const byCategory = new Map();
	for (const t of expenseTxns) byCategory.set(t.category, (byCategory.get(t.category) || 0) + t.amount);
	const categoryBreakdown = [...byCategory.entries()]
		.map(([category, amount]) => ({ category, amount, share: expense > 0 ? amount / expense : 0 }))
		.sort((a, b) => b.amount - a.amount);

	const byMerchant = new Map();
	for (const t of expenseTxns) {
		const key = t.note || t.description || 'Lainnya';
		byMerchant.set(key, (byMerchant.get(key) || 0) + t.amount);
	}
	const topMerchants = [...byMerchant.entries()]
		.map(([merchant, amount]) => ({ merchant, amount }))
		.sort((a, b) => b.amount - a.amount)
		.slice(0, 5);

	const [y, m] = monthKey.split('-').map(Number);
	const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();

	return {
		monthKey,
		income,
		expense,
		net: income - expense,
		categoryBreakdown,
		topMerchants,
		dailyAverage: expense / daysInMonth,
		transactionCount: txns.length,
	};
}

// Full report for one month, plus its delta against the previous month
// (null if the previous month has no data at all, e.g. the bot's first
// month of use). Pure math only — no finance-commentary call here, so this
// stays independently testable; see commentaryFor() for the model-backed
// 2-3 sentence write-up.
async function generateReport(monthKey) {
	const stats = computeStats(monthKey, await readMonthTransactions(monthKey));
	const prevKey = previousMonthKey(monthKey);
	const prevTxns = await readMonthTransactions(prevKey);
	const prevStats = prevTxns.length > 0 ? computeStats(prevKey, prevTxns) : null;
	return {
		...stats,
		previousMonthKey: prevKey,
		delta: prevStats ? { income: stats.income - prevStats.income, expense: stats.expense - prevStats.expense, net: stats.net - prevStats.net } : null,
	};
}

// 2-3 sentences of commentary from the finance-commentary skill, given an
// already-computed report — the skill interprets, it never recomputes.
async function commentaryFor(report, chat) {
	const summary = JSON.stringify({
		income: report.income,
		expense: report.expense,
		net: report.net,
		categoryBreakdown: report.categoryBreakdown,
		topMerchants: report.topMerchants,
		dailyAverage: report.dailyAverage,
		delta: report.delta,
	});
	return skills.runFast('finance-commentary', summary, chat);
}

// ---- Monthly auto-report scheduling ---------------------------------

const WIB_OFFSET_MS = 7 * 3600 * 1000;

// ms until the next 1st-of-month occurrence of `hour` WIB — mirrors
// lib/regmonitor.js's msUntilNextWibHour, but for a monthly instead of a
// daily cadence.
function msUntilNext1stWibHour(hour) {
	const nowUtc = Date.now();
	const nowWib = new Date(nowUtc + WIB_OFFSET_MS);
	const y = nowWib.getUTCFullYear();
	const m = nowWib.getUTCMonth();
	let targetUtc = Date.UTC(y, m, 1, hour, 0, 0) - WIB_OFFSET_MS;
	if (targetUtc <= nowUtc) targetUtc = Date.UTC(y, m + 1, 1, hour, 0, 0) - WIB_OFFSET_MS;
	return targetUtc - nowUtc;
}

// Runs `callback` once at the next 1st-of-month `hourWib`, then every month
// after (docs/V2-SPEC.md §3: "automatically on the 1st at 08:00 for the
// previous month") — recomputed each time so it can't drift, and safe across
// months of different lengths since it targets day 1 specifically.
function scheduleMonthlyReport(hourWib, callback) {
	const run = () => {
		callback().catch((err) => console.error('[finance] scheduled monthly report failed:', err.message));
		setTimeout(run, msUntilNext1stWibHour(hourWib));
	};
	setTimeout(run, msUntilNext1stWibHour(hourWib));
}

module.exports = {
	CATEGORIES,
	findAmountToken,
	parseAmount,
	extractAmount,
	regexHint,
	buildTransaction,
	transactionToRow,
	fromText,
	fromImage,
	fromEmail,
	isFinanceSender,
	logTransaction,
	computeStats,
	generateReport,
	commentaryFor,
	previousMonthKey,
	readMonthTransactions,
	FINANCE_SENDER_DOMAINS,
	scheduleMonthlyReport,
	msUntilNext1stWibHour,
};
