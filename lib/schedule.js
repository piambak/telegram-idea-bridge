const crypto = require('crypto');

const WIB_OFFSET_HOURS = 7; // Asia/Jakarta, no DST

function nowInWib() {
	const utc = new Date();
	return new Date(utc.getTime() + WIB_OFFSET_HOURS * 3600 * 1000);
}

function formatWib(d) {
	return d.toISOString().slice(0, 16).replace('T', ' ') + ' WIB';
}

const PARSE_PROMPT_TEMPLATE = (nowWibStr) => `You extract calendar event details from freeform text.
The current date/time is ${nowWibStr} (WIB, UTC+7). Respond with ONLY a JSON object, no code
fences, no explanation, in exactly this shape:
{"title": "...", "start": "YYYY-MM-DDTHH:MM", "end": "YYYY-MM-DDTHH:MM", "location": "...", "description": "..."}
"start" and "end" are in WIB local time (24h). If no duration is given, make the event 1 hour long.
If no location is mentioned, use an empty string. Resolve relative dates ("tomorrow", "next Monday")
against the current date/time given above.`;

function extractJson(text) {
	const match = text.match(/\{[\s\S]*\}/);
	if (!match) throw new Error('Could not parse event details from that');
	return JSON.parse(match[0]);
}

async function parseEvent(text, chat) {
	const nowWibStr = formatWib(nowInWib());
	const reply = await chat([
		{ role: 'system', content: PARSE_PROMPT_TEMPLATE(nowWibStr) },
		{ role: 'user', content: text },
	]);
	const parsed = extractJson(reply);
	if (!parsed.title || !parsed.start || !parsed.end) throw new Error('Missing title, start, or end time');
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

module.exports = { parseEvent, buildIcs, nowInWib, formatWib };
