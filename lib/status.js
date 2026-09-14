const models = require('./models');
const claude = require('./claude');
const googleAuth = require('./google/auth');
const outlook = require('./mail/outlook');
const imap = require('./mail/imap');
const radicale = require('./radicale');
const whatsapp = require('./whatsapp');
const vaultsync = require('./vaultsync');

const PROBE_TIMEOUT_MS = 8000;
// lib/models.js's own MODELS.gemini.label already documents this: "slow
// (~15-45s: the flash model emits reasoning tokens)". That reasoning delay
// happens before any output token — including the max_tokens:1 cap this
// probe uses — so it isn't something a smaller request can dodge. Measured
// ~17.5s for a bare "ping" against the real API; 8s (fine for the other,
// fast providers) reported Gemini as unreachable even when it was working.
const GEMINI_PROBE_TIMEOUT_MS = 50_000;

// A minimal, cheap real call against a chat provider — reachability, not a
// full round-trip. Reuses the exact chat fn every other command already
// calls, so "reachable" here means the same thing it means everywhere else
// in the bot, not a separate probe endpoint that could behave differently.
async function checkChatProvider(chatFn, timeoutMs = PROBE_TIMEOUT_MS) {
	await chatFn([{ role: 'user', content: 'ping' }], { timeoutMs, retries: 0, params: { max_tokens: 1 } });
	return { ok: true };
}

// Normalizes any check's result/rejection into { name, ok, reason }. A check
// that throws (a bug in the check itself, not just "the service is down")
// is caught here too — one broken check must never take /status down with
// it, or hide the other services' results.
async function safeCheck(name, fn) {
	try {
		const result = await fn();
		return { name, ok: Boolean(result.ok), reason: result.ok ? null : result.reason || result.message || 'unknown error' };
	} catch (err) {
		return { name, ok: false, reason: err.message };
	}
}

// docs/V2-SPEC.md §9: the one command that says what's actually configured
// and reachable right now on the PC — every entry degrades independently,
// so Radicale/hermes being office-PC-only (and therefore down anywhere
// else) never hides whether Groq or the Google token are fine.
async function checkAll() {
	return Promise.all([
		safeCheck('Groq', () => checkChatProvider(models.groqChat)),
		safeCheck('OpenRouter', () => checkChatProvider(models.openrouterChat)),
		safeCheck('Ollama Cloud', () => checkChatProvider(models.ollamacloudChat)),
		safeCheck('Gemini', () => checkChatProvider(models.MODELS.gemini.chat, GEMINI_PROBE_TIMEOUT_MS)),
		safeCheck('Claude CLI', () => claude.version().then(() => ({ ok: true }))),
		safeCheck('Google token', () => googleAuth.status().then((s) => ({ ok: s.ok, reason: s.message }))),
		safeCheck('Microsoft token', () => outlook.status().then((s) => ({ ok: s.ok, reason: s.message }))),
		safeCheck('IMAP', () => imap.checkConnection()),
		safeCheck('Radicale', () => radicale.checkConnection()),
		safeCheck('hermes', () => whatsapp.checkConnection()),
		safeCheck('Vault mirror', () => vaultsync.checkConnection()),
	]);
}

module.exports = { checkAll, checkChatProvider, safeCheck };
