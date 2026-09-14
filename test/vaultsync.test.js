const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('child_process'); // same specifier vaultsync.js uses

// OBSIDIAN_VAULT_DIR/OPENKNOWLEDGE_DIR must be set before lib/config (and
// therefore lib/vaultsync) is first required, so the module never touches
// the real personal vault or the real OpenKnowledge dir.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-bridge-vaultsync-'));
const vaultDir = path.join(tmpRoot, 'obsidian-vault');
const notesDir = path.join(tmpRoot, 'openknowledge', 'notes');
fs.mkdirSync(vaultDir, { recursive: true });
fs.mkdirSync(notesDir, { recursive: true });
fs.writeFileSync(path.join(notesDir, 'idea-one.md'), '# Idea one', 'utf8');
process.env.OBSIDIAN_VAULT_DIR = vaultDir;
process.env.OPENKNOWLEDGE_DIR = path.join(tmpRoot, 'openknowledge');

const vaultsync = require('../lib/vaultsync');

test.after(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	delete process.env.OBSIDIAN_VAULT_DIR;
	delete process.env.OPENKNOWLEDGE_DIR;
});

// Stubs child_process.execFile (what vaultsync's run() calls for every git
// command) to resolve after a real async delay instead of running git for
// real — this creates the same race window a missing mutex would lose, and
// lets the test prove no two git commands from different sync() calls ever
// overlap. `rev-parse --abbrev-ref HEAD` must return a real branch name or
// doSync() throws "not on a branch".
function stubGit(t, { delayMs = 15, failOn } = {}) {
	let active = 0;
	let maxActive = 0;
	const calls = [];
	t.mock.method(cp, 'execFile', (file, args, opts, cb) => {
		calls.push([...args]);
		active++;
		maxActive = Math.max(maxActive, active);
		setTimeout(() => {
			active--;
			if (failOn && args.includes(failOn)) {
				return cb(new Error(`simulated git failure on ${failOn}`), '', `simulated git failure on ${failOn}`);
			}
			const stdout = args[0] === 'rev-parse' ? 'main\n' : '';
			cb(null, stdout, '');
		}, delayMs);
	});
	return { calls, getMaxActive: () => maxActive };
}

test('two concurrent sync() calls never overlap their git commands', async (t) => {
	const { calls, getMaxActive } = stubGit(t);

	const results = await Promise.all([vaultsync.sync('first idea'), vaultsync.sync('second idea')]);

	assert.strictEqual(results.length, 2);
	assert.strictEqual(getMaxActive(), 1, 'a second sync() must not start its git commands before the first one finishes');
	// each successful sync runs add, commit, rev-parse, push
	assert.strictEqual(calls.length, 8);
	assert.deepStrictEqual(
		calls.map((a) => a[0]),
		['add', 'commit', 'rev-parse', 'push', 'add', 'commit', 'rev-parse', 'push'],
		'the second sync\'s commands must all come after the first\'s, in order — proof they were serialized, not interleaved',
	);
});

test('a failing push rejects sync() and records lastError; a later success clears it', async (t) => {
	stubGit(t, { failOn: 'push' });

	await assert.rejects(() => vaultsync.sync('will fail'), /simulated git failure on push/);
	const failure = vaultsync.getLastError();
	assert.ok(failure, 'a failure should be recorded');
	assert.match(failure.message, /simulated git failure on push/);
	assert.ok(failure.at instanceof Date);

	t.mock.reset(); // drop the failing stub before the next call
	stubGit(t);
	await vaultsync.sync('now it works');
	assert.strictEqual(vaultsync.getLastError(), null, 'a subsequent success should clear the recorded failure');
});

test('one sync() rejecting does not jam the queue for the next call', async (t) => {
	stubGit(t, { failOn: 'commit' });
	await assert.rejects(() => vaultsync.sync('doomed'));

	t.mock.reset();
	const { getMaxActive } = stubGit(t);
	await assert.doesNotReject(() => vaultsync.sync('should still work'));
	assert.strictEqual(getMaxActive(), 1);
});
