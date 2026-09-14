const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process'); // not destructured — lets tests mock cp.execFile
const { knowledgeBaseDir, env } = require('./config');

const SOURCE_DIR = path.join(knowledgeBaseDir, 'notes');
// Override lets tests point this at a tmp git repo instead of the real
// personal vault.
const VAULT_DIR = env.OBSIDIAN_VAULT_DIR || path.join(os.homedir(), 'obsidian-vault');

function run(args) {
	return new Promise((resolve, reject) => {
		cp.execFile('git', args, { cwd: VAULT_DIR, timeout: 30000 }, (err, stdout, stderr) => {
			if (err) {
				const e = new Error(stderr || stdout || err.message);
				e.stdout = stdout;
				return reject(e);
			}
			resolve(stdout);
		});
	});
}

// Runs `task` after every previously-queued task has settled (success or
// failure), instead of letting it start immediately. An idea and a /todo add
// arriving together used to fire two `git commit`s at once in the same
// working tree, producing an index.lock failure that syncVaultQuietly then
// swallowed (docs/ANALYSIS.md bug #5). Each call still gets its own
// resolution/rejection — only the ordering across calls is shared, and one
// task rejecting must not jam the queue for the ones after it.
let queue = Promise.resolve();
function serialized(task) {
	const result = queue.then(task, task);
	queue = result.catch(() => {});
	return result;
}

// Set on a sync failure, cleared on the next success, so a caller (e.g. a
// future /status command) can report "mirror stale since <at>" instead of
// the failure only ever reaching the log.
let lastError = null;

function getLastError() {
	return lastError;
}

async function doSync(message) {
	if (!fs.existsSync(VAULT_DIR)) return;
	// A missing source dir is a bug, not an instruction to empty the vault:
	// readdirSync would throw here, and syncVaultQuietly swallows it, leaving
	// the mirror silently frozen. Say so instead.
	if (!fs.existsSync(SOURCE_DIR)) {
		throw new Error(`Vault sync source is missing: ${SOURCE_DIR}`);
	}
	const sourceFiles = new Set(fs.readdirSync(SOURCE_DIR).filter((f) => f.endsWith('.md')));
	const vaultFiles = fs.readdirSync(VAULT_DIR).filter((f) => f.endsWith('.md'));

	// Refuse to mirror an empty (or near-empty) source over a populated vault.
	// Every deletion here is real data loss recoverable only from git history,
	// so a source that lost most of its files is treated as a fault, not as an
	// intent to delete. Genuine bulk deletions can be pushed from the vault repo.
	const deletions = vaultFiles.filter((f) => !sourceFiles.has(f));
	const WIPEOUT_GUARD = 3; // below this many survivors, assume something broke
	if (deletions.length > WIPEOUT_GUARD && deletions.length >= vaultFiles.length) {
		throw new Error(
			`Refusing to sync: it would delete all ${deletions.length} vault file(s). ` +
				`Source ${SOURCE_DIR} has ${sourceFiles.size} .md file(s) — check it before syncing.`,
		);
	}

	for (const file of sourceFiles) {
		fs.copyFileSync(path.join(SOURCE_DIR, file), path.join(VAULT_DIR, file));
	}
	for (const file of deletions) {
		fs.unlinkSync(path.join(VAULT_DIR, file));
	}

	await run(['add', '-A']);
	try {
		await run(['commit', '-m', message || 'Sync from bridge']);
	} catch (err) {
		if (!/nothing to commit/i.test(err.message)) throw err;
		return; // no changes, nothing to push
	}
	// Push the branch the vault repo is actually on rather than a hardcoded
	// name, so a rename or a detached HEAD fails loudly instead of silently.
	const branch = (await run(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
	if (!branch || branch === 'HEAD') throw new Error(`Vault repo is not on a branch (got "${branch}")`);
	await run(['push', 'origin', branch]);
}

// One-way mirror of notes/ (ideas + to-do) into the personal Obsidian vault,
// then commit + push to the private GitHub repo. External-sources (which may
// contain captured DJP documents) are deliberately NOT included. A true
// mirror: files removed from the source are removed from the vault too.
// Concurrent calls are serialized (see `serialized` above) rather than
// racing each other's git commands; still rejects on failure so a caller
// that wants to know can — syncVaultQuietly in bridge.js is the one that
// swallows it for the user-facing reply.
function sync(message) {
	return serialized(async () => {
		try {
			await doSync(message);
			lastError = null;
		} catch (err) {
			lastError = { message: err.message, at: new Date() };
			throw err;
		}
	});
}

module.exports = { sync, VAULT_DIR, getLastError };
