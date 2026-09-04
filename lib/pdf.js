const { PDFParse } = require('pdf-parse');

const MAX_PDF_BYTES = 50 * 1024 * 1024; // 50MB safety cap
const USER_AGENT = 'Mozilla/5.0 (compatible; telegram-idea-bridge/1.0)';

function isUrl(input) {
	return /^https?:\/\//i.test(input.trim());
}

// Title -> open-access PDF resolver via the Semantic Scholar API (JSON, no
// scraping). Best fit for research/paper titles; general web search engines
// (DuckDuckGo, Bing, arXiv's own API) are unreachable on this network, and
// Google's SERP requires JS to render results.
async function searchForPdfUrl(query, attempts = 4) {
	for (let i = 0; i < attempts; i++) {
		const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&fields=title,openAccessPdf&limit=5`;
		const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
		if (res.status === 429) {
			if (i < attempts - 1) await new Promise((r) => setTimeout(r, 5000 * (i + 1)));
			continue;
		}
		if (!res.ok) throw new Error(`Search failed: HTTP ${res.status}`);
		const json = await res.json();
		const hit = (json.data || []).find((paper) => paper.openAccessPdf?.url);
		if (hit) return hit.openAccessPdf.url;
		throw new Error(`No open-access PDF found for "${query}" — try sending a direct link instead`);
	}
	throw new Error('Search is rate-limited right now — try again in a minute, or send a direct link instead');
}

async function resolvePdfUrl(input) {
	if (isUrl(input)) return input.trim();
	return searchForPdfUrl(input.trim());
}

// Best-effort scan of a landing page for the actual PDF/download link: any
// href ending in .pdf, then any link whose href or text says "download".
function findPdfLinkInHtml(html, pageUrl) {
	const hrefPattern = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
	const candidates = [];
	let match;
	while ((match = hrefPattern.exec(html)) !== null) {
		candidates.push({ href: match[1], text: match[2].replace(/<[^>]+>/g, ' ').trim() });
	}

	const resolve = (href) => {
		try {
			return new URL(href, pageUrl).toString();
		} catch {
			return null;
		}
	};

	const pdfHref = candidates.find((c) => /\.pdf(\?|#|$)/i.test(c.href));
	if (pdfHref) return resolve(pdfHref.href);

	const downloadLink = candidates.find((c) => /download/i.test(c.href) || /download/i.test(c.text));
	if (downloadLink) return resolve(downloadLink.href);

	return null;
}

async function fetchPdfBuffer(url, { allowPageFallback = true } = {}) {
	const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
	if (!res.ok) throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);

	const contentType = res.headers.get('content-type') || '';
	const contentLength = Number(res.headers.get('content-length') || 0);
	if (contentLength > MAX_PDF_BYTES) {
		throw new Error(`PDF too large (${Math.round(contentLength / 1024 / 1024)}MB, limit 50MB)`);
	}

	const buffer = Buffer.from(await res.arrayBuffer());
	if (buffer.length > MAX_PDF_BYTES) {
		throw new Error(`PDF too large (${Math.round(buffer.length / 1024 / 1024)}MB, limit 50MB)`);
	}
	const looksLikePdf = contentType.includes('pdf') || buffer.subarray(0, 5).toString('latin1') === '%PDF-';
	if (looksLikePdf) return { buffer, finalUrl: res.url || url };

	// Not a PDF — if it's an HTML landing page, look for the real download link.
	if (allowPageFallback && contentType.includes('html')) {
		const html = buffer.toString('utf8');
		const pdfLink = findPdfLinkInHtml(html, url);
		if (pdfLink && pdfLink !== url) {
			return fetchPdfBuffer(pdfLink, { allowPageFallback: false });
		}
	}
	throw new Error(`URL did not return a PDF (content-type: ${contentType || 'unknown'})`);
}

async function extractText(buffer) {
	const parser = new PDFParse({ data: buffer });
	try {
		const result = await parser.getText();
		return result.text;
	} finally {
		await parser.destroy();
	}
}

module.exports = { isUrl, resolvePdfUrl, fetchPdfBuffer, extractText };
