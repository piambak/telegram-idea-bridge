// Called by the Hermes weekly self-review cron job after it writes a new
// notes/weekly-review-<date>.md file: syncs the vault mirror and pings Telegram.
const path = require('path');
const telegram = require('./lib/telegram');
const vaultsync = require('./lib/vaultsync');
const { allowedChatId } = require('./lib/config');

async function main() {
	const filename = process.argv[2];
	if (!filename) {
		console.error('Usage: node notify-review.js <weekly-review-filename.md>');
		process.exit(1);
	}
	await vaultsync.sync(`Weekly self-review: ${filename}`);
	await telegram.sendMessage(
		allowedChatId,
		`📚 <b>Weekly notes review is ready</b>\nCheck notes/${path.basename(filename)} (or /get after /list)`,
	);
	console.log('notified and synced');
}

main().catch((err) => {
	console.error('notify-review failed:', err.message);
	process.exit(1);
});
