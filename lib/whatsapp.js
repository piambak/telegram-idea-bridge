const { env } = require('./config');

// Cross-project dependency: this is hermes-agent's WhatsApp bridge, not part
// of this repo — AppData/Local/hermes/hermes-agent/scripts/whatsapp-bridge.
// If /send fails with ECONNREFUSED, that process is what needs restarting.
const BRIDGE_URL = 'http://127.0.0.1:3000';

async function sendToGroup(message) {
	const chatId = env.WHATSAPP_GROUP_ID;
	if (!chatId) throw new Error('WHATSAPP_GROUP_ID not configured');
	const res = await fetch(`${BRIDGE_URL}/send`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ chatId, message }),
	});
	const json = await res.json();
	if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
	return json;
}

module.exports = { sendToGroup };
