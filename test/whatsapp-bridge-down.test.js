const { test } = require('node:test');
const assert = require('node:assert');

process.env.WHATSAPP_GROUP_ID = 'test-group';
const whatsapp = require('../lib/whatsapp');

test.after(() => {
	delete process.env.WHATSAPP_GROUP_ID;
});

test('a down bridge (HTML error page, res.ok false) fails with a clear message, not a JSON parse error', async (t) => {
	t.mock.method(global, 'fetch', async () => ({
		ok: false,
		status: 502,
		json: async () => {
			throw new SyntaxError('Unexpected token < in JSON at position 0');
		},
	}));

	await assert.rejects(() => whatsapp.sendToGroup('hello'), /WhatsApp bridge is down \(HTTP 502\)/);
});

test('a 200 with success:false surfaces the bridge\'s own error, not a generic one', async (t) => {
	t.mock.method(global, 'fetch', async () => ({
		ok: true,
		status: 200,
		json: async () => ({ success: false, error: 'WhatsApp session not connected' }),
	}));

	await assert.rejects(() => whatsapp.sendToGroup('hello'), /WhatsApp session not connected/);
});

test('a genuine success resolves with the bridge response', async (t) => {
	t.mock.method(global, 'fetch', async () => ({
		ok: true,
		status: 200,
		json: async () => ({ success: true, messageId: 'abc' }),
	}));

	const result = await whatsapp.sendToGroup('hello');
	assert.deepStrictEqual(result, { success: true, messageId: 'abc' });
});

// --- checkConnection() — /status's "hermes" row ---------------------------

test('checkConnection: any HTTP response at all means the bridge process is up, even a 404', async (t) => {
	t.mock.method(global, 'fetch', async () => ({ ok: false, status: 404 }));
	const result = await whatsapp.checkConnection();
	assert.strictEqual(result.ok, true);
});

test('checkConnection: a connection failure (process not running) is reported by message', async (t) => {
	t.mock.method(global, 'fetch', async () => {
		throw new Error('fetch failed: ECONNREFUSED');
	});
	const result = await whatsapp.checkConnection();
	assert.strictEqual(result.ok, false);
	assert.match(result.reason, /ECONNREFUSED/);
});
