const fs = require('fs');
const path = require('path');
const { env } = require('../config');

// Written by setup-outlook.js (docs/SETUP-OUTLOOK.md) via the device-code
// flow — a public client, so refreshing needs no secret. Gitignored. Read
// fresh on every call (not cached at module load) so MS_TOKEN_PATH can be
// overridden any time before a given call, e.g. in tests.
function tokenPath() {
	return env.MS_TOKEN_PATH || path.join(__dirname, '..', '..', '.ms-token.json');
}
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0/me';

function tenant() {
	return env.MS_TENANT || 'organizations';
}

function tokenUrl() {
	return `https://login.microsoftonline.com/${tenant()}/oauth2/v2.0/token`;
}

function isConfigured() {
	return Boolean(env.MS_CLIENT_ID && fs.existsSync(tokenPath()));
}

function loadToken() {
	if (!fs.existsSync(tokenPath())) return null;
	return JSON.parse(fs.readFileSync(tokenPath(), 'utf8'));
}

function saveToken(token) {
	fs.writeFileSync(tokenPath(), JSON.stringify(token, null, 2), 'utf8');
}

async function refreshAccessToken(token) {
	const clientId = env.MS_CLIENT_ID;
	if (!clientId) throw new Error('Not configured — set MS_CLIENT_ID');
	const res = await fetch(tokenUrl(), {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: clientId,
			refresh_token: token.refresh_token,
			grant_type: 'refresh_token',
			scope: 'Mail.Read User.Read offline_access',
		}),
	});
	if (!res.ok) throw new Error(`Microsoft token refresh failed: HTTP ${res.status}: ${await res.text()}`);
	const refreshed = await res.json();
	const merged = { ...token, ...refreshed, expiry_date: Date.now() + refreshed.expires_in * 1000 };
	saveToken(merged);
	return merged;
}

async function getAccessToken() {
	let token = loadToken();
	if (!token) throw new Error('Not connected — run node setup-outlook.js');
	if (!token.expiry_date || token.expiry_date < Date.now() + 60_000) {
		token = await refreshAccessToken(token);
	}
	return token.access_token;
}

async function graphFetch(accessToken, pathAndQuery) {
	const res = await fetch(`${GRAPH_BASE}${pathAndQuery}`, { headers: { Authorization: `Bearer ${accessToken}` } });
	if (!res.ok) throw new Error(`Microsoft Graph failed: HTTP ${res.status}: ${await res.text()}`);
	return res.json();
}

function stripHtml(html) {
	return html
		.replace(/<style[\s\S]*?<\/style>/gi, '')
		.replace(/<script[\s\S]*?<\/script>/gi, '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/gi, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

// Graph's attachments endpoint returns file contents inline (contentBytes,
// base64) — unlike Gmail there's no second per-attachment fetch needed once
// we already have the attachments list.
async function fetchIcsAttachment(accessToken, messageId) {
	const list = await graphFetch(accessToken, `/messages/${messageId}/attachments`);
	const icsAttachment = (list.value || []).find(
		(a) => a.contentType === 'text/calendar' || /\.ics$/i.test(a.name || ''),
	);
	if (!icsAttachment || !icsAttachment.contentBytes) return null;
	return Buffer.from(icsAttachment.contentBytes, 'base64').toString('utf8');
}

async function normalizeMessage(m, accessToken) {
	const bodyContent = m.body && m.body.content ? m.body.content : m.bodyPreview || '';
	const text = m.body && m.body.contentType === 'html' ? stripHtml(bodyContent) : bodyContent;
	const ics = m.hasAttachments ? await fetchIcsAttachment(accessToken, m.id) : null;
	const fromAddr = (m.from && m.from.emailAddress) || {};

	return {
		id: m.id,
		provider: 'outlook',
		from: { name: fromAddr.name || '', email: (fromAddr.address || '').toLowerCase() },
		subject: m.subject || '',
		date: m.receivedDateTime,
		text,
		snippet: m.bodyPreview || '',
		labels: m.categories || [],
		unread: m.isRead === false,
		attachments: m.hasAttachments ? [{ filename: '(see message)', mimeType: '' }] : [],
		ics,
		link: m.webLink || '',
	};
}

// $filter needs the ISO timestamp with no milliseconds truncation surprises
// — toISOString() already gives Graph exactly what it wants.
async function fetchNew({ sinceMs, seenIds } = {}) {
	const accessToken = await getAccessToken();
	const since = new Date(sinceMs).toISOString();
	const query = `/mailFolders/inbox/messages?$filter=${encodeURIComponent(`receivedDateTime ge ${since}`)}&$top=50&$orderby=receivedDateTime`;
	const list = await graphFetch(accessToken, query);
	const messages = [];
	for (const m of list.value || []) {
		if (seenIds && seenIds.has(m.id)) continue;
		messages.push(await normalizeMessage(m, accessToken));
	}
	return messages;
}

// For /status: mirrors lib/google/auth.js's status() — always forces a real
// refresh round-trip so "token OK" means Microsoft accepted it just now.
async function status() {
	if (!env.MS_CLIENT_ID) return { connected: false, ok: false, message: 'Not configured — set MS_CLIENT_ID (see docs/SETUP-OUTLOOK.md)' };
	const token = loadToken();
	if (!token) return { connected: false, ok: false, message: 'Not connected — run node setup-outlook.js' };
	try {
		await refreshAccessToken(token);
		return { connected: true, ok: true, message: 'token OK' };
	} catch (err) {
		return { connected: true, ok: false, message: err.message };
	}
}

module.exports = { fetchNew, isConfigured, tokenPath, status };
