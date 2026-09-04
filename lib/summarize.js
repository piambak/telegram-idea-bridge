const claudeCli = require('./claude');

const SUMMARY_PROMPT = `You are a document summarizer. Summarize the following document so someone
can quickly resume/catch up on it later. Structure your reply as:
1) a 2-3 sentence overview
2) 3-6 bullet key points
3) one line on why it matters or a next action, if relevant
Be concise. Return ONLY the summary, no preamble, no headers other than what's implied above.`;

// Long/technical documents (e.g. regulation PDFs) get routed to the local
// Claude CLI for better context handling; shorter ones use the fast free model.
const CLAUDE_LENGTH_THRESHOLD = 20000; // chars
const MAX_INPUT_CHARS = 60000;

async function summarize(text, chat) {
	const excerpt = text.slice(0, MAX_INPUT_CHARS);
	if (text.length > CLAUDE_LENGTH_THRESHOLD) {
		return claudeCli.runHeadless(`${SUMMARY_PROMPT}\n\n---\n\n${excerpt}`, { timeoutMs: 5 * 60 * 1000 });
	}
	return chat([
		{ role: 'system', content: SUMMARY_PROMPT },
		{ role: 'user', content: excerpt },
	]);
}

module.exports = { summarize, CLAUDE_LENGTH_THRESHOLD };
