const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-bridge-setupgoogle-'));
const tokenFile = path.join(tmpRoot, 'token.json');

const { env } = require('../lib/config');
env.GOOGLE_TOKEN_PATH = tokenFile;
env.GOOGLE_CLIENT_ID = 'client-id';
env.GOOGLE_CLIENT_SECRET = 'client-secret';

const cp = require('node:child_process'); // same specifier setup-google.js uses
const setupGoogle = require('../setup-google');

test.after(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	delete env.GOOGLE_TOKEN_PATH;
});

// A free ephemeral port per test, not the real 53682, so these tests never
// fight the real listener (or each other) for the port.
function getEphemeralPort() {
	return new Promise((resolve) => {
		const probe = http.createServer();
		probe.listen(0, '127.0.0.1', () => {
			const { port } = probe.address();
			probe.close(() => resolve(port));
		});
	});
}

test('waitForAuthCode(): resolves with the code from a real GET to /oauth2callback?code=...', async () => {
	const port = await getEphemeralPort();
	const promise = setupGoogle.waitForAuthCode({ port, timeoutMs: 5000 });

	// Give the server a beat to start listening, then hit it exactly the
	// way a browser redirect (or a manually pasted URL) would.
	await new Promise((r) => setTimeout(r, 50));
	const res = await fetch(`http://127.0.0.1:${port}/oauth2callback?code=abc123`);
	assert.strictEqual(res.status, 200);
	const html = await res.text();
	assert.match(html, /Connected/);

	const code = await promise;
	assert.strictEqual(code, 'abc123');
});

test('waitForAuthCode(): rejects when Google redirects back with ?error=...', async () => {
	const port = await getEphemeralPort();
	const promise = setupGoogle.waitForAuthCode({ port, timeoutMs: 5000 });
	// The reject() fires synchronously inside the request handler triggered
	// by the fetch() below, before this line gets back around to attaching
	// assert.rejects' own handler — attach a no-op catch right away so
	// Node never sees it as briefly unhandled. assert.rejects still gets
	// its own independent handler on the same promise afterward.
	promise.catch(() => {});
	await new Promise((r) => setTimeout(r, 50));
	await fetch(`http://127.0.0.1:${port}/oauth2callback?error=access_denied`);
	await assert.rejects(() => promise, /access_denied/);
});

test('waitForAuthCode(): a request to any other path is ignored (404), the listener keeps waiting', async () => {
	const port = await getEphemeralPort();
	const promise = setupGoogle.waitForAuthCode({ port, timeoutMs: 5000 });
	await new Promise((r) => setTimeout(r, 50));

	const stray = await fetch(`http://127.0.0.1:${port}/favicon.ico`);
	assert.strictEqual(stray.status, 404);

	const real = await fetch(`http://127.0.0.1:${port}/oauth2callback?code=xyz789`);
	assert.strictEqual(real.status, 200);
	assert.strictEqual(await promise, 'xyz789');
});

test('waitForAuthCode(): times out and rejects if nothing ever hits the callback (simulating the office-policy case with no manual paste)', async () => {
	const port = await getEphemeralPort();
	await assert.rejects(() => setupGoogle.waitForAuthCode({ port, timeoutMs: 100 }), /Timed out/);
});

test('fetchConnectedAddress(): reports the signed-in Gmail address via the profile endpoint', async (t) => {
	fs.writeFileSync(tokenFile, JSON.stringify({ access_token: 'a1', refresh_token: 'r1', expiry_date: Date.now() + 3600_000 }));
	t.mock.method(global, 'fetch', async (url) => {
		assert.strictEqual(url, 'https://gmail.googleapis.com/gmail/v1/users/me/profile');
		return { ok: true, json: async () => ({ emailAddress: 'user@gmail.com' }) };
	});
	assert.strictEqual(await setupGoogle.fetchConnectedAddress(), 'user@gmail.com');
});

test('fetchConnectedAddress(): degrades to a friendly message instead of throwing if the check call itself fails', async (t) => {
	fs.writeFileSync(tokenFile, JSON.stringify({ access_token: 'a1', refresh_token: 'r1', expiry_date: Date.now() + 3600_000 }));
	t.mock.method(global, 'fetch', async () => ({ ok: false, status: 500, text: async () => 'boom' }));
	assert.match(await setupGoogle.fetchConnectedAddress(), /check \/status/);
});

// --- openBrowser() — cuts the weekly Testing-mode re-auth down to "run,
// click Allow" instead of copy-pasting the URL ---

test('openBrowser(): shells out to the right platform command with the URL', (t) => {
	const savedPlatform = process.platform;
	let seenCmd;
	t.mock.method(cp, 'exec', (cmd, cb) => {
		seenCmd = cmd;
		cb(null);
	});
	Object.defineProperty(process, 'platform', { value: 'win32' });
	try {
		setupGoogle.openBrowser('https://accounts.google.com/o/oauth2/v2/auth?x=1');
		assert.strictEqual(seenCmd, 'start "" "https://accounts.google.com/o/oauth2/v2/auth?x=1"');
	} finally {
		Object.defineProperty(process, 'platform', { value: savedPlatform });
	}
});

test('openBrowser(): a failure to launch a browser never throws — the URL was already printed as a fallback', (t) => {
	t.mock.method(cp, 'exec', (cmd, cb) => {
		cb(new Error('no browser association'));
	});
	assert.doesNotThrow(() => setupGoogle.openBrowser('https://example.com/consent'));
});
