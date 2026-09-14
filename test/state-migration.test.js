const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// STATE_DIR must be set before lib/config (and therefore lib/state) is
// first required, so every helper below operates on a tmp dir instead of
// the real repo's .state/.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-bridge-state-'));
process.env.STATE_DIR = path.join(tmpRoot, '.state');

const state = require('../lib/state');

test.after(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	delete process.env.STATE_DIR;
});

test('.state/ is created on demand, not up front', () => {
	assert.ok(!fs.existsSync(state.stateDir), 'nothing should exist yet — this is the first write');
	state.writeJson('probe.json', { ok: true });
	assert.ok(fs.existsSync(state.stateDir));
	assert.deepStrictEqual(state.readJson('probe.json', null), { ok: true });
});

test('migrateLegacyFile moves an old root-level file into .state/, preserving content', () => {
	const oldPath = path.join(tmpRoot, 'seen-regulations.json');
	fs.writeFileSync(oldPath, '["a","b"]', 'utf8');

	const moved = state.migrateLegacyFile(oldPath, 'seen-regulations.json');

	assert.strictEqual(moved, true);
	assert.ok(!fs.existsSync(oldPath), 'the old file should be gone from its original location');
	assert.strictEqual(fs.readFileSync(state.statePath('seen-regulations.json'), 'utf8'), '["a","b"]');
	assert.deepStrictEqual(state.readJson('seen-regulations.json', null), ['a', 'b']);
});

test('migrating again once the old file is gone is a no-op', () => {
	const oldPath = path.join(tmpRoot, 'seen-regulations.json'); // already moved away above
	const moved = state.migrateLegacyFile(oldPath, 'seen-regulations.json');
	assert.strictEqual(moved, false);
	assert.deepStrictEqual(state.readJson('seen-regulations.json', null), ['a', 'b'], 'the migrated content must be untouched');
});

test('a pre-existing .state/ file is never overwritten by a stray old-format file', () => {
	const oldPath = path.join(tmpRoot, 'offset');
	fs.writeFileSync(oldPath, '999', 'utf8'); // stray legacy file, e.g. left over from a bad deploy
	state.writeJson('offset', 42); // .state/ already has the current value

	const moved = state.migrateLegacyFile(oldPath, 'offset');

	assert.strictEqual(moved, false);
	assert.strictEqual(state.readJson('offset', null), 42, 'the existing .state/ value must win over a stray old file');
	assert.ok(fs.existsSync(oldPath), 'the stray old file is left alone, not deleted');
});

test('migrating a file that never existed at the old location is a no-op', () => {
	const oldPath = path.join(tmpRoot, 'does-not-exist.json');
	const moved = state.migrateLegacyFile(oldPath, 'does-not-exist.json');
	assert.strictEqual(moved, false);
	assert.ok(!fs.existsSync(state.statePath('does-not-exist.json')));
});

test('readJson falls back when the file is missing or unparseable', () => {
	assert.deepStrictEqual(state.readJson('never-written.json', { fallback: true }), { fallback: true });

	fs.writeFileSync(state.statePath('corrupt.json'), 'not json', 'utf8');
	assert.deepStrictEqual(state.readJson('corrupt.json', { fallback: true }), { fallback: true });
});

test('the plain-number .offset format (bare JSON, no wrapping object) still round-trips', () => {
	// The pre-migration .offset file was written as `String(offset)`, e.g.
	// "12345" — a bare JSON number, valid input to JSON.parse. Confirms the
	// migrated legacy file needs no format conversion.
	const oldPath = path.join(tmpRoot, 'legacy-offset-format');
	fs.writeFileSync(oldPath, '12345', 'utf8');
	state.migrateLegacyFile(oldPath, 'plain-number.json');
	assert.strictEqual(state.readJson('plain-number.json', 0), 12345);
});
