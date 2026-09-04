const { env } = require('./config');

const REFINE_PROMPT = `You turn a rough banner/design idea into a good English stock-photo search
query (2-5 words, concrete and visual). Respond with ONLY the search query, no quotes, no
explanation. Example: "banner promosi natal kantor" -> "office christmas celebration banner"`;

async function refineKeyword(keyword, chat) {
	try {
		const refined = await chat([
			{ role: 'system', content: REFINE_PROMPT },
			{ role: 'user', content: keyword },
		]);
		return refined.trim().replace(/^"|"$/g, '') || keyword;
	} catch {
		return keyword;
	}
}

async function searchImages(query, { perPage = 6 } = {}) {
	const apiKey = env.PEXELS_API_KEY;
	if (!apiKey) throw new Error('Not configured — set PEXELS_API_KEY');
	const res = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${perPage}`, {
		headers: { Authorization: apiKey },
	});
	if (!res.ok) throw new Error(`Pexels search failed: HTTP ${res.status}`);
	const json = await res.json();
	return (json.photos || []).map((p) => ({
		imageUrl: p.src.large,
		pageUrl: p.url,
		photographer: p.photographer,
		alt: p.alt || '',
	}));
}

module.exports = { refineKeyword, searchImages };
