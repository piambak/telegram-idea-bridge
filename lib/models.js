const ollama = require('./ollama');
const { env } = require('./config');

// Generic OpenAI-compatible chat/completions client, for any cloud provider
// that speaks the same wire format (Gemini, Groq, Grok/xAI, OpenRouter, ...).
// Reads keys from lib/config's merged env (.env file + process.env) rather
// than raw process.env — Windows persistent env vars only reach processes
// spawned fresh after the change, not descendants of already-running shells.
// Transient upstream failures worth a second attempt. 429 = rate limit,
// 5xx = provider-side wobble (Gemini returns 503 "high demand" routinely).
// Deliberately NOT 4xx auth/validation errors: a bad key fails the same way
// three times, so retrying only delays a clear message.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function isRetryable(err) {
	if (err.status && RETRYABLE_STATUS.has(err.status)) return true;
	// Network-level faults (DNS, reset, refused) surface as a cause code.
	return Boolean(err.cause && !err.status);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeOpenAICompatChat({ baseUrl, model, apiKeyEnv, getStartHelp }) {
	async function attempt(messages, timeoutMs) {
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
			if (!res.ok) {
				const err = new Error(`HTTP ${res.status}: ${await res.text()}`);
				err.status = res.status; // lets isRetryable() tell 503 from 401
				throw err;
			}
			const json = await res.json();
			return (json.choices?.[0]?.message?.content || '').trim();
		} finally {
			clearTimeout(timer);
		}
	}

	// Retries transient failures with backoff, then rethrows with the same
	// message shape the callers already surface to Telegram.
	return async function chat(messages, { timeoutMs = 2 * 60 * 1000, retries = 2 } = {}) {
		let lastErr;
		for (let i = 0; i <= retries; i++) {
			try {
				return await attempt(messages, timeoutMs);
			} catch (err) {
				lastErr = err;
				const timedOut = err.name === 'AbortError';
				if (i === retries || timedOut || !isRetryable(err)) break;
				await sleep(1000 * 2 ** i); // 1s, 2s
			}
		}
		const cause = lastErr.cause ? ` (${lastErr.cause.code || lastErr.cause.message || lastErr.cause})` : '';
		const abortNote = lastErr.name === 'AbortError' ? ' (timed out — endpoint may be unreachable from this network)' : '';
		throw new Error(`${lastErr.message}${cause}${abortNote}`);
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
		label: 'Gemini (free tier) — works, but slow (~15-45s: the flash model emits reasoning tokens) and 503s under load',
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

// Per-job default model. A job only needs an entry here when it wants
// something other than DEFAULT_MODEL; an explicit "<alias>: text" override
// always wins over both.
//
// Measured 2026-09-04 on this machine (i5-7400, 4 cores, no GPU): local
// qwen3:4b takes 33s for a one-word reply and over 120s for a real
// broadcast draft. So routing internal/office content to a local model for
// privacy is NOT viable here — it would turn every /broadcast into a
// two-minute wait. Everything interactive stays on the cloud default.
// Revisit if this ever runs on a GPU box.
const JOB_MODELS = {
	// Unattended daily job: latency is irrelevant, so use the steadier
	// single provider rather than the fallback chain.
	regcheck: 'ollamacloud',
};

function modelForJob(job) {
	const alias = JOB_MODELS[job];
	return alias && MODELS[alias] ? alias : DEFAULT_MODEL;
}

// A message may start with "<alias>: rest of message" to route just that
// one job to a specific model. Only strips the prefix when the alias is a
// known key, so ordinary text with a colon ("Note: buy milk") is untouched.
// `job` picks the fallback default via JOB_MODELS when the message carries
// no explicit "<alias>:" prefix. Omitting it keeps the old behaviour
// (DEFAULT_MODEL), so existing callers are unaffected.
function parseModelOverride(text, job) {
	const match = text.match(/^([a-zA-Z][\w-]*):\s*([\s\S]+)$/);
	if (match) {
		const alias = match[1].toLowerCase();
		if (MODELS[alias]) return { modelKey: alias, rest: match[2].trim() };
	}
	return { modelKey: modelForJob(job), rest: text };
}

module.exports = { MODELS, DEFAULT_MODEL, JOB_MODELS, modelForJob, parseModelOverride, makeOpenAICompatChat };
