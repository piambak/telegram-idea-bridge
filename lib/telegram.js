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

// Edits an existing message's text in place — the mechanism ui.progress
// uses to post "⏳ …" once and turn that same message into the result,
// instead of a separate status message plus a separate result message.
function editMessageText(chatId, messageId, text, extra) {
	return call('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', ...extra });
}

// Stops the client's loading spinner on a pressed inline button. Telegram
// expects this within a few seconds of every callback_query, whether or not
// there's anything to say — `text` (a small toast) is optional.
function answerCallbackQuery(callbackQueryId, extra) {
	return call('answerCallbackQuery', { callback_query_id: callbackQueryId, ...extra });
}

function sendChatAction(chatId, action) {
	return call('sendChatAction', { chat_id: chatId, action });
}

function setMyCommands(commands) {
	return call('setMyCommands', { commands });
}

// The bot's About-section text (long form) and the one-line description
// shown before a chat is started / in forwarded-message previews.
function setMyDescription(description) {
	return call('setMyDescription', { description });
}
function setMyShortDescription(shortDescription) {
	return call('setMyShortDescription', { short_description: shortDescription });
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
	editMessageText,
	answerCallbackQuery,
	sendChatAction,
	setMyCommands,
	setMyDescription,
	setMyShortDescription,
	getFile,
	downloadFile,
	sendDocument,
	sendPhoto,
	sendMediaGroup,
};
