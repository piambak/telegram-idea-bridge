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
	// Check res.ok before parsing: a down/misbehaving bridge can return a
	// non-JSON body (e.g. an HTML 502 page), and res.json() on that surfaces
	// a confusing "Unexpected token <" instead of what actually happened
	// (docs/ANALYSIS.md bug #8).
	if (!res.ok) throw new Error(`WhatsApp bridge is down (HTTP ${res.status})`);
	const json = await res.json();
	if (!json.success) throw new Error(json.error || 'WhatsApp bridge rejected the message');
	return json;
}

module.exports = { sendToGroup };
