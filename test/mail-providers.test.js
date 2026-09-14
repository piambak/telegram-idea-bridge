const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-bridge-mailprov-'));

const gmail = require('../lib/mail/gmail');
const outlook = require('../lib/mail/outlook');
const imap = require('../lib/mail/imap');
const { env } = require('../lib/config');

test.after(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('gmail.isConfigured() is false with no client id/secret/token file', () => {
	const savedId = env.GOOGLE_CLIENT_ID;
	const savedSecret = env.GOOGLE_CLIENT_SECRET;
	delete env.GOOGLE_CLIENT_ID;
	delete env.GOOGLE_CLIENT_SECRET;
	try {
		assert.strictEqual(gmail.isConfigured(), false);
	} finally {
		env.GOOGLE_CLIENT_ID = savedId;
		env.GOOGLE_CLIENT_SECRET = savedSecret;
	}
});

test('gmail.fetchNew() rejects with a clear "run node setup-google.js" message when no token file exists', async () => {
	const original = env.GOOGLE_TOKEN_PATH;
	// tokenPath() is read fresh on every call, so pointing it at a tmp path
	// that definitely doesn't exist makes this robust even on a real
	// deployment box where a genuine .google-token.json is present.
	env.GOOGLE_TOKEN_PATH = path.join(tmpRoot, 'no-such-google-token.json');
	try {
		assert.strictEqual(gmail.isConfigured(), false);
		await assert.rejects(() => gmail.fetchNew({ sinceMs: Date.now() }), /setup-google/);
	} finally {
		env.GOOGLE_TOKEN_PATH = original;
	}
});

test('gmail token refresh: a valid token file with an expired access token gets refreshed via the OAuth endpoint', async (t) => {
	const tokenFile = path.join(tmpRoot, 'google-token-refresh.json');
	fs.writeFileSync(tokenFile, JSON.stringify({ access_token: 'stale', refresh_token: 'r1', expiry_date: Date.now() - 1000 }));
	const savedPath = env.GOOGLE_TOKEN_PATH;
	const savedId = env.GOOGLE_CLIENT_ID;
	const savedSecret = env.GOOGLE_CLIENT_SECRET;
	env.GOOGLE_TOKEN_PATH = tokenFile;
	env.GOOGLE_CLIENT_ID = 'client-id';
	env.GOOGLE_CLIENT_SECRET = 'client-secret';

	// fetchNew calls getAccessToken() (hits the refresh endpoint) and then
	// the Gmail API next — mock both, asserting the refresh request shape.
	t.mock.method(global, 'fetch', async (url, opts) => {
		if (url === 'https://oauth2.googleapis.com/token') {
			const body = new URLSearchParams(opts.body);
			assert.strictEqual(body.get('refresh_token'), 'r1');
			assert.strictEqual(body.get('grant_type'), 'refresh_token');
			return { ok: true, json: async () => ({ access_token: 'fresh', expires_in: 3600 }) };
		}
		return { ok: true, json: async () => ({ messages: [] }) };
	});

	try {
		await gmail.fetchNew({ sinceMs: Date.now() - 1000 });
		const saved = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
		assert.strictEqual(saved.access_token, 'fresh', 'the refreshed token should be persisted back to the token file');
	} finally {
		env.GOOGLE_TOKEN_PATH = savedPath;
		env.GOOGLE_CLIENT_ID = savedId;
		env.GOOGLE_CLIENT_SECRET = savedSecret;
	}
});

test('outlook.isConfigured() is false with no client id/token file', () => {
	const saved = env.MS_CLIENT_ID;
	delete env.MS_CLIENT_ID;
	try {
		assert.strictEqual(outlook.isConfigured(), false);
	} finally {
		env.MS_CLIENT_ID = saved;
	}
});

test('outlook.fetchNew() rejects with a clear "run node setup-outlook.js" message when no token file exists', async () => {
	const original = env.MS_TOKEN_PATH;
	env.MS_TOKEN_PATH = path.join(tmpRoot, 'no-such-ms-token.json');
	try {
		await assert.rejects(() => outlook.fetchNew({ sinceMs: Date.now() }), /setup-outlook/);
	} finally {
		env.MS_TOKEN_PATH = original;
	}
});

test('imap.isConfigured() is false without IMAP_HOST/USER/PASSWORD', () => {
	assert.strictEqual(imap.isConfigured(), false);
});

test('imap.fetchNew() rejects clearly when not configured, without ever touching imapflow/mailparser', async () => {
	await assert.rejects(() => imap.fetchNew({ sinceMs: Date.now() }), /Not configured.*IMAP_HOST/);
});

test('requiring lib/mail/imap.js never fails even though imapflow/mailparser are not installed (lazy require)', () => {
	// If this test file's own top-level `require('../lib/mail/imap')` had
	// thrown, node:test would report the whole file as failed rather than
	// reaching this assertion — reaching here at all is the proof.
	assert.strictEqual(typeof imap.fetchNew, 'function');
});

test('imap.loadImapDeps() throws a clear, actionable error since imapflow/mailparser are not installed in this repo', () => {
	assert.throws(() => imap.loadImapDeps(), /imapflow\/mailparser not installed/);
});

// --- checkConnection() / status() — /status's IMAP and Microsoft rows -----

test('imap.checkConnection(): not configured is reported without touching imapflow/mailparser', async () => {
	const result = await imap.checkConnection();
	assert.strictEqual(result.ok, false);
	assert.match(result.reason, /Not configured.*IMAP_HOST/);
});

test('imap.checkConnection(): configured but imapflow/mailparser missing surfaces that specific reason', async () => {
	const saved = { host: env.IMAP_HOST, user: env.IMAP_USER, pass: env.IMAP_PASSWORD };
	Object.assign(env, { IMAP_HOST: 'imap.example.com', IMAP_USER: 'me', IMAP_PASSWORD: 'secret' });
	try {
		const result = await imap.checkConnection();
		assert.strictEqual(result.ok, false);
		assert.match(result.reason, /imapflow\/mailparser not installed/);
	} finally {
		Object.assign(env, { IMAP_HOST: saved.host, IMAP_USER: saved.user, IMAP_PASSWORD: saved.pass });
	}
});

test('outlook.status(): not configured (no MS_CLIENT_ID) is reported without touching the token file', async () => {
	const saved = env.MS_CLIENT_ID;
	delete env.MS_CLIENT_ID;
	try {
		const result = await outlook.status();
		assert.deepStrictEqual(result, { connected: false, ok: false, message: 'Not configured — set MS_CLIENT_ID (see docs/SETUP-OUTLOOK.md)' });
	} finally {
		env.MS_CLIENT_ID = saved;
	}
});

test('outlook.status(): configured but never connected (no token file)', async () => {
	const savedId = env.MS_CLIENT_ID;
	const savedPath = env.MS_TOKEN_PATH;
	env.MS_CLIENT_ID = 'client-id';
	env.MS_TOKEN_PATH = path.join(tmpRoot, 'no-such-ms-token-2.json');
	try {
		const result = await outlook.status();
		assert.strictEqual(result.connected, false);
		assert.match(result.message, /setup-outlook/);
	} finally {
		env.MS_CLIENT_ID = savedId;
		env.MS_TOKEN_PATH = savedPath;
	}
});

test('outlook.status(): a valid token refreshes live and reports "token OK"', async (t) => {
	const tokenFile = path.join(tmpRoot, 'ms-token-status.json');
	fs.writeFileSync(tokenFile, JSON.stringify({ access_token: 'stale', refresh_token: 'r1', expiry_date: Date.now() - 1000 }));
	const savedId = env.MS_CLIENT_ID;
	const savedPath = env.MS_TOKEN_PATH;
	env.MS_CLIENT_ID = 'client-id';
	env.MS_TOKEN_PATH = tokenFile;
	t.mock.method(global, 'fetch', async () => ({ ok: true, json: async () => ({ access_token: 'fresh', expires_in: 3600 }) }));
	try {
		const result = await outlook.status();
		assert.deepStrictEqual(result, { connected: true, ok: true, message: 'token OK' });
	} finally {
		env.MS_CLIENT_ID = savedId;
		env.MS_TOKEN_PATH = savedPath;
	}
});

test('outlook.status(): a rejected refresh (revoked token) is reported, connected but not ok', async (t) => {
	const tokenFile = path.join(tmpRoot, 'ms-token-status-bad.json');
	fs.writeFileSync(tokenFile, JSON.stringify({ access_token: 'stale', refresh_token: 'r1', expiry_date: Date.now() - 1000 }));
	const savedId = env.MS_CLIENT_ID;
	const savedPath = env.MS_TOKEN_PATH;
	env.MS_CLIENT_ID = 'client-id';
	env.MS_TOKEN_PATH = tokenFile;
	t.mock.method(global, 'fetch', async () => ({ ok: false, status: 400, text: async () => 'invalid_grant' }));
	try {
		const result = await outlook.status();
		assert.strictEqual(result.connected, true);
		assert.strictEqual(result.ok, false);
		assert.match(result.message, /invalid_grant/);
	} finally {
		env.MS_CLIENT_ID = savedId;
		env.MS_TOKEN_PATH = savedPath;
	}
});
