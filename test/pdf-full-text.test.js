const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// OPENKNOWLEDGE_DIR must be set before lib/config (and therefore lib/knowledge)
// is first required, so writes land in a tmp dir, never the real vault.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-bridge-pdf-'));
process.env.OPENKNOWLEDGE_DIR = tmpRoot;

const knowledge = require('../lib/knowledge');

test.after(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	delete process.env.OPENKNOWLEDGE_DIR;
});

test('short extracted text is saved inline, in full, no sidecar', () => {
	const text = 'A short PDF excerpt.\n'.repeat(20); // well under the inline limit
	const { filePath, sidecarPath } = knowledge.writeSourceCapture({
		title: 'Short Doc',
		sourceUrl: 'https://example.com/short.pdf',
		tags: [],
		extractedText: text,
		summary: null,
		notes: '',
	});

	assert.strictEqual(sidecarPath, null);
	const note = fs.readFileSync(filePath, 'utf8');
	assert.ok(note.includes(text.trim()), 'the full text should be inline in the note');
});

test('long extracted text is saved in full via a sidecar .txt, not truncated to 6,000 chars', () => {
	// Bigger than the old silent 6,000-char cap from docs/ANALYSIS.md bug #4.
	const paragraph = 'Pasal demi pasal regulasi ini menjelaskan ketentuan secara rinci. ';
	const text = paragraph.repeat(500); // well over 6,000 chars
	assert.ok(text.length > 6000);

	const { filePath, sidecarPath } = knowledge.writeSourceCapture({
		title: 'Long Regulation',
		sourceUrl: 'https://example.com/long.pdf',
		tags: [],
		extractedText: text,
		summary: 'A short summary.',
		notes: '',
	});

	assert.ok(sidecarPath, 'a sidecar path should be returned for long text');
	assert.ok(fs.existsSync(sidecarPath));
	const sidecarContent = fs.readFileSync(sidecarPath, 'utf8');
	assert.strictEqual(sidecarContent, text.trim(), 'the sidecar must hold the COMPLETE text, not an excerpt');

	const note = fs.readFileSync(filePath, 'utf8');
	assert.ok(note.includes(path.basename(sidecarPath)), 'the note should point at the sidecar file');
	assert.ok(note.includes('A short summary.'));
});
