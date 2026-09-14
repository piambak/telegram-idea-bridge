const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const AGENTS_DIR = path.join(__dirname, '..', '.claude', 'agents');

const EXPECTED_AGENTS = [
	'long-doc-summarizer',
	'research-capturer',
	'office-doc-drafter',
	'spreadsheet-builder',
	'regulation-analyst',
	'vault-curator',
	'vision-math-reader',
];

// Same flat frontmatter shape as lib/skills.js's parser — a `tools` line here
// is `[A, B, C]`, parsed as a plain comma list rather than real YAML.
function parseAgentFile(name) {
	const raw = fs.readFileSync(path.join(AGENTS_DIR, `${name}.md`), 'utf8');
	const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	assert.ok(match, `${name}.md should have --- frontmatter`);
	const meta = {};
	for (const line of match[1].split(/\r?\n/)) {
		const eq = line.indexOf(':');
		if (eq === -1) continue;
		const key = line.slice(0, eq).trim();
		let value = line.slice(eq + 1).trim();
		if (/^\[.*\]$/.test(value)) {
			meta[key] = value
				.slice(1, -1)
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean);
		} else if (value === 'true' || value === 'false') {
			meta[key] = value === 'true';
		} else if (value !== '' && !Number.isNaN(Number(value))) {
			meta[key] = Number(value);
		} else {
			meta[key] = value;
		}
	}
	return { meta, body: match[2].trim() };
}

test('every expected agent file exists with the required frontmatter fields', () => {
	const found = fs.readdirSync(AGENTS_DIR).map((f) => f.replace(/\.md$/, ''));
	assert.deepStrictEqual(new Set(found), new Set(EXPECTED_AGENTS));

	for (const name of EXPECTED_AGENTS) {
		const { meta, body } = parseAgentFile(name);
		assert.strictEqual(meta.name, name);
		assert.ok(meta.description, `${name} needs a description`);
		assert.ok(meta.model, `${name} needs a fixed model`);
		assert.ok(Array.isArray(meta.tools), `${name}'s tools should be a [..] list, even if empty`);
		assert.ok(Number.isInteger(meta.maxTurns) && meta.maxTurns > 0, `${name} needs a positive integer maxTurns`);
		assert.ok(meta.permissionMode, `${name} needs a permissionMode`);
		assert.ok(body.length > 0, `${name} should have instructions in its body`);
	}
});

test('no agent ever gets Bash — an unattended run must never get a shell', () => {
	for (const name of EXPECTED_AGENTS) {
		const { meta } = parseAgentFile(name);
		assert.ok(!meta.tools.includes('Bash'), `${name} must not have Bash in its tool allowlist`);
	}
});

test('every agent is dontAsk except vault-curator, which is acceptEdits for its one unattended write', () => {
	for (const name of EXPECTED_AGENTS) {
		const { meta } = parseAgentFile(name);
		const expected = name === 'vault-curator' ? 'acceptEdits' : 'dontAsk';
		assert.strictEqual(meta.permissionMode, expected, `${name} should be permissionMode: ${expected}`);
	}
});

test('only vault-curator has Write access; the rest are read/analyze-only', () => {
	for (const name of EXPECTED_AGENTS) {
		const { meta } = parseAgentFile(name);
		const hasWrite = meta.tools.includes('Write') || meta.tools.includes('Edit');
		assert.strictEqual(hasWrite, name === 'vault-curator', `${name}'s Write/Edit access should only be true for vault-curator`);
	}
});
