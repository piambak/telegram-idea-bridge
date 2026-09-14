const { test } = require('node:test');
const assert = require('node:assert');

const models = require('../lib/models');

// Stubs the global fetch every makeOpenAICompatChat call goes through and
// records the parsed request body for each call, so tests can assert on
// exactly what was sent without touching the network.
function mockFetch(t) {
	const calls = [];
	t.mock.method(global, 'fetch', async (url, opts) => {
		calls.push({ url: String(url), body: JSON.parse(opts.body) });
		return {
			ok: true,
			status: 200,
			json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
			text: async () => '',
		};
	});
	return calls;
}

test('params passed to chat() land in the request body', async (t) => {
	const calls = mockFetch(t);
	const params = { temperature: 0.2, max_tokens: 300, response_format: { type: 'json_object' } };

	const result = await models.MODELS.openrouter.chat([{ role: 'user', content: 'hi' }], { params });

	assert.strictEqual(result, 'ok');
	assert.strictEqual(calls.length, 1);
	assert.strictEqual(calls[0].body.temperature, 0.2);
	assert.strictEqual(calls[0].body.max_tokens, 300);
	assert.deepStrictEqual(calls[0].body.response_format, { type: 'json_object' });
});

test('params survive a retried attempt unchanged', async (t) => {
	let attempts = 0;
	t.mock.method(global, 'fetch', async (url, opts) => {
		attempts++;
		if (attempts === 1) return { ok: false, status: 503, text: async () => 'busy' };
		return {
			ok: true,
			status: 200,
			json: async () => ({ choices: [{ message: { content: String(JSON.parse(opts.body).temperature) } }] }),
			text: async () => '',
		};
	});

	const result = await models.MODELS.openrouter.chat([{ role: 'user', content: 'hi' }], { params: { temperature: 0.9 } });

	assert.strictEqual(attempts, 2, 'the 503 should have been retried once');
	assert.strictEqual(result, '0.9', 'the retried attempt should carry the same params as the first');
});

test('chat() with no params sends a clean body — no stray provider defaults leak in for gemini', async (t) => {
	const calls = mockFetch(t);
	await models.MODELS.gemini.chat([{ role: 'user', content: 'hi' }]);
	assert.deepStrictEqual(Object.keys(calls[0].body).sort(), ['messages', 'model']);
});

test('Groq (gpt-oss-120b) defaults to reasoning_effort: low', async (t) => {
	const calls = mockFetch(t);
	// MODELS.groq is a fallback chain; the mocked fetch succeeds on the first
	// try, so only groqChat (the gpt-oss-120b provider) is ever called.
	await models.MODELS.groq.chat([{ role: 'user', content: 'hi' }]);
	assert.strictEqual(calls.length, 1);
	assert.strictEqual(calls[0].url, 'https://api.groq.com/openai/v1/chat/completions');
	assert.strictEqual(calls[0].body.reasoning_effort, 'low');
});

test('an explicit reasoning_effort in params overrides the Groq default', async (t) => {
	const calls = mockFetch(t);
	await models.MODELS.groq.chat([{ role: 'user', content: 'hi' }], { params: { reasoning_effort: 'high' } });
	assert.strictEqual(calls[0].body.reasoning_effort, 'high');
});

test('other providers do not get reasoning_effort unless a caller asks for it', async (t) => {
	const calls = mockFetch(t);
	await models.MODELS.ollamacloud.chat([{ role: 'user', content: 'hi' }]);
	assert.strictEqual(calls[0].body.reasoning_effort, undefined);
});
