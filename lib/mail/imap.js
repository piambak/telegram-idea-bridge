const { env } = require('../config');

function isConfigured() {
	return Boolean(env.IMAP_HOST && env.IMAP_USER && env.IMAP_PASSWORD);
}

// imapflow/mailparser are optional — most setups use gmail/outlook instead
// (docs/SETUP-OUTLOOK.md "Path B"), and this repo keeps dependencies
// minimal (CLAUDE.md), so neither is a normal dependency. Required lazily,
// inside fetchNew, so merely requiring this module (e.g. from
// lib/mail/index.js's provider table) never fails when they're absent.
function loadImapDeps() {
	let ImapFlow;
	let simpleParser;
	try {
		({ ImapFlow } = require('imapflow'));
		({ simpleParser } = require('mailparser'));
	} catch (err) {
		throw new Error('imapflow/mailparser not installed — run: npm install imapflow mailparser');
	}
	return { ImapFlow, simpleParser };
}

function normalizeMessage(uid, parsed) {
	const from = (parsed.from && parsed.from.value && parsed.from.value[0]) || {};
	const icsAttachment = (parsed.attachments || []).find(
		(a) => a.contentType === 'text/calendar' || /\.ics$/i.test(a.filename || ''),
	);
	return {
		id: String(uid),
		provider: 'imap',
		from: { name: from.name || '', email: (from.address || '').toLowerCase() },
		subject: parsed.subject || '',
		date: (parsed.date || new Date()).toISOString(),
		text: parsed.text || (parsed.html ? String(parsed.html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : ''),
		snippet: (parsed.text || '').slice(0, 200),
		labels: [],
		unread: true, // IMAP flags are per-fetch, not tracked as a stable "seen" concept here
		attachments: (parsed.attachments || []).map((a) => ({ filename: a.filename || '', mimeType: a.contentType || '' })),
		ics: icsAttachment ? icsAttachment.content.toString('utf8') : null,
		link: '',
	};
}

async function fetchNew({ sinceMs, seenIds } = {}) {
	if (!isConfigured()) throw new Error('Not configured — set IMAP_HOST, IMAP_USER, IMAP_PASSWORD');
	const { ImapFlow, simpleParser } = loadImapDeps();

	const client = new ImapFlow({
		host: env.IMAP_HOST,
		port: Number(env.IMAP_PORT) || 993,
		secure: true,
		auth: { user: env.IMAP_USER, pass: env.IMAP_PASSWORD },
		logger: false,
	});

	const messages = [];
	await client.connect();
	try {
		const lock = await client.getMailboxLock(env.IMAP_MAILBOX || 'INBOX');
		try {
			const since = new Date(sinceMs);
			for await (const msg of client.fetch({ since }, { source: true, uid: true })) {
				if (seenIds && seenIds.has(String(msg.uid))) continue;
				const parsed = await simpleParser(msg.source);
				messages.push(normalizeMessage(msg.uid, parsed));
			}
		} finally {
			lock.release();
		}
	} finally {
		await client.logout().catch(() => {});
	}
	return messages;
}

// For /status: a real connect + immediate logout, not just "are the env
// vars set" — a wrong password or unreachable host must show up here.
async function checkConnection() {
	if (!isConfigured()) return { ok: false, reason: 'Not configured — set IMAP_HOST, IMAP_USER, IMAP_PASSWORD' };
	let ImapFlow;
	try {
		({ ImapFlow } = loadImapDeps());
	} catch (err) {
		return { ok: false, reason: err.message };
	}
	const client = new ImapFlow({
		host: env.IMAP_HOST,
		port: Number(env.IMAP_PORT) || 993,
		secure: true,
		auth: { user: env.IMAP_USER, pass: env.IMAP_PASSWORD },
		logger: false,
	});
	try {
		await client.connect();
		return { ok: true };
	} catch (err) {
		return { ok: false, reason: err.message };
	} finally {
		await client.logout().catch(() => {});
	}
}

module.exports = { fetchNew, isConfigured, loadImapDeps, checkConnection };
