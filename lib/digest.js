const { env } = require('./config');
const skills = require('./skills');
const radicale = require('./radicale');

// ---- ICS parsing (TZID-aware) ---------------------------------------

// Lines over 75 octets are "folded" in ICS with a leading space/tab on the
// continuation line (RFC 5545 §3.1) — unfold before parsing anything else.
function unfoldIcsLines(text) {
	const rawLines = String(text).replace(/\r\n/g, '\n').split('\n');
	const lines = [];
	for (const line of rawLines) {
		if ((line.startsWith(' ') || line.startsWith('\t')) && lines.length > 0) {
			lines[lines.length - 1] += line.slice(1);
		} else if (line.trim() !== '') {
			lines.push(line);
		}
	}
	return lines;
}

function unescapeIcsText(s) {
	return String(s || '')
		.replace(/\\n/gi, '\n')
		.replace(/\\,/g, ',')
		.replace(/\\;/g, ';')
		.replace(/\\\\/g, '\\');
}

// A small fixed-offset table for the zones this bot actually needs
// (senders in/around Indonesia) — not a full IANA tz database. A DTSTART
// with an unrecognized or missing TZID falls back to treating the local
// time as UTC, which is honest (no silent wrong-zone guess) rather than
// pretending to fully solve arbitrary VTIMEZONE blocks.
const TZID_OFFSET_MIN = {
	'Asia/Jakarta': 7 * 60,
	'Asia/Pontianak': 7 * 60,
	'Asia/Makassar': 8 * 60,
	'Asia/Jayapura': 9 * 60,
	'Asia/Bangkok': 7 * 60,
	'Asia/Ho_Chi_Minh': 7 * 60,
	'Asia/Singapore': 8 * 60,
	'Asia/Kuala_Lumpur': 8 * 60,
	'Asia/Manila': 8 * 60,
	UTC: 0,
	GMT: 0,
};

function icsDateToIso({ value, params }) {
	const v = String(value).trim();
	if (params.VALUE === 'DATE' || /^\d{8}$/.test(v)) {
		return new Date(`${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T00:00:00Z`).toISOString();
	}
	const y = v.slice(0, 4);
	const mo = v.slice(4, 6);
	const d = v.slice(6, 8);
	const hh = v.slice(9, 11);
	const mm = v.slice(11, 13);
	const ss = v.slice(13, 15) || '00';
	if (v.endsWith('Z')) {
		return new Date(`${y}-${mo}-${d}T${hh}:${mm}:${ss}Z`).toISOString();
	}
	const offsetMin = params.TZID && TZID_OFFSET_MIN[params.TZID] != null ? TZID_OFFSET_MIN[params.TZID] : 0;
	const asUtcMs = Date.parse(`${y}-${mo}-${d}T${hh}:${mm}:${ss}Z`) - offsetMin * 60_000;
	return new Date(asUtcMs).toISOString();
}

function parsePropertyLine(line) {
	const idx = line.indexOf(':');
	if (idx === -1) return null;
	const rawKey = line.slice(0, idx);
	const value = line.slice(idx + 1);
	const [key, ...paramParts] = rawKey.split(';');
	const params = {};
	for (const p of paramParts) {
		const eq = p.indexOf('=');
		if (eq === -1) continue;
		params[p.slice(0, eq)] = p.slice(eq + 1);
	}
	return { key, value, params };
}

// Parses the first VEVENT in an .ics file into { title, location, start,
// end, description } — start/end as ISO UTC strings. TZID-aware: a
// DTSTART;TZID=Asia/Jakarta:... resolves against that zone's fixed offset,
// not treated as already-UTC.
function parseIcsEvent(icsText) {
	const lines = unfoldIcsLines(icsText);
	const props = {};
	let inEvent = false;
	for (const line of lines) {
		if (line === 'BEGIN:VEVENT') {
			inEvent = true;
			continue;
		}
		if (line === 'END:VEVENT') break;
		if (!inEvent) continue;
		const parsed = parsePropertyLine(line);
		if (parsed) props[parsed.key] = parsed;
	}
	return {
		title: props.SUMMARY ? unescapeIcsText(props.SUMMARY.value) : '',
		location: props.LOCATION ? unescapeIcsText(props.LOCATION.value) : '',
		description: props.DESCRIPTION ? unescapeIcsText(props.DESCRIPTION.value) : '',
		start: props.DTSTART ? icsDateToIso(props.DTSTART) : null,
		end: props.DTEND ? icsDateToIso(props.DTEND) : null,
	};
}

// ---- Zero-cost triage rules -------------------------------------------

const BANK_SENDER_PATTERN = /@(bca|bni|bri|mandiri|cimbniaga|permatabank|dana|ovo|gopay|shopeepay|linkaja|jenius|jago|seabank|paypal)\.(co\.id|com|id)$/i;
const TRANSACTION_WORDS = /\b(transaksi|pembayaran|pembelian|transfer|tagihan|debit|kredit|top ?up|saldo|invoice)\b/i;
const RP_AMOUNT = /\bRp\s?[\d.,]+/i;
const OTP_PATTERN = /\b(OTP|kode verifikasi|verification code|one[- ]time password|kode masuk|login code|kode OTP|authentication code)\b/i;
const CATEGORY_PROMOTIONS_LABEL = 'CATEGORY_PROMOTIONS';
const UNSUBSCRIBE_PATTERN = /\b(unsubscribe|berhenti berlangganan|promo|diskon|special offer|penawaran khusus|newsletter)\b/i;

function isMeeting(msg) {
	return Boolean(msg.ics);
}

function isFinance(msg) {
	if (BANK_SENDER_PATTERN.test(msg.from.email || '')) return true;
	return RP_AMOUNT.test(msg.text || '') && TRANSACTION_WORDS.test(msg.text || '');
}

function isSystem(msg) {
	return OTP_PATTERN.test(msg.subject || '') || OTP_PATTERN.test(msg.text || '');
}

function isNewsletter(msg) {
	if ((msg.labels || []).includes(CATEGORY_PROMOTIONS_LABEL)) return true;
	return UNSUBSCRIBE_PATTERN.test(msg.text || '') || UNSUBSCRIBE_PATTERN.test(msg.subject || '');
}

// "Rp 1.250.000,00" / "Rp45.000" / "Rp 1,250,000.00" -> 1250000. Indonesian
// formatting uses "." as the thousands separator and "," for decimals
// (opposite of the US style some senders still use) — treat the LAST
// separator as decimal only when exactly 2 digits follow it, and strip
// every other separator as a thousands mark.
function parseRupiah(raw) {
	const digits = String(raw).replace(/[^\d.,]/g, '');
	const lastSep = Math.max(digits.lastIndexOf('.'), digits.lastIndexOf(','));
	let normalized;
	if (lastSep !== -1 && digits.length - lastSep - 1 === 2) {
		normalized = digits.slice(0, lastSep).replace(/[.,]/g, '') + '.' + digits.slice(lastSep + 1);
	} else {
		normalized = digits.replace(/[.,]/g, '');
	}
	const n = parseFloat(normalized);
	return Number.isFinite(n) ? Math.round(n) : null;
}

const IN_WORDS = /\b(masuk|diterima|received|credited|top ?up berhasil|pengembalian|refund)\b/i;

function extractFinanceDetails(msg) {
	const text = msg.text || '';
	const amountMatch = text.match(/Rp\s?([\d.,]+)/i);
	const accountMatch = text.match(/\b(?:kartu|rek(?:ening)?|akun)\s*(?:\*+|x+)?(\d{3,6})\b/i);
	return {
		amount: amountMatch ? parseRupiah(amountMatch[1]) : null,
		type: IN_WORDS.test(text) ? 'in' : 'out',
		account: accountMatch ? accountMatch[1] : null,
	};
}

// ---- Category display order -------------------------------------------

const CATEGORY_ORDER = ['action', 'meeting', 'finance', 'office', 'personal', 'newsletter', 'system'];
const CATEGORY_LABELS = {
	action: '🔴 Perlu tindakan',
	meeting: '📅 Undangan & jadwal',
	finance: '💸 Transaksi & tagihan',
	office: '💼 Kantor — info',
	personal: '👤 Pribadi',
	newsletter: '📰 Newsletter & promo',
	system: '🔔 Notifikasi sistem',
};

const EMAIL_TRIAGE_BATCH_SIZE = 8;

function formatMessageForModel(msg, index) {
	const from = msg.from.name ? `${msg.from.name} <${msg.from.email}>` : msg.from.email;
	const body = (msg.text || msg.snippet || '').slice(0, 800);
	return `${index + 1}. From: ${from}\nSubject: ${msg.subject}\n${body}`;
}

// Rules first (zero model cost), everything left over goes to the
// email-triage skill in batches of 8. Returns one triage record per input
// message, in the same order, each shaped
// { message, category, summary, action, due, priority, event }.
async function triage(messages, chat) {
	const results = new Array(messages.length);
	const needsModel = [];

	messages.forEach((msg, i) => {
		if (isMeeting(msg)) {
			const event = parseIcsEvent(msg.ics);
			results[i] = { message: msg, category: 'meeting', summary: event.title || msg.subject, action: null, due: null, priority: 'medium', event };
		} else if (isFinance(msg)) {
			results[i] = { message: msg, category: 'finance', summary: msg.subject, action: null, due: null, priority: 'medium', event: null, finance: extractFinanceDetails(msg) };
		} else if (isSystem(msg)) {
			results[i] = { message: msg, category: 'system', summary: msg.subject, action: null, due: null, priority: 'low', event: null };
		} else if (isNewsletter(msg)) {
			results[i] = { message: msg, category: 'newsletter', summary: msg.subject, action: null, due: null, priority: 'low', event: null };
		} else {
			needsModel.push(i);
		}
	});

	for (let i = 0; i < needsModel.length; i += EMAIL_TRIAGE_BATCH_SIZE) {
		const batchIdx = needsModel.slice(i, i + EMAIL_TRIAGE_BATCH_SIZE);
		const listing = batchIdx.map((idx, j) => formatMessageForModel(messages[idx], j)).join('\n\n---\n\n');
		let items = [];
		try {
			const parsed = await skills.runFast('email-triage', listing, chat);
			if (Array.isArray(parsed.items)) items = parsed.items;
		} catch {
			items = []; // fall through to the per-item default below
		}
		batchIdx.forEach((idx, j) => {
			const r = items[j];
			results[idx] = {
				message: messages[idx],
				category: r && r.category ? r.category : 'office',
				summary: (r && r.summary) || messages[idx].subject,
				action: (r && r.action) || null,
				due: (r && r.due) || null,
				priority: (r && r.priority) || 'low',
				event: (r && r.event) || null,
			};
		});
	}

	return results;
}

// Groups triaged items by category in the spec's fixed display order,
// omitting empty categories.
function groupByCategory(triaged) {
	const groups = {};
	for (const item of triaged) {
		(groups[item.category] = groups[item.category] || []).push(item);
	}
	return CATEGORY_ORDER.filter((c) => groups[c] && groups[c].length > 0).map((c) => ({
		category: c,
		label: CATEGORY_LABELS[c],
		items: groups[c],
	}));
}

// ---- Auto-actions (third pipeline stage) -------------------------------

// transactions -> Google Sheets when FINANCE_AUTO_LOG=1; .ics invites ->
// Radicale when DIGEST_AUTO_CALENDAR=1. Mutates and returns `triaged`,
// adding autoLogged/autoLogError or autoCalendared/autoCalendarError per
// item so the caller can render "✅ dicatat" / "✅ di kalender" or fall
// back to the manual button.
//
// `logTransaction` is injected rather than hard-wired to a real Sheets
// client: docs/V2-SPEC.md §3 (the finance ledger itself) is a separate,
// later round not yet built in this codebase. Passing none simply means
// FINANCE_AUTO_LOG has nothing to log to yet — that surfaces as
// autoLogError, exactly like any other auto-action that couldn't complete,
// never as a silent no-op.
async function autoActions(triaged, { logTransaction, pushEvent = radicale.pushEvent } = {}) {
	const autoLog = env.FINANCE_AUTO_LOG === '1';
	const autoCalendar = env.DIGEST_AUTO_CALENDAR === '1';

	for (const item of triaged) {
		if (item.category === 'finance' && autoLog) {
			try {
				if (!logTransaction) throw new Error('Finance auto-log is not configured yet');
				await logTransaction(item);
				item.autoLogged = true;
			} catch (err) {
				item.autoLogError = err.message;
			}
		}
		if (item.category === 'meeting' && autoCalendar && item.message.ics) {
			try {
				await pushEvent(`digest-${item.message.provider}-${item.message.id}@telegram-idea-bridge`, item.message.ics);
				item.autoCalendared = true;
			} catch (err) {
				// Radicale only exists on the office PC — must degrade to the
				// manual 📅 Tambah button, never fail the whole digest.
				item.autoCalendarError = err.message;
			}
		}
	}
	return triaged;
}

module.exports = {
	triage,
	groupByCategory,
	autoActions,
	parseIcsEvent,
	extractFinanceDetails,
	parseRupiah,
	isMeeting,
	isFinance,
	isSystem,
	isNewsletter,
	CATEGORY_ORDER,
	CATEGORY_LABELS,
};
