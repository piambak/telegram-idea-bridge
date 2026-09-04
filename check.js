// Self-check for the routing layer. Run: node check.js
// No framework — asserts only. Exits non-zero on failure.
const assert = require('assert');
const { MODELS, DEFAULT_MODEL, parseModelOverride } = require('./lib/models');

// --- model registry -------------------------------------------------------
assert.ok(MODELS[DEFAULT_MODEL], `DEFAULT_MODEL "${DEFAULT_MODEL}" must exist in MODELS`);
for (const [alias, m] of Object.entries(MODELS)) {
	assert.strictEqual(typeof m.chat, 'function', `${alias}.chat must be a function`);
	assert.ok(m.label, `${alias} must have a label`);
}
assert.ok(!('grok' in MODELS), 'grok was removed (no API key, no free tier)');
assert.ok(!('nvidia' in MODELS), 'nvidia was removed (unreachable, 45s timeout)');

// --- override parsing -----------------------------------------------------
assert.deepStrictEqual(parseModelOverride('groq: hello'), { modelKey: 'groq', rest: 'hello' });
assert.deepStrictEqual(parseModelOverride('GROQ: hello'), { modelKey: 'groq', rest: 'hello' });
// Unknown alias must NOT be stripped — ordinary prose with a colon.
assert.deepStrictEqual(parseModelOverride('Note: buy milk'), { modelKey: DEFAULT_MODEL, rest: 'Note: buy milk' });
// A removed alias is now ordinary prose, not a route.
assert.deepStrictEqual(parseModelOverride('grok: hi'), { modelKey: DEFAULT_MODEL, rest: 'grok: hi' });
// Multi-line body survives the split.
assert.deepStrictEqual(parseModelOverride('groq: a\nb'), { modelKey: 'groq', rest: 'a\nb' });

// --- HTML safety: every user-facing string must be Telegram-HTML-parseable --
// sendMessage() uses parse_mode:'HTML'; a raw <brief> is rejected by Telegram
// and the message silently never arrives.
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, 'bridge.js'), 'utf8');
const ALLOWED = new Set(['b', 'i', 'u', 's', 'a', 'code', 'pre', 'br']);
const offenders = [];
for (const line of src.split('\n')) {
	if (!line.includes('sendMessage(')) continue;
	for (const [, tag] of line.matchAll(/<\/?([a-zA-Z][\w-]*)[\s>]/g)) {
		if (!ALLOWED.has(tag.toLowerCase())) offenders.push(`${tag}: ${line.trim()}`);
	}
}
assert.deepStrictEqual(offenders, [], `unescaped non-HTML tags in sendMessage:\n${offenders.join('\n')}`);

console.log('check.js: all assertions passed');
