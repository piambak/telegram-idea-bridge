const fs = require('fs');
const path = require('path');
const { env } = require('../config');

// docs/SETUP-GOOGLE.md: one OAuth client and one refresh token, shared by
// Gmail (readonly), Sheets, and Tasks — no SDK, no service account, no
// Calendar scope (events go to Radicale instead). This module is the single
// place that owns the token file; lib/mail/gmail.js, lib/google/sheets.js,
// and lib/google/tasks.js all call getAccessToken() here rather than each
// keeping their own copy of the refresh flow.
const SCOPES = [
	'https://www.googleapis.com/auth/gmail.readonly',
	'https://www.googleapis.com/auth/spreadsheets',
	'https://www.googleapis.com/auth/tasks',
];
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REDIRECT_URI = 'http://127.0.0.1:53682/oauth2callback';

// Written by setup-google.js. Not under .state/: this long-lived credential
// predates that convention and docs/SETUP-GOOGLE.md already documents this
// exact path; gitignored either way. Read fresh on every call (never cached
// at module load) so GOOGLE_TOKEN_PATH can be overridden any time before a
// given call, e.g. in tests.
function tokenPath() {
	return env.GOOGLE_TOKEN_PATH || path.join(__dirname, '..', '..', '.google-token.json');
}

function isConnected() {
	return fs.existsSync(tokenPath());
}

function loadToken() {
	if (!fs.existsSync(tokenPath())) return null;
	return JSON.parse(fs.readFileSync(tokenPath(), 'utf8'));
}

function saveToken(token) {
	fs.writeFileSync(tokenPath(), JSON.stringify(token, null, 2), 'utf8');
}

function requireClientCreds() {
	const clientId = env.GOOGLE_CLIENT_ID;
	const clientSecret = env.GOOGLE_CLIENT_SECRET;
	if (!clientId || !clientSecret) throw new Error('Not configured — set GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET (see docs/SETUP-GOOGLE.md)');
	return { clientId, clientSecret };
}

// The one-time consent URL setup-google.js prints. access_type=offline +
// prompt=consent so a refresh_token comes back even on a repeat sign-in
// (Google otherwise omits it after the first-ever consent).
function authUrl() {
	const { clientId } = requireClientCreds();
	const params = new URLSearchParams({
		client_id: clientId,
		redirect_uri: REDIRECT_URI,
		response_type: 'code',
		scope: SCOPES.join(' '),
		access_type: 'offline',
		prompt: 'consent',
	});
	return `${AUTH_URL}?${params.toString()}`;
}

function describeTokenError(json, res) {
	if (json.error === 'invalid_grant') {
		const err = new Error(
			'invalid_grant — the token was revoked, or the app was still in Testing when you signed in. ' +
				'Publish the app (docs/SETUP-GOOGLE.md step 1) and re-run node setup-google.js.',
		);
		err.code = 'invalid_grant';
		return err;
	}
	const err = new Error(`Google token endpoint failed: HTTP ${res.status}: ${json.error_description || json.error || JSON.stringify(json)}`);
	err.code = json.error;
	return err;
}

// Exchanges a one-time authorization code (from the consent redirect) for
// the first refresh_token + access_token pair. Only setup-google.js calls
// this.
async function exchangeCode(code) {
	const { clientId, clientSecret } = requireClientCreds();
	const res = await fetch(TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: clientId,
			client_secret: clientSecret,
			code,
			redirect_uri: REDIRECT_URI,
			grant_type: 'authorization_code',
		}),
	});
	const json = await res.json().catch(() => ({}));
	if (!res.ok) throw describeTokenError(json, res);
	const token = { ...json, expiry_date: Date.now() + json.expires_in * 1000 };
	saveToken(token);
	return token;
}

async function refreshAccessToken(token) {
	const { clientId, clientSecret } = requireClientCreds();
	const res = await fetch(TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: clientId,
			client_secret: clientSecret,
			refresh_token: token.refresh_token,
			grant_type: 'refresh_token',
		}),
	});
	const json = await res.json().catch(() => ({}));
	if (!res.ok) throw describeTokenError(json, res);
	// refresh responses never include a new refresh_token — keep the one we
	// already had, or every subsequent refresh would fail.
	const merged = { ...token, ...json, refresh_token: token.refresh_token, expiry_date: Date.now() + json.expires_in * 1000 };
	saveToken(merged);
	return merged;
}

// Refreshes 60s ahead of actual expiry so a request never races an
// about-to-expire token.
async function getAccessToken() {
	let token = loadToken();
	if (!token) throw new Error('Not connected — run node setup-google.js');
	if (!token.expiry_date || token.expiry_date < Date.now() + 60_000) {
		token = await refreshAccessToken(token);
	}
	return token.access_token;
}

// For /status: a live check (always forces a real refresh round-trip,
// regardless of the cached token's expiry) so "token OK" genuinely means
// "Google accepted this token just now", and invalid_grant is reported
// clearly and specifically rather than as a generic failure.
async function status() {
	const token = loadToken();
	if (!token) return { connected: false, ok: false, message: 'Not connected — run node setup-google.js' };
	try {
		await refreshAccessToken(token);
		return { connected: true, ok: true, message: 'token OK' };
	} catch (err) {
		return { connected: true, ok: false, message: err.message, code: err.code };
	}
}

module.exports = {
	authUrl,
	exchangeCode,
	getAccessToken,
	status,
	isConnected,
	tokenPath,
	REDIRECT_URI,
	SCOPES,
};
