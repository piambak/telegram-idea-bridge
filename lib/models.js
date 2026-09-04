const ollama = require('./ollama');
const { env } = require('./config');

// Generic OpenAI-compatible chat/completions client, for any cloud provider
// that speaks the same wire format (Gemini, Groq, Grok/xAI, OpenRouter, ...).
// Reads keys from lib/config's merged env (.env file + process.env) rather
// than raw process.env — Windows persistent env vars only reach processes
// spawned fresh after the change, not descendants of already-running shells.
function makeOpenAICompatChat({ baseUrl, model, apiKeyEnv, getStartHelp }) {
	return async function chat(messages, { timeoutMs = 2 * 60 * 1000 } = {}) {
		const apiKey = env[apiKeyEnv];
		if (!apiKey) {
			throw new Error(`Not configured yet — set ${apiKeyEnv}. ${getStartHelp || ''}`.trim());
		}
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const res = await fetch(`${baseUrl}/chat/completions`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
				body: JSON.stringify({ model, messages }),
				signal: controller.signal,
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
			const json = await res.json();
			return (json.choices?.[0]?.message?.content || '').trim();
		} catch (err) {
			const cause = err.cause ? ` (${err.cause.code || err.cause.message || err.cause})` : '';
			const abortNote = err.name === 'AbortError' ? ' (timed out — endpoint may be unreachable from this network)' : '';
			throw new Error(`${err.message}${cause}${abortNote}`);
		} finally {
			clearTimeout(timer);
		}
	};
}

// Raw single-provider chat functions, defined before MODELS so the fallback
// wrapper below can compose them without depending on object-literal order.
const groqChat = makeOpenAICompatChat({
	baseUrl: 'https://api.groq.com/openai/v1',
	model: 'openai/gpt-oss-120b',
	apiKeyEnv: 'GROQ_API_KEY',
	getStartHelp: 'Get one free at https://console.groq.com/keys',
});
const openrouterChat = makeOpenAICompatChat({
	baseUrl: 'https://openrouter.ai/api/v1',
	model: 'minimax/minimax-m2.7:free',
	apiKeyEnv: 'OPENROUTER_API_KEY',
	getStartHelp: 'Get one free at https://openrouter.ai/settings/keys',
});
const ollamacloudChat = makeOpenAICompatChat({
	baseUrl: 'https://ollama.com/v1',
	model: 'gpt-oss:20b',
	apiKeyEnv: 'OLLAMA_CLOUD_API_KEY',
	getStartHelp: 'Get one free at https://ollama.com/settings/keys',
});

// Tries each provider in order, moving on when one throws (missing key, rate
// limit, network block, timeout). Only used for the *default* selection —
// an explicit override ("gemini: ...", "qwen: ...") is respected as-is and
// fails transparently, since those are picked for a specific reason (privacy,
// testing a blocked endpoint) that a silent fallback would undermine.
function withFallback(chain) {
	return async function chat(messages, opts) {
		const errors = [];
		for (const fn of chain) {
			try {
				return await fn(messages, opts);
			} catch (err) {
				errors.push(err.message);
			}
		}
		throw new Error(`All fallback providers failed: ${errors.join(' | ')}`);
	};
}

// Model registry: alias -> { label, chat(messages) }. Add a provider here
// once it has a real API key; until then it fails with a clear message
// instead of silently falling back.
const MODELS = {
	qwen: {
		label: 'Qwen3 4B (local, via Ollama) — not recommended, this PC has no GPU and is too weak for reliable local inference',
		chat: ollama.chat,
	},
	gemini: {
		label: 'Gemini (free tier) — reachable, but often returns 503 under load',
		chat: makeOpenAICompatChat({
			baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
			model: 'gemini-flash-latest',
			apiKeyEnv: 'GEMINI_API_KEY',
			getStartHelp: 'Get one free at https://aistudio.google.com/apikey',
		}),
	},
	groq: {
		label: 'Groq (gpt-oss-120b), falls back to OpenRouter then Ollama Cloud if it fails — confirmed working, very fast',
		chat: withFallback([groqChat, openrouterChat, ollamacloudChat]),
	},
	ollamacloud: {
		label: 'Ollama Cloud (gpt-oss:20b, free tier) — confirmed working on this network',
		chat: ollamacloudChat,
	},
	openrouter: {
		label: 'OpenRouter (MiniMax M2.7, free) — confirmed working on this network',
		chat: openrouterChat,
	},
};

const DEFAULT_MODEL = 'groq';

// A message may start with "<alias>: rest of message" to route just that
// one job to a specific model. Only strips the prefix when the alias is a
// known key, so ordinary text with a colon ("Note: buy milk") is untouched.
function parseModelOverride(text) {
	const match = text.match(/^([a-zA-Z][\w-]*):\s*([\s\S]+)$/);
	if (match) {
		const alias = match[1].toLowerCase();
		if (MODELS[alias]) return { modelKey: alias, rest: match[2].trim() };
	}
	return { modelKey: DEFAULT_MODEL, rest: text };
}

module.exports = { MODELS, DEFAULT_MODEL, parseModelOverride };
