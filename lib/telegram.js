const { telegramToken } = require('./config');

const API = `https://api.telegram.org/bot${telegramToken}`;

async function call(method, body) {
	const res = await fetch(`${API}/${method}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body || {}),
	});
	const json = await res.json();
	if (!json.ok) throw new Error(`Telegram ${method} failed: ${json.description}`);
	return json.result;
}

function getUpdates(offset) {
	return call('getUpdates', { offset, timeout: 30 });
}

function sendMessage(chatId, text) {
	return call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' });
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
	getUpdates,
	sendMessage,
	sendChatAction,
	setMyCommands,
	getFile,
	downloadFile,
	sendDocument,
	sendMediaGroup,
};
