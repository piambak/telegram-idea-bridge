const { ollamaBaseUrl, ollamaModel } = require('./config');

function stripThinking(text) {
	// Matched <think>...</think> pairs, when the model emits them.
	let out = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
	// Some Ollama/Qwen3 responses emit only a trailing "</think>" marker with
	// no opening tag (the open tag is implicit in the chat template) — in
	// that case everything up to the LAST closing marker is reasoning noise.
	const lastClose = out.lastIndexOf('</think>');
	if (lastClose !== -1) out = out.slice(lastClose + '</think>'.length);
	return out.trim();
}

async function chatOnce(messages, timeoutMs) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(`${ollamaBaseUrl}/api/chat`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ model: ollamaModel, messages, think: false, stream: false }),
			signal: controller.signal,
		});
		if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);
		const json = await res.json();
		return stripThinking(json.message?.content || '');
	} catch (err) {
		const cause = err.cause ? ` (${err.cause.code || err.cause.message || err.cause})` : '';
		throw new Error(`${err.message}${cause}`);
	} finally {
		clearTimeout(timer);
	}
}

async function chat(messages, { timeoutMs = 15 * 60 * 1000, retries = 1 } = {}) {
	let lastErr;
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			return await chatOnce(messages, timeoutMs);
		} catch (err) {
			lastErr = err;
			if (attempt < retries) await new Promise((r) => setTimeout(r, 3000));
		}
	}
	throw lastErr;
}

module.exports = { chat, stripThinking };
