const { env } = require('./config');
const skills = require('./skills');

// Prompt lives in .claude/skills/image-query/SKILL.md.
async function refineKeyword(keyword, chat) {
	try {
		const refined = await skills.runFast('image-query', keyword, chat);
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
