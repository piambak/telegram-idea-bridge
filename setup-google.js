// One-time interactive Google sign-in (docs/SETUP-GOOGLE.md §2). Run:
//   node setup-google.js
// Prints the consent URL, listens on 127.0.0.1:53682 for the redirect,
// exchanges the code, and writes .google-token.json.
const http = require('http');
const { env } = require('./lib/config');
const auth = require('./lib/google/auth');

const PORT = 53682;
// Generous on purpose: docs/SETUP-GOOGLE.md §2's office-policy fallback has
// the user finish consent on their phone, then come back and paste the
// final redirect URL into a browser on this PC — that round trip can take
// a couple of minutes, and the listener must still be here when they do.
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

// Starts the local redirect listener and resolves with the authorization
// code once Google (or the user, pasting the URL manually) hits it.
// Exported/parameterized (port, timeoutMs) so this is testable without
// waiting the real 10 minutes or fighting over the real port.
function waitForAuthCode({ port = PORT, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
	return new Promise((resolve, reject) => {
		const server = http.createServer((req, res) => {
			const reqUrl = new URL(req.url, `http://127.0.0.1:${port}`);
			if (reqUrl.pathname !== '/oauth2callback') {
				res.writeHead(404);
				res.end();
				return;
			}
			const error = reqUrl.searchParams.get('error');
			const code = reqUrl.searchParams.get('code');
			res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
			res.end(
				error
					? `<p>Google returned an error: ${error}. Close this tab and try again.</p>`
					: '<p>Connected. You can close this tab and return to the terminal.</p>',
			);
			server.close();
			if (error) reject(new Error(`Google consent failed: ${error}`));
			else resolve(code);
		});
		const timer = setTimeout(() => {
			server.close();
			reject(new Error(`Timed out after ${Math.round(timeoutMs / 60000)} minutes waiting for the consent redirect.`));
		}, timeoutMs);
		server.on('close', () => clearTimeout(timer));
		server.on('error', reject);
		server.listen(port, '127.0.0.1');
	});
}

// Prints the connected Google account's address via a lightweight Gmail
// profile call — just confirms the token actually works end to end.
async function fetchConnectedAddress() {
	const accessToken = await auth.getAccessToken();
	const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	if (!res.ok) return '(token saved, but could not verify — check /status)';
	const json = await res.json();
	return json.emailAddress || '(unknown)';
}

async function main() {
	if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
		console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first — see docs/SETUP-GOOGLE.md.');
		process.exitCode = 1;
		return;
	}

	console.log('Open this URL in any browser, sign in, and accept:\n');
	console.log(auth.authUrl());
	console.log(`\nListening on http://127.0.0.1:${PORT}/oauth2callback ...`);
	console.log("If this PC's browser can't reach that address, finish consent on your phone, then paste the final");
	console.log(`http://127.0.0.1:${PORT}/oauth2callback?code=... URL into a browser on this PC.\n`);

	const code = await waitForAuthCode();
	await auth.exchangeCode(code);
	console.log(`\nToken saved to ${auth.tokenPath()}.`);

	const address = await fetchConnectedAddress();
	console.log(`Connected as: ${address}`);
}

module.exports = { waitForAuthCode, fetchConnectedAddress, main, PORT, DEFAULT_TIMEOUT_MS };

if (require.main === module) {
	main().catch((err) => {
		console.error(err.message);
		process.exitCode = 1;
	});
}
