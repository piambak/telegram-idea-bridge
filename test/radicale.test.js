const { test } = require('node:test');
const assert = require('node:assert');

const { env } = require('../lib/config');
const radicale = require('../lib/radicale');

function withRadicaleEnv(t, overrides = {}) {
	const keys = ['RADICALE_URL', 'RADICALE_USER', 'RADICALE_PASSWORD'];
	const saved = {};
	for (const k of keys) saved[k] = env[k];
	Object.assign(env, { RADICALE_URL: 'http://127.0.0.1:5232', RADICALE_USER: 'me', RADICALE_PASSWORD: 'secret', ...overrides });
	t.after(() => {
		for (const k of keys) env[k] = saved[k];
	});
}

// --- checkConnection() — /status's "Radicale" row --------------------------

test('checkConnection: not configured is reported without ever calling fetch', async (t) => {
	withRadicaleEnv(t, { RADICALE_URL: undefined });
	t.mock.method(global, 'fetch', () => {
		throw new Error('must not call fetch when not configured');
	});
	const result = await radicale.checkConnection();
	assert.strictEqual(result.ok, false);
	assert.match(result.reason, /Not configured/);
});

test('checkConnection: a 2xx response from the collection root is reachable', async (t) => {
	withRadicaleEnv(t);
	t.mock.method(global, 'fetch', async (url, opts) => {
		assert.match(url, /^http:\/\/127\.0\.0\.1:5232\/me\//);
		assert.match(opts.headers.Authorization, /^Basic /);
		return { ok: true, status: 207 };
	});
	const result = await radicale.checkConnection();
	assert.strictEqual(result.ok, true);
});

test('checkConnection: a 401/403 is reachable-but-unauthenticated, distinct from unreachable', async (t) => {
	withRadicaleEnv(t);
	t.mock.method(global, 'fetch', async () => ({ ok: false, status: 401 }));
	const result = await radicale.checkConnection();
	assert.strictEqual(result.ok, false);
	assert.match(result.reason, /authentication failed/);
});

test('checkConnection: a network failure (server not running) is reported by message', async (t) => {
	withRadicaleEnv(t);
	t.mock.method(global, 'fetch', async () => {
		throw new Error('fetch failed: ECONNREFUSED');
	});
	const result = await radicale.checkConnection();
	assert.strictEqual(result.ok, false);
	assert.match(result.reason, /ECONNREFUSED/);
});
