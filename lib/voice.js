const { env } = require('./config');

const TRANSCRIBE_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';

// docs/V2-SPEC.md §7: GROQ_WHISPER_MODEL, defaulting to Groq's free-tier
// fast Whisper model.
function whisperModel() {
	return env.GROQ_WHISPER_MODEL || 'whisper-large-v3-turbo';
}

// Transcribes a downloaded Telegram voice note (OGG/Opus) via Groq's
// Whisper endpoint. The transcript is handled exactly like typed text
// afterwards — it can turn out to be an idea or a command
// (docs/V2-SPEC.md §1).
async function transcribe(buffer, filename = 'voice.ogg') {
	const apiKey = env.GROQ_API_KEY;
	if (!apiKey) throw new Error('Not configured — set GROQ_API_KEY');
	const form = new FormData();
	form.append('model', whisperModel());
	form.append('file', new Blob([buffer]), filename);
	const res = await fetch(TRANSCRIBE_URL, {
		method: 'POST',
		headers: { Authorization: `Bearer ${apiKey}` },
		body: form,
	});
	if (!res.ok) throw new Error(`Groq transcription failed: HTTP ${res.status}: ${await res.text()}`);
	const json = await res.json();
	const text = (json.text || '').trim();
	if (!text) throw new Error('Groq transcription returned no text');
	return text;
}

module.exports = { transcribe, whisperModel };
