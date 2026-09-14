const { test } = require('node:test');
const assert = require('node:assert');

const digest = require('../lib/digest');

test('parseIcsEvent: DTSTART/DTEND with TZID=Asia/Jakarta resolves against WIB (UTC+7), not treated as already-UTC', () => {
	const ics = [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'BEGIN:VEVENT',
		'UID:1@example.com',
		'DTSTART;TZID=Asia/Jakarta:20260918T140000',
		'DTEND;TZID=Asia/Jakarta:20260918T150000',
		'SUMMARY:Rapat evaluasi kuartal',
		'LOCATION:Ruang 305',
		'END:VEVENT',
		'END:VCALENDAR',
	].join('\r\n');

	const event = digest.parseIcsEvent(ics);

	assert.strictEqual(event.title, 'Rapat evaluasi kuartal');
	assert.strictEqual(event.location, 'Ruang 305');
	// 14:00 WIB (UTC+7) == 07:00 UTC
	assert.strictEqual(event.start, new Date('2026-09-18T07:00:00.000Z').toISOString());
	assert.strictEqual(event.end, new Date('2026-09-18T08:00:00.000Z').toISOString());
});

test('parseIcsEvent: a trailing Z is already UTC, no TZID offset applied', () => {
	const ics = ['BEGIN:VEVENT', 'DTSTART:20260918T070000Z', 'DTEND:20260918T080000Z', 'SUMMARY:UTC meeting', 'END:VEVENT'].join('\r\n');
	const event = digest.parseIcsEvent(ics);
	assert.strictEqual(event.start, new Date('2026-09-18T07:00:00.000Z').toISOString());
});

test('parseIcsEvent: an all-day event (VALUE=DATE) has no time-of-day component', () => {
	const ics = ['BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20261225', 'DTEND;VALUE=DATE:20261226', 'SUMMARY:Libur Natal', 'END:VEVENT'].join('\r\n');
	const event = digest.parseIcsEvent(ics);
	assert.strictEqual(event.start, new Date('2026-12-25T00:00:00.000Z').toISOString());
	assert.strictEqual(event.end, new Date('2026-12-26T00:00:00.000Z').toISOString());
});

test('parseIcsEvent: a different known TZID (Asia/Makassar, UTC+8) resolves correctly', () => {
	const ics = ['BEGIN:VEVENT', 'DTSTART;TZID=Asia/Makassar:20260918T090000', 'SUMMARY:Makassar call', 'END:VEVENT'].join('\r\n');
	const event = digest.parseIcsEvent(ics);
	// 09:00 UTC+8 == 01:00 UTC
	assert.strictEqual(event.start, new Date('2026-09-18T01:00:00.000Z').toISOString());
});

test('parseIcsEvent: unfolds a long SUMMARY line split across continuation lines (RFC 5545 folding)', () => {
	const ics = [
		'BEGIN:VEVENT',
		'DTSTART:20260918T070000Z',
		'SUMMARY:This is a very long meeting title that a real calendar client ',
		' would fold across multiple physical lines per RFC 5545',
		'END:VEVENT',
	].join('\r\n');
	const event = digest.parseIcsEvent(ics);
	assert.strictEqual(event.title, 'This is a very long meeting title that a real calendar client would fold across multiple physical lines per RFC 5545');
});

test('parseIcsEvent: unescapes \\n, \\, and \\; in text fields', () => {
	const ics = [
		'BEGIN:VEVENT',
		'DTSTART:20260918T070000Z',
		'SUMMARY:Rapat\\, evaluasi\\; Q3',
		'DESCRIPTION:Line one\\nLine two',
		'END:VEVENT',
	].join('\r\n');
	const event = digest.parseIcsEvent(ics);
	assert.strictEqual(event.title, 'Rapat, evaluasi; Q3');
	assert.strictEqual(event.description, 'Line one\nLine two');
});

test('parseIcsEvent: only reads the first VEVENT, ignores anything after END:VEVENT', () => {
	const ics = [
		'BEGIN:VEVENT',
		'DTSTART:20260918T070000Z',
		'SUMMARY:First event',
		'END:VEVENT',
		'BEGIN:VEVENT',
		'DTSTART:20261001T070000Z',
		'SUMMARY:Second event (should be ignored)',
		'END:VEVENT',
	].join('\r\n');
	const event = digest.parseIcsEvent(ics);
	assert.strictEqual(event.title, 'First event');
});

test('parseIcsEvent: an unrecognized TZID falls back to treating local time as UTC (honest, not a silent wrong-zone guess)', () => {
	const ics = ['BEGIN:VEVENT', 'DTSTART;TZID=Antarctica/Vostok:20260918T070000', 'SUMMARY:Unusual zone', 'END:VEVENT'].join('\r\n');
	const event = digest.parseIcsEvent(ics);
	assert.strictEqual(event.start, new Date('2026-09-18T07:00:00.000Z').toISOString());
});
