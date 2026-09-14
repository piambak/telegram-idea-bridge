const skills = require('./skills');
const claude = require('./claude');

// Long/technical documents (e.g. regulation PDFs) get routed to the deep
// tier (long-doc-summarizer) for better context handling; shorter ones use
// the fast tier (summarize-short). Prompts live in
// .claude/skills/summarize-short/SKILL.md and .claude/skills/summarize-long/SKILL.md.
const CLAUDE_LENGTH_THRESHOLD = 20000; // chars
const MAX_INPUT_CHARS = 60000;

// summarize-long returns structured JSON; reassembled into the same
// overview/bullets/next-action plain-text shape summarize-short already
// produces, so the reply looks the same to the user regardless of which
// tier handled it. Falls back to the raw text if the CLI didn't return the
// expected JSON shape (e.g. a schema mismatch on a fallback path).
function formatLongSummary(data) {
	if (!data || typeof data !== 'object') return String(data || '');
	const bullets = (data.key_points || []).map((p) => `• ${p}`).join('\n');
	return [data.overview, bullets, data.next_action].filter(Boolean).join('\n\n');
}

async function summarize(text, chat, title = 'Document') {
	const excerpt = text.slice(0, MAX_INPUT_CHARS);
	if (text.length > CLAUDE_LENGTH_THRESHOLD) {
		// The document goes to the CLI's stdin, never argv (docs/ANALYSIS.md bug #1).
		const result = await claude.runSkill('summarize-long', title, {
			stdin: excerpt,
			schema: skills.schemaFor('summarize-long'),
			agent: 'long-doc-summarizer',
			timeoutMs: 5 * 60 * 1000,
		});
		if (!result.ok) throw new Error(result.error || 'Claude CLI failed to summarize');
		return formatLongSummary(result.data);
	}
	return skills.runFast('summarize-short', excerpt, chat);
}

module.exports = { summarize, CLAUDE_LENGTH_THRESHOLD };
