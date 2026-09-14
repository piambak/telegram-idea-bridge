const { test } = require('node:test');
const assert = require('node:assert');

const status = require('../lib/status');
const models = require('../lib/models');
const claude = require('../lib/claude');
const googleAuth = require('../lib/google/auth');
const outlook = require('../lib/mail/outlook');
const imap = require('../lib/mail/imap');
const radicale = require('../lib/radicale');
const whatsapp = require('../lib/whatsapp');
const vaultsync = require('../lib/vaultsync');

const NAMES = ['Groq', 'OpenRouter', 'Ollama Cloud', 'Gemini', 'Claude CLI', 'Google token', 'Microsoft token', 'IMAP', 'Radicale', 'hermes', 'Vault mirror'];

function stubAllOk(t) {
	t.mock.method(models, 'groqChat', async () => 'pong');
	t.mock.method(models, 'openrouterChat', async () => 'pong');
	t.mock.method(models, 'ollamacloudChat', async () => 'pong');
	t.mock.method(models.MODELS.gemini, 'chat', async () => 'pong');
	t.mock.method(claude, 'version', async () => '2.0.0');
	t.mock.method(googleAuth, 'status', async () => ({ connected: true, ok: true, message: 'token OK' }));
	t.mock.method(outlook, 'status', async () => ({ connected: true, ok: true, message: 'token OK' }));
	t.mock.method(imap, 'checkConnection', async () => ({ ok: true }));
	t.mock.method(radicale, 'checkConnection', async () => ({ ok: true }));
	t.mock.method(whatsapp, 'checkConnection', async () => ({ ok: true }));
	t.mock.method(vaultsync, 'checkConnection', async () => ({ ok: true }));
}

test('checkAll(): returns one entry per service, in a fixed order', async (t) => {
	stubAllOk(t);
	const results = await status.checkAll();
	assert.deepStrictEqual(results.map((r) => r.name), NAMES);
});

test('checkAll(): all reachable -> every entry ok:true with no reason', async (t) => {
	stubAllOk(t);
	const results = await status.checkAll();
	for (const r of results) {
		assert.strictEqual(r.ok, true, `${r.name} should be ok`);
		assert.strictEqual(r.reason, null);
	}
});

test('checkAll(): a mix of ok/not-ok services each report their own reason independently', async (t) => {
	stubAllOk(t);
	t.mock.method(models, 'groqChat', async () => {
		throw new Error('Not configured yet — set GROQ_API_KEY.');
	});
	t.mock.method(radicale, 'checkConnection', async () => ({ ok: false, reason: 'fetch failed: ECONNREFUSED' }));

	const results = await status.checkAll();
	const byName = Object.fromEntries(results.map((r) => [r.name, r]));

	assert.strictEqual(byName.Groq.ok, false);
	assert.match(byName.Groq.reason, /GROQ_API_KEY/);
	assert.strictEqual(byName.Radicale.ok, false);
	assert.match(byName.Radicale.reason, /ECONNREFUSED/);
	// Everything else stayed ok — one bad service must not drag the others down.
	assert.strictEqual(byName.OpenRouter.ok, true);
	assert.strictEqual(byName['Vault mirror'].ok, true);
});

test('checkAll(): a check that throws unexpectedly (not just a clean {ok:false}) is still caught and reported', async (t) => {
	stubAllOk(t);
	t.mock.method(claude, 'version', async () => {
		throw new Error('ENOENT: claude is not recognized');
	});

	const results = await status.checkAll();
	const claudeResult = results.find((r) => r.name === 'Claude CLI');
	assert.strictEqual(claudeResult.ok, false);
	assert.match(claudeResult.reason, /ENOENT/);
});

test('checkAll(): a token status() with ok:false surfaces its message as the reason', async (t) => {
	stubAllOk(t);
	t.mock.method(googleAuth, 'status', async () => ({ connected: true, ok: false, message: 'invalid_grant — the token was revoked' }));

	const results = await status.checkAll();
	const googleResult = results.find((r) => r.name === 'Google token');
	assert.strictEqual(googleResult.ok, false);
	assert.match(googleResult.reason, /invalid_grant/);
});
