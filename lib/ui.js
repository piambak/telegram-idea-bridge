const telegram = require('./telegram');

function escapeHtml(s) {
	return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const SEND_MAX = 3900; // a safe margin under Telegram's 4096-char cap

// Splits `html` into chunks under `max` chars, breaking at blank-line
// (paragraph) boundaries so a chunk never cuts a sentence in half. A single
// paragraph bigger than `max` on its own is hard-split — a reply must never
// be silently dropped, however it ends up split (docs/V2-SPEC.md §1: "never
// truncated, never a message-too-long error"; docs/ANALYSIS.md bug #3).
function splitParas(html, max = SEND_MAX) {
	const paras = String(html).split('\n\n');
	const parts = [];
	let buf = '';
	const flush = () => {
		if (buf) parts.push(buf);
		buf = '';
	};
	for (const para of paras) {
		if (para.length > max) {
			flush();
			for (let i = 0; i < para.length; i += max) parts.push(para.slice(i, i + max));
			continue;
		}
		const candidate = buf ? `${buf}\n\n${para}` : para;
		if (candidate.length > max) {
			flush();
			buf = para;
		} else {
			buf = candidate;
		}
	}
	flush();
	return parts.length ? parts : [''];
}

// Sends `html`, splitting across multiple messages when it's too long for
// one. `extra` (e.g. a reply_markup) is only attached to the last part —
// buttons on an earlier part would be confusing once a later part exists.
async function send(chatId, html, extra) {
	const parts = splitParas(html);
	let result;
	for (let i = 0; i < parts.length; i++) {
		const isLast = i === parts.length - 1;
		result = await telegram.sendMessage(chatId, parts[i], isLast ? extra : undefined);
	}
	return result;
}

// Posts a placeholder once and returns handles to update it in place —
// "progress in place" (docs/V2-SPEC.md §1): no more a status message plus a
// separate result message. update() can be called repeatedly for
// multi-phase jobs (e.g. /pdf's lookup -> download -> summarize); finish()
// is the terminal call and still never truncates a long result — if it
// doesn't fit in one message, the placeholder becomes the first part and
// the rest follow as new messages.
async function progress(chatId, placeholderHtml) {
	const msg = await telegram.sendMessage(chatId, placeholderHtml);

	async function update(html, extra) {
		return telegram.editMessageText(chatId, msg.message_id, html, extra);
	}

	async function finish(html, extra) {
		const parts = splitParas(html);
		await telegram.editMessageText(chatId, msg.message_id, parts[0], parts.length === 1 ? extra : undefined);
		for (let i = 1; i < parts.length; i++) {
			const isLast = i === parts.length - 1;
			await telegram.sendMessage(chatId, parts[i], isLast ? extra : undefined);
		}
	}

	return { messageId: msg.message_id, update, finish };
}

// Above this, a blockquote body renders collapsed-with-expand in Telegram's
// client rather than always full height.
const BODY_EXPANDABLE_THRESHOLD = 300;

// The one card shape every reply is built from (docs/V2-SPEC.md §1):
//   💡 <b>Title</b>              icon + bold title
//   <i>subtitle</i>              muted subtitle (e.g. "#tag1 #tag2")
//   <blockquote>body</blockquote>   expandable once it's long
//   <b>Section label</b>
//   ▸ item                       bullets
//   <i>footer</i>                muted footer (e.g. "💾 notes/x.md")
// All fields are raw/unescaped text — card() does the escaping, so callers
// never hand-build HTML (and can't forget to escape something).
function card({ icon, title, subtitle, body, sections = [], footer } = {}) {
	const lines = [];
	if (title) lines.push(icon ? `${icon} <b>${escapeHtml(title)}</b>` : `<b>${escapeHtml(title)}</b>`);
	if (subtitle) lines.push(`<i>${escapeHtml(subtitle)}</i>`);
	if (body) {
		const escaped = escapeHtml(body);
		const openTag = escaped.length > BODY_EXPANDABLE_THRESHOLD ? '<blockquote expandable>' : '<blockquote>';
		lines.push(`${openTag}${escaped}</blockquote>`);
	}
	for (const section of sections) {
		if (section.label) lines.push(`<b>${escapeHtml(section.label)}</b>`);
		for (const item of section.items || []) lines.push(`▸ ${escapeHtml(item)}`);
	}
	if (footer) lines.push(`<i>${escapeHtml(footer)}</i>`);
	return lines.join('\n');
}

// A row of filled/empty blocks for a 0-1 fraction — category shares in
// reports, read/unread counts, etc. (docs/V2-SPEC.md §1).
function progressBar(fraction, width = 5) {
	const clamped = Math.max(0, Math.min(1, Number(fraction) || 0));
	const filled = Math.round(clamped * width);
	return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}

// A collapsed-by-default section for low-signal groups (newsletters, system
// notifications) — always expandable regardless of length, since hiding it
// by default is the point, not just handling overflow (docs/V2-SPEC.md §1).
function quietSection(label, items) {
	const body = (items || []).map((item) => `▸ ${escapeHtml(item)}`).join('\n');
	return `<blockquote expandable><b>${escapeHtml(label)}</b>\n${body}</blockquote>`;
}

// Builds a reply_markup for an inline keyboard from
// [[{text, callback_data}, ...], ...] rows — a thin, testable wrapper so
// call sites don't hand-build the Bot API shape themselves.
function keyboard(rows) {
	return { inline_keyboard: rows };
}

module.exports = { escapeHtml, splitParas, send, progress, card, progressBar, quietSection, keyboard, SEND_MAX };
