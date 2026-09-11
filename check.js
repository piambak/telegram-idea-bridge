// Self-check for the routing layer. Run: node check.js
// No framework — asserts only. Exits non-zero on failure.
const assert = require('assert');
const { MODELS, DEFAULT_MODEL, JOB_MODELS, modelForJob, parseModelOverride, makeOpenAICompatChat } = require('./lib/models');

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

// --- per-job model defaults (JOB_MODELS) ------------------------------
for (const [job, alias] of Object.entries(JOB_MODELS)) {
	assert.ok(MODELS[alias], `JOB_MODELS.${job} points at "${alias}", which is not a registered model`);
}
assert.strictEqual(modelForJob('regcheck'), 'ollamacloud', 'regcheck should use the steady single provider');
assert.strictEqual(modelForJob('no-such-job'), DEFAULT_MODEL, 'unknown job falls back to the default');
assert.strictEqual(modelForJob(undefined), DEFAULT_MODEL, 'missing job falls back to the default');
// An explicit prefix must beat the per-job default, or overrides are useless.
assert.strictEqual(parseModelOverride('openrouter: x', 'regcheck').modelKey, 'openrouter');
assert.strictEqual(parseModelOverride('plain text', 'regcheck').modelKey, 'ollamacloud');

// --- retry classification --------------------------------------------
// Retrying a 401 just delays a clear error; not retrying a 503 loses a
// job to a transient blip. Both directions matter, so both are asserted
// against a local fake server in the async block below.
const http = require('http');
(async () => {
	const { env } = require('./lib/config');
	env.__CHECK_KEY = 'testkey';
	const hits = { flaky: 0, auth: 0 };
	const srv = http.createServer((req, res) => {
		if (req.url.includes('flaky')) {
			hits.flaky++;
			if (hits.flaky < 3) {
				res.writeHead(503);
				return res.end('high demand');
			}
			res.writeHead(200, { 'Content-Type': 'application/json' });
			return res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
		}
		hits.auth++;
		res.writeHead(401);
		res.end('invalid api key');
	});
	await new Promise((r) => srv.listen(0, '127.0.0.1', r));
	const base = `http://127.0.0.1:${srv.address().port}`;
	const opts = { model: 'm', apiKeyEnv: '__CHECK_KEY' };
	const flaky = makeOpenAICompatChat({ baseUrl: base + '/flaky', ...opts });
	const auth = makeOpenAICompatChat({ baseUrl: base + '/auth', ...opts });

	assert.strictEqual(await flaky([{ role: 'user', content: 'hi' }]), 'ok');
	assert.strictEqual(hits.flaky, 3, `503 should be retried twice then succeed (got ${hits.flaky})`);
	await assert.rejects(() => auth([{ role: 'user', content: 'hi' }]), /401/);
	assert.strictEqual(hits.auth, 1, `401 must not be retried (got ${hits.auth})`);
	srv.close();

	// --- scraper breakage is distinguishable from quiet news -------------
	const regmonitor = require('./lib/regmonitor');
	const realFetch = global.fetch;
	global.fetch = async () => ({ ok: true, status: 200, text: async () => '<html><body>redesigned</body></html>' });
	await assert.rejects(
		() => regmonitor.fetchLatest(),
		(e) => e.name === 'ScrapeError',
		'a 200 response matching nothing must raise ScrapeError, not look like an empty result',
	);
	global.fetch = realFetch;

	console.log('check.js: all assertions passed');
})();
