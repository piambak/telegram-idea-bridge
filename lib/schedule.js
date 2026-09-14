const crypto = require('crypto');

const WIB_OFFSET_HOURS = 7; // Asia/Jakarta, no DST
const WEEKDAYS_ID = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
// Below this, handleSchedule holds off pushing to Radicale and asks for
// confirmation instead (docs/ANALYSIS.md §6, event-parse).
const CONFIRM_BELOW_CONFIDENCE = 0.8;

function nowInWib() {
	const utc = new Date();
	return new Date(utc.getTime() + WIB_OFFSET_HOURS * 3600 * 1000);
}

function formatWib(d) {
	return d.toISOString().slice(0, 16).replace('T', ' ') + ' WIB';
}

// nowInWib() already shifted the timestamp by the WIB offset, so reading it
// back with the UTC getters gives WIB wall-clock fields, weekday included.
function weekdayWib(d) {
	return WEEKDAYS_ID[d.getUTCDay()];
}

const PARSE_PROMPT_TEMPLATE = (nowWibStr, weekday) => `You extract calendar event details from freeform text.
The current date/time is ${weekday}, ${nowWibStr} (WIB, UTC+7). Respond with ONLY a JSON object, no code
fences, no explanation, in exactly this shape:
{"title": "...", "start": "YYYY-MM-DDTHH:MM", "end": "YYYY-MM-DDTHH:MM", "location": "...", "description": "...", "confidence": 0.0}
"start" and "end" are in WIB local time (24h). If no duration is given, make the event 1 hour long.
If no location is mentioned, use an empty string. Resolve relative dates ("tomorrow", "next Monday",
"Jumat depan") against the current date/time AND WEEKDAY given above — you are told today's weekday
precisely so "next <day>" is never a guess. "confidence" is a number from 0 to 1 for how sure you are
about the resolved date/time: lower it for ambiguous phrasing, a day-of-week that doesn't map cleanly
to one date, or a missing year/time. Reply in the same language as the input for "title"/"description".`;

function extractJson(text) {
	const match = text.match(/\{[\s\S]*\}/);
	if (!match) throw new Error('Could not parse event details from that');
	return JSON.parse(match[0]);
}

async function parseEvent(text, chat) {
	const now = nowInWib();
	const reply = await chat([
		{ role: 'system', content: PARSE_PROMPT_TEMPLATE(formatWib(now), weekdayWib(now)) },
		{ role: 'user', content: text },
	]);
	const parsed = extractJson(reply);
	if (!parsed.title || !parsed.start || !parsed.end) throw new Error('Missing title, start, or end time');
	// A model that omits the field (e.g. the OpenRouter fallback ignoring an
	// instruction) is treated as confident, not as automatically uncertain —
	// this field only ever makes the flow MORE cautious, never less.
	if (typeof parsed.confidence !== 'number' || Number.isNaN(parsed.confidence)) parsed.confidence = 1;
	return parsed;
}

function wibLocalToUtcDate(wibLocalStr) {
	// wibLocalStr like "2026-09-05T14:00" is WIB local time; convert to a
	// real UTC Date by treating it as UTC then subtracting the WIB offset.
	const asUtc = new Date(`${wibLocalStr}:00Z`);
	return new Date(asUtc.getTime() - WIB_OFFSET_HOURS * 3600 * 1000);
}

function toIcsUtcStamp(date) {
	return date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
}

function escapeIcsText(s) {
	return String(s || '').replace(/\\/g, '\\\\').replace(/,/g, '\\,').replace(/;/g, '\\;').replace(/\n/g, '\\n');
}

function buildIcs({ title, start, end, location, description }) {
	const startUtc = wibLocalToUtcDate(start);
	const endUtc = wibLocalToUtcDate(end);
	const uid = `${crypto.randomUUID()}@telegram-idea-bridge`;
	return [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//telegram-idea-bridge//EN',
		'BEGIN:VEVENT',
		`UID:${uid}`,
		`DTSTAMP:${toIcsUtcStamp(new Date())}`,
		`DTSTART:${toIcsUtcStamp(startUtc)}`,
		`DTEND:${toIcsUtcStamp(endUtc)}`,
		`SUMMARY:${escapeIcsText(title)}`,
		`LOCATION:${escapeIcsText(location)}`,
		`DESCRIPTION:${escapeIcsText(description)}`,
		'END:VEVENT',
		'END:VCALENDAR',
		'',
	].join('\r\n');
}

module.exports = { parseEvent, buildIcs, nowInWib, formatWib, weekdayWib, CONFIRM_BELOW_CONFIDENCE };
