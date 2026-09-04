const { env } = require('./config');

// Testing-mode OAuth app: Google issues a new refresh token each full
// consent, but access tokens are minted fresh from it per call (cheap, no
// caching needed for our low call volume).
async function getAccessToken() {
	const clientId = env.GOOGLE_CALENDAR_CLIENT_ID;
	const clientSecret = env.GOOGLE_CALENDAR_CLIENT_SECRET;
	const refreshToken = env.GOOGLE_CALENDAR_REFRESH_TOKEN;
	if (!clientId || !clientSecret || !refreshToken) {
		throw new Error('Google Calendar not configured — missing client id/secret/refresh token');
	}
	const res = await fetch('https://oauth2.googleapis.com/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: clientId,
			client_secret: clientSecret,
			refresh_token: refreshToken,
			grant_type: 'refresh_token',
		}),
	});
	const json = await res.json();
	if (!res.ok) {
		const hint = json.error === 'invalid_grant' ? ' (refresh token likely expired — re-run the Google auth setup)' : '';
		throw new Error(`Google token refresh failed: ${json.error_description || json.error}${hint}`);
	}
	return json.access_token;
}

// event: { title, start, end } — start/end as "YYYY-MM-DDTHH:MM" WIB local
// time (same shape schedule.js already produces for the .ics file).
async function createEvent({ title, start, end, location, description }) {
	const calendarId = env.GOOGLE_CALENDAR_ID;
	if (!calendarId) throw new Error('Google Calendar not configured — missing GOOGLE_CALENDAR_ID');
	const accessToken = await getAccessToken();

	const body = {
		summary: title,
		location: location || undefined,
		description: description || undefined,
		start: { dateTime: `${start}:00`, timeZone: 'Asia/Jakarta' },
		end: { dateTime: `${end}:00`, timeZone: 'Asia/Jakarta' },
	};

	const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	const json = await res.json();
	if (!res.ok) throw new Error(`Google Calendar event creation failed: ${json.error?.message || res.status}`);
	return { eventUrl: json.htmlLink, eventId: json.id };
}

module.exports = { createEvent };
