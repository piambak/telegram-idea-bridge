const state = require('./state');
const skills = require('./skills');

const SEARCH_URL = 'https://jdih.kemenkeu.go.id/search?order=desc&bentuk=Peraturan+Menteri';
const SEEN_FILE = 'seen-regulations.json';
const ITEM_PATTERN = /<h5 class="item"><a target="_blank" href="\/dok\/([^"]+)">([^<]+)<\/a><\/h5><p class="item">([^<]*)<\/p>/g;

// Thrown when the page loads fine but the scrape pattern matches nothing —
// i.e. JDIH changed their markup. Distinct from "no new regulations" so the
// daily unattended job can shout instead of silently reporting nothing.
class ScrapeError extends Error {
	constructor(message) {
		super(message);
		this.name = 'ScrapeError';
	}
}

async function fetchLatest(limit = 20) {
	const res = await fetch(SEARCH_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } });
	if (!res.ok) throw new Error(`JDIH fetch failed: HTTP ${res.status}`);
	const html = await res.text();

	const items = [];
	let match;
	ITEM_PATTERN.lastIndex = 0;
	while ((match = ITEM_PATTERN.exec(html)) !== null && items.length < limit) {
		items.push({
			slug: match[1],
			number: match[2].trim(),
			title: match[3].trim(),
			url: `https://jdih.kemenkeu.go.id/dok/${match[1]}`,
		});
	}

	// A 200 response with zero matches means the markup moved, not that the
	// ministry published nothing — the search page is never actually empty.
	// Without this the scraper fails silently and looks like quiet news.
	if (items.length === 0) {
		throw new ScrapeError(
			`JDIH page loaded (${html.length} bytes) but no regulations matched the scrape pattern — ` +
				'their markup likely changed, so regmonitor.js ITEM_PATTERN needs updating.',
		);
	}
	return items;
}

function loadSeen() {
	return new Set(state.readJson(SEEN_FILE, []));
}

function saveSeen(seenSet) {
	state.writeJson(SEEN_FILE, [...seenSet]);
}

// Returns newly-appeared regulations since the last check, and updates the
// seen-state file. First-ever run seeds the state without reporting
// anything (avoids a false "20 new regulations" dump on first boot).
async function checkForNew() {
	const latest = await fetchLatest(20);
	const seen = loadSeen();
	const isFirstRun = seen.size === 0;
	const newItems = latest.filter((item) => !seen.has(item.slug));
	latest.forEach((item) => seen.add(item.slug));
	saveSeen(seen);
	return isFirstRun ? [] : newItems;
}

// Prompt lives in .claude/skills/reg-digest/SKILL.md.
async function synthesizeOverview(items, chat) {
	if (items.length === 0) return '';
	const listing = items.map((it) => `${it.number}: ${it.title}`).join('\n');
	return skills.runFast('reg-digest', listing, chat);
}

const WIB_OFFSET_MS = 7 * 3600 * 1000;

function msUntilNextWibHour(hour) {
	const nowUtc = Date.now();
	const nowWib = new Date(nowUtc + WIB_OFFSET_MS);
	const targetUtc = Date.UTC(nowWib.getUTCFullYear(), nowWib.getUTCMonth(), nowWib.getUTCDate(), hour, 0, 0) - WIB_OFFSET_MS;
	return targetUtc > nowUtc ? targetUtc - nowUtc : targetUtc + 24 * 3600 * 1000 - nowUtc;
}

// Runs `callback` once at the next occurrence of `hourWib` (WIB, 0-23), then
// every 24h after — recomputed each time rather than a raw 24h interval, so
// it can't drift off the target hour.
function scheduleDaily(hourWib, callback) {
	const run = () => {
		callback().catch((err) => console.error('[regmonitor] scheduled check failed:', err.message));
		setTimeout(run, msUntilNextWibHour(hourWib));
	};
	setTimeout(run, msUntilNextWibHour(hourWib));
}

module.exports = { fetchLatest, checkForNew, synthesizeOverview, scheduleDaily, msUntilNextWibHour, ScrapeError };
