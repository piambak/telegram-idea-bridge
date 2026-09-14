const { env } = require('../config');
const auth = require('../google/auth');

// Token management (refresh-token flow, .google-token.json) lives in
// lib/google/auth.js — one OAuth client and refresh token shared by Gmail,
// Sheets, and Tasks (docs/SETUP-GOOGLE.md).
const API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

function isConfigured() {
	return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && auth.isConnected());
}

async function apiFetch(accessToken, pathSuffix) {
	const res = await fetch(`${API_BASE}${pathSuffix}`, { headers: { Authorization: `Bearer ${accessToken}` } });
	if (!res.ok) throw new Error(`Gmail API failed: HTTP ${res.status}: ${await res.text()}`);
	return res.json();
}

function findHeader(headers, name) {
	const h = (headers || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
	return h ? h.value : '';
}

function parseFrom(raw) {
	const m = String(raw || '').match(/^"?([^"<]*)"?\s*<([^>]+)>\s*$/);
	if (m) return { name: m[1].trim(), email: m[2].trim().toLowerCase() };
	return { name: '', email: String(raw || '').trim().toLowerCase() };
}

function decodeBase64Url(data) {
	return Buffer.from(String(data).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
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

// Walks Gmail's MIME part tree, collecting the first text/plain and
// text/html bodies it finds and every attachment reference (attachments
// carry only an attachmentId here — the bytes are a separate fetch, done
// only for the ones that turn out to be .ics).
function walkParts(part, out) {
	if (!part) return;
	if (part.filename && part.body && (part.body.attachmentId || part.body.size)) {
		out.attachments.push({ filename: part.filename, mimeType: part.mimeType || '', attachmentId: part.body.attachmentId });
	} else if (part.mimeType === 'text/plain' && part.body && part.body.data && !out.text) {
		out.text = decodeBase64Url(part.body.data);
	} else if (part.mimeType === 'text/html' && part.body && part.body.data && !out.html) {
		out.html = decodeBase64Url(part.body.data);
	}
	for (const child of part.parts || []) walkParts(child, out);
}

async function normalizeMessage(full, accessToken) {
	const headers = full.payload.headers;
	const out = { attachments: [] };
	if (full.payload.body && full.payload.body.data) out.text = decodeBase64Url(full.payload.body.data);
	walkParts(full.payload, out);
	const text = out.text || (out.html ? stripHtml(out.html) : '') || full.snippet || '';

	let ics = null;
	const icsAttachment = out.attachments.find((a) => /\.ics$/i.test(a.filename) || a.mimeType === 'text/calendar');
	if (icsAttachment && icsAttachment.attachmentId) {
		const att = await apiFetch(accessToken, `/messages/${full.id}/attachments/${icsAttachment.attachmentId}`);
		ics = decodeBase64Url(att.data);
	}

	return {
		id: full.id,
		provider: 'gmail',
		from: parseFrom(findHeader(headers, 'From')),
		subject: findHeader(headers, 'Subject'),
		date: new Date(Number(full.internalDate)).toISOString(),
		text,
		snippet: full.snippet || '',
		labels: full.labelIds || [],
		unread: (full.labelIds || []).includes('UNREAD'),
		attachments: out.attachments.map((a) => ({ filename: a.filename, mimeType: a.mimeType })),
		ics,
		link: `https://mail.google.com/mail/u/0/#inbox/${full.id}`,
	};
}

// Fetches messages received since sinceMs, skipping anything already in
// `seenIds`. `after:` is second-resolution, so a stray id right at the
// boundary is exactly what the caller's seen-set is for.
async function fetchNew({ sinceMs, seenIds } = {}) {
	const accessToken = await auth.getAccessToken();
	const afterEpoch = Math.floor(sinceMs / 1000);
	const list = await apiFetch(accessToken, `/messages?q=${encodeURIComponent(`after:${afterEpoch}`)}&maxResults=50`);
	const messages = [];
	for (const ref of list.messages || []) {
		if (seenIds && seenIds.has(ref.id)) continue;
		const full = await apiFetch(accessToken, `/messages/${ref.id}?format=full`);
		messages.push(await normalizeMessage(full, accessToken));
	}
	return messages;
}

module.exports = { fetchNew, isConfigured };
