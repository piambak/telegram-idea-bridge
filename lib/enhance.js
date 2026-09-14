const ENHANCE_SYSTEM_PROMPT = `You are an idea-development assistant. The user will send you a raw, possibly rough idea.
Respond with EXACTLY this structure and nothing else:

TITLE: <a short, specific title, under 8 words>
TAGS: <2-5 comma-separated lowercase tags>

<2-4 short paragraphs that: clarify and sharpen the idea, point out the strongest angle, flag one real risk or open question, and suggest one concrete next step>

Reply in the same language as the user's input — do not translate it.

Do not add headers, preambles, or meta-commentary. Do not ask the user questions.`;

// Provider-agnostic: works with any chat(messages) -> text function,
// whether it's the local Ollama client or a cloud OpenAI-compatible one.
async function enhanceIdea(rawIdea, chat) {
	const content = await chat([
		{ role: 'system', content: ENHANCE_SYSTEM_PROMPT },
		{ role: 'user', content: rawIdea },
	]);

	const titleMatch = content.match(/^TITLE:\s*(.+)$/im);
	const tagsMatch = content.match(/^TAGS:\s*(.+)$/im);
	const title = titleMatch ? titleMatch[1].trim() : rawIdea.slice(0, 60);
	const tags = tagsMatch
		? tagsMatch[1].split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)
		: [];
	const body = content
		.replace(/^TITLE:.*$/im, '')
		.replace(/^TAGS:.*$/im, '')
		.trim();

	return { title, tags, body };
}

module.exports = { enhanceIdea, ENHANCE_SYSTEM_PROMPT };
