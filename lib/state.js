const fs = require('fs');
const path = require('path');
const { stateDir } = require('./config');

// Nothing under .state/ is ever committed (gitignored) — it's rewritten on
// every run (the Telegram offset, regmonitor's seen-set, pending button
// payloads) and has no value in history.
function ensureDir() {
	fs.mkdirSync(stateDir, { recursive: true });
}

function statePath(name) {
	return path.join(stateDir, name);
}

function readJson(name, fallback) {
	try {
		return JSON.parse(fs.readFileSync(statePath(name), 'utf8'));
	} catch {
		return fallback;
	}
}

function writeJson(name, value) {
	ensureDir();
	fs.writeFileSync(statePath(name), JSON.stringify(value), 'utf8');
}

// Moves a pre-.state/ file (e.g. the old repo-root seen-regulations.json,
// bug #7 — it used to be tracked and rewritten daily, permanently dirtying
// the tree) into .state/<name>, once. A no-op if .state/<name> already
// exists (already migrated, or created fresh — either way it wins) or the
// old file doesn't exist. Safe to call unconditionally on every boot.
function migrateLegacyFile(oldPath, name) {
	const dest = statePath(name);
	if (fs.existsSync(dest) || !fs.existsSync(oldPath)) return false;
	ensureDir();
	fs.renameSync(oldPath, dest);
	return true;
}

module.exports = { stateDir, statePath, readJson, writeJson, migrateLegacyFile, ensureDir };
