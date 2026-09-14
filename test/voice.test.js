const { test } = require('node:test');
const assert = require('node:assert');

process.env.GROQ_API_KEY = 'test-key';
const voice = require('../lib/voice');

test('transcribe() posts the audio to Groq Whisper and returns the trimmed text', async (t) => {
	let seenUrl;
	let seenAuth;
	let seenForm;
	t.mock.method(global, 'fetch', async (url, opts) => {
		seenUrl = url;
		seenAuth = opts.headers.Authorization;
		seenForm = opts.body;
		return { ok: true, json: async () => ({ text: '  rapat besok jam sepuluh  ' }) };
	});

	const text = await voice.transcribe(Buffer.from([1, 2, 3]), 'note.ogg');

	assert.strictEqual(text, 'rapat besok jam sepuluh');
	assert.strictEqual(seenUrl, 'https://api.groq.com/openai/v1/audio/transcriptions');
	assert.strictEqual(seenAuth, 'Bearer test-key');
	assert.ok(seenForm instanceof FormData);
	assert.strictEqual(seenForm.get('model'), 'whisper-large-v3-turbo');
});

test('whisperModel() honors GROQ_WHISPER_MODEL, defaults to whisper-large-v3-turbo', () => {
	assert.strictEqual(voice.whisperModel(), 'whisper-large-v3-turbo');
});

test('transcribe() surfaces a clear error on an HTTP failure', async (t) => {
	t.mock.method(global, 'fetch', async () => ({ ok: false, status: 500, text: async () => 'server error' }));
	await assert.rejects(() => voice.transcribe(Buffer.from([1])), /Groq transcription failed: HTTP 500/);
});

test('transcribe() rejects when Groq returns no text (e.g. silence)', async (t) => {
	t.mock.method(global, 'fetch', async () => ({ ok: true, json: async () => ({ text: '' }) }));
	await assert.rejects(() => voice.transcribe(Buffer.from([1])), /returned no text/);
});

test('transcribe() rejects clearly when GROQ_API_KEY is not configured', async () => {
	// lib/config's env is a shared, mutable object read at call time (not
	// cached at module load) — mutate it directly rather than busting the
	// require cache.
	const { env } = require('../lib/config');
	const original = env.GROQ_API_KEY;
	delete env.GROQ_API_KEY;
	try {
		await assert.rejects(() => voice.transcribe(Buffer.from([1])), /Not configured.*GROQ_API_KEY/);
	} finally {
		env.GROQ_API_KEY = original;
	}
});
