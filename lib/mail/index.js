const { env } = require('../config');
const state = require('../state');
const gmail = require('./gmail');
const outlook = require('./outlook');
const imap = require('./imap');

const PROVIDERS = { gmail, outlook, imap };

const CURSOR_FILE = 'mail-cursor.json';
const SEEN_FILE = 'mail-seen.json';
const SEEN_CAP = 3000;
const DEFAULT_LOOKBACK_MS = 24 * 3600 * 1000; // first-ever run: last 24h, not the whole mailbox

function configuredProviderNames() {
	const listed = (env.MAIL_PROVIDERS || 'gmail,outlook')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	return listed.filter((name) => PROVIDERS[name]);
}

function loadCursors() {
	return state.readJson(CURSOR_FILE, {});
}

function loadSeen() {
	return new Set(state.readJson(SEEN_FILE, []));
}

// Keeps the most recently added 3,000 ids when trimming — Set insertion
// order is iteration order in JS, so the oldest ids (least likely to still
// matter for dedup) are the ones dropped.
function saveSeen(seenSet) {
	const arr = [...seenSet];
	state.writeJson(SEEN_FILE, arr.length > SEEN_CAP ? arr.slice(arr.length - SEEN_CAP) : arr);
}

// Fetches new mail across every configured provider. `overrideHours` (e.g.
// /inbox 72h) widens the lookback window for this call without disturbing
// what "new" means for future default runs — the cursor still advances to
// now afterward for whichever providers succeeded.
//
// One provider failing (bad token, network blip, not configured) never
// hides the others: it's collected in `errors` and that provider's cursor
// is left untouched so the next attempt retries the same window.
async function fetchNew({ overrideHours } = {}) {
	const cursors = loadCursors();
	const seen = loadSeen();
	const now = Date.now();
	const messages = [];
	const errors = [];

	for (const name of configuredProviderNames()) {
		const provider = PROVIDERS[name];
		const sinceMs = overrideHours ? now - overrideHours * 3600 * 1000 : cursors[name] || now - DEFAULT_LOOKBACK_MS;
		try {
			const fetched = await provider.fetchNew({ sinceMs, seenIds: seen });
			for (const msg of fetched) {
				if (seen.has(msg.id)) continue;
				seen.add(msg.id);
				messages.push(msg);
			}
			cursors[name] = now;
		} catch (err) {
			errors.push({ provider: name, message: err.message });
		}
	}

	state.writeJson(CURSOR_FILE, cursors);
	saveSeen(seen);
	messages.sort((a, b) => new Date(a.date) - new Date(b.date));
	return { messages, errors };
}

module.exports = { fetchNew, configuredProviderNames, PROVIDERS };
