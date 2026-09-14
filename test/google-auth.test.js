const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-bridge-gauth-'));
const auth = require('../lib/google/auth');
const { env } = require('../lib/config');

test.after(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function withGoogleEnv(t, overrides = {}) {
	const keys = ['GOOGLE_TOKEN_PATH', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'];
	const saved = {};
	for (const k of keys) saved[k] = env[k];
	Object.assign(env, { GOOGLE_CLIENT_ID: 'client-id', GOOGLE_CLIENT_SECRET: 'client-secret', ...overrides });
	t.after(() => {
		for (const k of keys) env[k] = saved[k];
	});
}

test('authUrl() includes all three required scopes, offline access, and forced consent (for a real refresh_token)', (t) => {
	withGoogleEnv(t);
	const url = new URL(auth.authUrl());
	assert.strictEqual(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
	assert.strictEqual(url.searchParams.get('client_id'), 'client-id');
	assert.strictEqual(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:53682/oauth2callback');
	assert.strictEqual(url.searchParams.get('access_type'), 'offline');
	assert.strictEqual(url.searchParams.get('prompt'), 'consent');
	const scopes = url.searchParams.get('scope').split(' ');
	assert.ok(scopes.includes('https://www.googleapis.com/auth/gmail.readonly'));
	assert.ok(scopes.includes('https://www.googleapis.com/auth/spreadsheets'));
	assert.ok(scopes.includes('https://www.googleapis.com/auth/tasks'));
});

test('authUrl() refuses to build a URL without GOOGLE_CLIENT_ID configured', (t) => {
	withGoogleEnv(t, { GOOGLE_CLIENT_ID: undefined });
	assert.throws(() => auth.authUrl(), /GOOGLE_CLIENT_ID/);
});

test('exchangeCode(): POSTs the authorization_code grant and writes the token file', async (t) => {
	const tokenFile = path.join(tmpRoot, 'exchange.json');
	withGoogleEnv(t, { GOOGLE_TOKEN_PATH: tokenFile });

	t.mock.method(global, 'fetch', async (url, opts) => {
		assert.strictEqual(url, 'https://oauth2.googleapis.com/token');
		const body = new URLSearchParams(opts.body);
		assert.strictEqual(body.get('grant_type'), 'authorization_code');
		assert.strictEqual(body.get('code'), 'one-time-code');
		assert.strictEqual(body.get('redirect_uri'), 'http://127.0.0.1:53682/oauth2callback');
		return { ok: true, json: async () => ({ access_token: 'a1', refresh_token: 'r1', expires_in: 3600, scope: 'x' }) };
	});

	const token = await auth.exchangeCode('one-time-code');
	assert.strictEqual(token.access_token, 'a1');
	assert.strictEqual(token.refresh_token, 'r1');
	const onDisk = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
	assert.strictEqual(onDisk.refresh_token, 'r1');
	assert.ok(onDisk.expiry_date > Date.now());
});

test('getAccessToken(): a still-valid token is used as-is, no network call', async (t) => {
	const tokenFile = path.join(tmpRoot, 'valid.json');
	fs.writeFileSync(tokenFile, JSON.stringify({ access_token: 'still-good', refresh_token: 'r1', expiry_date: Date.now() + 3600_000 }));
	withGoogleEnv(t, { GOOGLE_TOKEN_PATH: tokenFile });
	t.mock.method(global, 'fetch', async () => {
		throw new Error('must not be called for a still-valid token');
	});

	const accessToken = await auth.getAccessToken();
	assert.strictEqual(accessToken, 'still-good');
});

test('getAccessToken(): an expired token is refreshed and the new one persisted, keeping the same refresh_token', async (t) => {
	const tokenFile = path.join(tmpRoot, 'expired.json');
	fs.writeFileSync(tokenFile, JSON.stringify({ access_token: 'stale', refresh_token: 'r1', expiry_date: Date.now() - 1000 }));
	withGoogleEnv(t, { GOOGLE_TOKEN_PATH: tokenFile });
	t.mock.method(global, 'fetch', async () => ({ ok: true, json: async () => ({ access_token: 'fresh', expires_in: 3600 }) }));

	const accessToken = await auth.getAccessToken();
	assert.strictEqual(accessToken, 'fresh');
	const onDisk = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
	assert.strictEqual(onDisk.refresh_token, 'r1', 'a refresh response has no refresh_token of its own — the original must be preserved');
});

test('getAccessToken(): rejects clearly when not connected at all', async (t) => {
	withGoogleEnv(t, { GOOGLE_TOKEN_PATH: path.join(tmpRoot, 'does-not-exist.json') });
	await assert.rejects(() => auth.getAccessToken(), /run node setup-google\.js/);
});

// --- status(): the /status-facing health check ---

test('status(): not connected at all', async (t) => {
	withGoogleEnv(t, { GOOGLE_TOKEN_PATH: path.join(tmpRoot, 'nope.json') });
	const result = await auth.status();
	assert.deepStrictEqual(result, { connected: false, ok: false, message: 'Not connected — run node setup-google.js' });
});

test('status(): connected and healthy always does a real refresh round-trip (a live check, not just "file exists")', async (t) => {
	const tokenFile = path.join(tmpRoot, 'status-ok.json');
	fs.writeFileSync(tokenFile, JSON.stringify({ access_token: 'a', refresh_token: 'r1', expiry_date: Date.now() + 3600_000 }));
	withGoogleEnv(t, { GOOGLE_TOKEN_PATH: tokenFile });
	let called = false;
	t.mock.method(global, 'fetch', async () => {
		called = true;
		return { ok: true, json: async () => ({ access_token: 'fresh', expires_in: 3600 }) };
	});

	const result = await auth.status();
	assert.strictEqual(called, true, 'status() must force a real refresh, not trust a cached expiry_date');
	assert.deepStrictEqual(result, { connected: true, ok: true, message: 'token OK' });
});

test('status(): a revoked token reports invalid_grant specifically, with actionable guidance', async (t) => {
	const tokenFile = path.join(tmpRoot, 'status-revoked.json');
	fs.writeFileSync(tokenFile, JSON.stringify({ access_token: 'a', refresh_token: 'r1', expiry_date: Date.now() + 3600_000 }));
	withGoogleEnv(t, { GOOGLE_TOKEN_PATH: tokenFile });
	t.mock.method(global, 'fetch', async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }) }));

	const result = await auth.status();
	assert.strictEqual(result.connected, true);
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.code, 'invalid_grant');
	assert.match(result.message, /invalid_grant/);
	assert.match(result.message, /setup-google\.js/);
});

test('status(): a different token-endpoint failure is reported too, distinguishable from invalid_grant', async (t) => {
	const tokenFile = path.join(tmpRoot, 'status-othererr.json');
	fs.writeFileSync(tokenFile, JSON.stringify({ access_token: 'a', refresh_token: 'r1', expiry_date: Date.now() + 3600_000 }));
	withGoogleEnv(t, { GOOGLE_TOKEN_PATH: tokenFile });
	t.mock.method(global, 'fetch', async () => ({ ok: false, status: 500, json: async () => ({ error: 'server_error' }) }));

	const result = await auth.status();
	assert.strictEqual(result.ok, false);
	assert.notStrictEqual(result.code, 'invalid_grant');
});
