const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'" };
function decodeEntities(s) {
	return s.replace(/&(amp|lt|gt|quot|#39|apos);/g, (_, e) => ENTITIES[e]);
}

function extractTag(block, tag) {
	const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
	return match ? decodeEntities(match[1].trim()) : '';
}

async function fetchHeadlines(topic, { lang = 'id', country = 'ID', limit = 8 } = {}) {
	const ceid = `${country}:${lang}`;
	const url = `https://news.google.com/rss/search?q=${encodeURIComponent(topic)}&hl=${lang}&gl=${country}&ceid=${ceid}`;
	const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
	if (!res.ok) throw new Error(`News fetch failed: HTTP ${res.status}`);
	const xml = await res.text();

	const items = [];
	const itemPattern = /<item>([\s\S]*?)<\/item>/g;
	let match;
	while ((match = itemPattern.exec(xml)) !== null && items.length < limit) {
		const block = match[1];
		const rawTitle = extractTag(block, 'title');
		// Google News titles are usually "Headline - Source"; split for a cleaner display.
		const sepIdx = rawTitle.lastIndexOf(' - ');
		const title = sepIdx > 0 ? rawTitle.slice(0, sepIdx) : rawTitle;
		const source = sepIdx > 0 ? rawTitle.slice(sepIdx + 3) : '';
		items.push({
			title,
			source,
			link: extractTag(block, 'link'),
			pubDate: extractTag(block, 'pubDate'),
		});
	}
	return items;
}

const DIGEST_PROMPT = `You are a news analyst. The user will give you a list of recent headlines
about one topic. Write a short synthesized overview (3-5 sentences) of what's happening based on
these headlines — the general trend or theme, not a headline-by-headline recap. Return ONLY the
overview text, no preamble.`;

async function synthesizeDigest(headlines, chat) {
	const listing = headlines.map((h, i) => `${i + 1}. ${h.title} (${h.source})`).join('\n');
	return chat([
		{ role: 'system', content: DIGEST_PROMPT },
		{ role: 'user', content: listing },
	]);
}

module.exports = { fetchHeadlines, synthesizeDigest };
