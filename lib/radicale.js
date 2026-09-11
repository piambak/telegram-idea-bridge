const { env } = require('./config');

// Local, self-hosted CalDAV server (Radicale) replacing Google Calendar —
// no OAuth, no verification/publishing hoops, runs on this same machine.
// Not part of this repo: C:\Users\<user>\radicale (venv + config), autostarted
// via a Startup-folder script rather than a Scheduled Task (Task Scheduler
// task creation is blocked by policy on this domain-joined machine; the
// Startup folder isn't).
async function pushEvent(uid, icsContent) {
	const baseUrl = env.RADICALE_URL;
	const user = env.RADICALE_USER;
	const password = env.RADICALE_PASSWORD;
	const calendar = env.RADICALE_CALENDAR || 'schedule';
	if (!baseUrl || !user || !password) {
		throw new Error('Radicale not configured — set RADICALE_URL, RADICALE_USER, RADICALE_PASSWORD');
	}
	const url = `${baseUrl.replace(/\/$/, '')}/${encodeURIComponent(user)}/${encodeURIComponent(calendar)}/${encodeURIComponent(uid)}.ics`;
	const auth = Buffer.from(`${user}:${password}`).toString('base64');
	const res = await fetch(url, {
		method: 'PUT',
		headers: { 'Content-Type': 'text/calendar; charset=utf-8', Authorization: `Basic ${auth}` },
		body: icsContent,
	});
	if (!res.ok) throw new Error(`Radicale push failed: HTTP ${res.status}`);
}

module.exports = { pushEvent };
