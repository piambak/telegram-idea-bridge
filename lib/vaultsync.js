const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { knowledgeBaseDir } = require('./config');

const SOURCE_DIR = path.join(knowledgeBaseDir, 'notes');
const VAULT_DIR = path.join(os.homedir(), 'obsidian-vault');

function run(args) {
	return new Promise((resolve, reject) => {
		execFile('git', args, { cwd: VAULT_DIR, timeout: 30000 }, (err, stdout, stderr) => {
			if (err) {
				const e = new Error(stderr || stdout || err.message);
				e.stdout = stdout;
				return reject(e);
			}
			resolve(stdout);
		});
	});
}

// One-way mirror of notes/ (ideas + to-do) into the personal Obsidian vault,
// then commit + push to the private GitHub repo. External-sources (which may
// contain captured DJP documents) are deliberately NOT included. A true
// mirror: files removed from the source are removed from the vault too.
async function sync(message) {
	if (!fs.existsSync(VAULT_DIR)) return;
	const sourceFiles = new Set(fs.readdirSync(SOURCE_DIR).filter((f) => f.endsWith('.md')));
	const vaultFiles = fs.readdirSync(VAULT_DIR).filter((f) => f.endsWith('.md'));

	for (const file of sourceFiles) {
		fs.copyFileSync(path.join(SOURCE_DIR, file), path.join(VAULT_DIR, file));
	}
	for (const file of vaultFiles) {
		if (!sourceFiles.has(file)) fs.unlinkSync(path.join(VAULT_DIR, file));
	}

	await run(['add', '-A']);
	try {
		await run(['commit', '-m', message || 'Sync from bridge']);
	} catch (err) {
		if (!/nothing to commit/i.test(err.message)) throw err;
		return; // no changes, nothing to push
	}
	await run(['push', 'origin', 'main']);
}

module.exports = { sync, VAULT_DIR };
