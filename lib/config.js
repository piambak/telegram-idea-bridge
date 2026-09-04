const fs = require('fs');
const path = require('path');

function loadEnv(envPath) {
	const out = {};
	if (!fs.existsSync(envPath)) return out;
	for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const eq = trimmed.indexOf('=');
		if (eq === -1) continue;
		out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
	}
	return out;
}

const env = { ...loadEnv(path.join(__dirname, '..', '.env')), ...process.env };

function required(name) {
	const value = env[name];
	if (!value) throw new Error(`Missing required env var: ${name}`);
	return value;
}

module.exports = {
	env,
	telegramToken: required('TELEGRAM_BOT_TOKEN'),
	allowedChatId: Number(required('TELEGRAM_ALLOWED_CHAT_ID')),
	ollamaBaseUrl: env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
	ollamaModel: env.OLLAMA_MODEL || 'qwen3:4b',
	knowledgeBaseDir: env.OPENKNOWLEDGE_DIR || path.join(require('os').homedir(), 'openknowledge'),
};
