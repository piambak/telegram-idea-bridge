// Re-run this whenever GOOGLE_CALENDAR_REFRESH_TOKEN expires (Testing-mode
// apps: Google expires it after 7 days). Prints a new REFRESH_TOKEN= line —
// paste that value into .env to replace the old one.
//
// If run from a remote/background session (no local browser), open the
// printed URL on your phone instead, approve access, then when the phone
// shows "can't reach this page" copy the `code=...` param from its address
// bar and run:
//   node reauth-google-calendar.js --code "<paste code here>"
const http = require('http');
const { execSync } = require('child_process');
const { env } = require('./lib/config');

const CLIENT_ID = env.GOOGLE_CALENDAR_CLIENT_ID;
const CLIENT_SECRET = env.GOOGLE_CALENDAR_CLIENT_SECRET;
const PORT = 45678;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;
const SCOPE = 'https://www.googleapis.com/auth/calendar.events';

const authUrl =
	`https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(CLIENT_ID)}` +
	`&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=${encodeURIComponent(SCOPE)}` +
	`&access_type=offline&prompt=consent`;

async function exchange(code) {
	const res = await fetch('https://oauth2.googleapis.com/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			code,
			client_id: CLIENT_ID,
			client_secret: CLIENT_SECRET,
			redirect_uri: REDIRECT_URI,
			grant_type: 'authorization_code',
		}),
	});
	const tokens = await res.json();
	if (!tokens.refresh_token) throw new Error('No refresh_token in response: ' + JSON.stringify(tokens));
	console.log('REFRESH_TOKEN=' + tokens.refresh_token);
}

const manualCodeArg = process.argv.indexOf('--code');
if (manualCodeArg !== -1) {
	exchange(process.argv[manualCodeArg + 1]).catch((e) => console.error(e.message));
} else {
	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url, REDIRECT_URI);
		if (url.pathname !== '/callback') return res.writeHead(404).end();
		const code = url.searchParams.get('code');
		res.writeHead(200, { 'Content-Type': 'text/html' }).end('<h2>Authorized!</h2>You can close this tab now.');
		try {
			await exchange(code);
		} catch (e) {
			console.error(e.message);
		} finally {
			server.close();
		}
	});
	server.listen(PORT, () => {
		console.log('Waiting for authorization on', authUrl);
		try {
			execSync(`start "" "${authUrl}"`, { shell: 'cmd.exe' });
		} catch {
			console.log('Open this URL manually:', authUrl);
		}
	});
}
