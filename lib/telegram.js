const { telegramToken } = require('./config');

const API = `https://api.telegram.org/bot${telegramToken}`;

async function call(method, body, { timeoutMs = 15000 } = {}) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(`${API}/${method}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body || {}),
			signal: controller.signal,
		});
		const json = await res.json();
		if (!json.ok) throw new Error(`Telegram ${method} failed: ${json.description}`);
		return json.result;
	} finally {
		clearTimeout(timer);
	}
}

function getUpdates(offset) {
	// The server holds this connection open up to `timeout` seconds waiting
	// for a new update (long polling), so the client timeout must be
	// comfortably longer than that — otherwise every idle poll would abort
	// itself. Without any client-side timeout at all, a network blip could
	// hang the poll loop forever (docs/ANALYSIS.md bug #21).
	return call('getUpdates', { offset, timeout: 30 }, { timeoutMs: 35000 });
}

function sendMessage(chatId, text, extra) {
	return call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });
}

function sendChatAction(chatId, action) {
	return call('sendChatAction', { chat_id: chatId, action });
}

function setMyCommands(commands) {
	return call('setMyCommands', { commands });
}

async function getFile(fileId) {
	return call('getFile', { file_id: fileId });
}

async function downloadFile(filePath) {
	const res = await fetch(`https://api.telegram.org/file/bot${telegramToken}/${filePath}`);
	if (!res.ok) throw new Error(`Telegram file download failed: HTTP ${res.status}`);
	return Buffer.from(await res.arrayBuffer());
}

function sendDocument(chatId, buffer, filename, caption) {
	const form = new FormData();
	form.append('chat_id', String(chatId));
	if (caption) {
		form.append('caption', caption);
		form.append('parse_mode', 'HTML');
	}
	form.append('document', new Blob([buffer]), filename);
	return fetch(`${API}/sendDocument`, { method: 'POST', body: form }).then(async (res) => {
		const json = await res.json();
		if (!json.ok) throw new Error(`Telegram sendDocument failed: ${json.description}`);
		return json.result;
	});
}

// By direct image URL — Telegram fetches it server-side, no download/upload
// needed on our end. Use this (not sendMediaGroup) for a single photo:
// sendMediaGroup requires 2-10 items and errors on fewer (docs/ANALYSIS.md
// bug #6).
function sendPhoto(chatId, photoUrl, caption) {
	return call('sendPhoto', { chat_id: chatId, photo: photoUrl, ...(caption ? { caption, parse_mode: 'HTML' } : {}) });
}

// items: [{ url, caption? }] by direct image URL — Telegram fetches them
// server-side, so no download/upload needed on our end. 2-10 items.
function sendMediaGroup(chatId, items) {
	const media = items.map((it, i) => ({
		type: 'photo',
		media: it.url,
		...(it.caption ? { caption: it.caption, parse_mode: 'HTML' } : {}),
	}));
	return call('sendMediaGroup', { chat_id: chatId, media });
}

module.exports = {
	call,
	getUpdates,
	sendMessage,
	sendChatAction,
	setMyCommands,
	getFile,
	downloadFile,
	sendDocument,
	sendPhoto,
	sendMediaGroup,
};
