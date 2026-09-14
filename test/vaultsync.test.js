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

// docs/V2-SPEC.md §6: every scheduled job (regcheck, reminder tick, inbox
// digest, monthly finance report) is serialised against this same mutex, not
// just vaultsync's own git commands — serialized() must work as a general
// one-at-a-time queue for arbitrary async tasks, sync() included.
test('serialized: is a general-purpose mutex — arbitrary tasks never overlap each other', async () => {
	let active = 0;
	let maxActive = 0;
	const order = [];
	const task = (label, delayMs) => async () => {
		active++;
		maxActive = Math.max(maxActive, active);
		await new Promise((r) => setTimeout(r, delayMs));
		order.push(label);
		active--;
	};

	await Promise.all([vaultsync.serialized(task('a', 15)), vaultsync.serialized(task('b', 5)), vaultsync.serialized(task('c', 1))]);

	assert.strictEqual(maxActive, 1, 'no two serialized tasks should ever run concurrently');
	assert.deepStrictEqual(order, ['a', 'b', 'c'], 'tasks run in call order, not completion-speed order');
});

test('serialized: shares the exact same queue sync() uses — a job queued after a sync waits for it', async (t) => {
	const { calls } = stubGit(t, { delayMs: 15 });
	const order = [];

	await Promise.all([
		vaultsync.sync('a job-adjacent commit').then(() => order.push('sync')),
		vaultsync.serialized(async () => {
			order.push('job');
		}),
	]);

	assert.deepStrictEqual(order, ['sync', 'job'], 'a job queued alongside a sync must not run until the sync has settled');
	assert.strictEqual(calls.length, 4, 'the sync\'s own git commands are unaffected by having a job queued behind it');
});

// --- checkConnection() — /status's "vault mirror" row ----------------------

test('checkConnection: a real remote round-trip succeeds when the dir exists and there is no recorded failure', async (t) => {
	stubGit(t, { delayMs: 1 });
	const result = await vaultsync.checkConnection();
	assert.strictEqual(result.ok, true);
});

test('checkConnection: a missing vault directory is reported without ever touching git', async (t) => {
	t.mock.method(cp, 'execFile', () => {
		throw new Error('must not shell out when the vault dir itself is missing');
	});
	// VAULT_DIR is a fixed path read once at module load, so this exercises
	// the fs.existsSync branch by actually removing (then restoring) it.
	fs.rmSync(vaultDir, { recursive: true, force: true });
	try {
		const result = await vaultsync.checkConnection();
		assert.strictEqual(result.ok, false);
		assert.match(result.reason, /vault directory not found/);
	} finally {
		fs.mkdirSync(vaultDir, { recursive: true });
	}
});

test('checkConnection: a recorded sync failure is surfaced without a fresh network call', async (t) => {
	stubGit(t, { failOn: 'push' });
	await assert.rejects(() => vaultsync.sync('will fail'));

	t.mock.method(cp, 'execFile', () => {
		throw new Error('must not call git again — the recorded failure should short-circuit');
	});
	const result = await vaultsync.checkConnection();
	assert.strictEqual(result.ok, false);
	assert.match(result.reason, /last sync failed/);

	t.mock.reset();
	stubGit(t);
	await vaultsync.sync('recovers'); // clears lastError for later tests
});

test('checkConnection: an unreachable remote (ls-remote fails) is reported by message', async (t) => {
	t.mock.method(cp, 'execFile', (file, args, opts, cb) => {
		if (args[0] === 'ls-remote') return cb(new Error('unable to access remote'), '', 'unable to access remote');
		cb(null, 'main\n', '');
	});
	const result = await vaultsync.checkConnection();
	assert.strictEqual(result.ok, false);
	assert.match(result.reason, /unable to access remote/);
});
