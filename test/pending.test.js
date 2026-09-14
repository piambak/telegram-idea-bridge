const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// STATE_DIR must be set before lib/config (and therefore lib/pending) is
// first required, so this never touches the real repo's .state/.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-bridge-pending-'));
process.env.STATE_DIR = path.join(tmpRoot, '.state');

const pending = require('../lib/pending');
const state = require('../lib/state');

test.after(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	delete process.env.STATE_DIR;
});

test('create() returns an id that fits a Telegram callback_data (<=64 bytes) alongside an action prefix', () => {
	const id = pending.create('broadcast', { brief: 'x', draft: 'y' });
	// bridge.js builds callback_data as "<action>:<id>" — the longest action
	// prefix in use is "bcredraft" (9 chars) plus the ":" separator.
	const callbackData = `bcredraft:${id}`;
	assert.ok(Buffer.byteLength(callbackData, 'utf8') <= 64, `callback_data "${callbackData}" must be <= 64 bytes`);
	// sanity: the id itself carries no payload — it's just a lookup key
	assert.ok(!id.includes('broadcast') && !id.includes('draft'));
});

test('create()/get() round-trip the stored payload exactly', () => {
	const id = pending.create('todo_done', { text: 'Beli <susu> & roti' });
	const entry = pending.get(id);
	assert.strictEqual(entry.type, 'todo_done');
	assert.deepStrictEqual(entry.data, { text: 'Beli <susu> & roti' });
});

test('get() returns null for an unknown or malformed id', () => {
	assert.strictEqual(pending.get('does-not-exist'), null);
	assert.strictEqual(pending.get(''), null);
	assert.strictEqual(pending.get(undefined), null);
});

test('remove() deletes the entry; a second get() is null', () => {
	const id = pending.create('broadcast', { brief: 'x' });
	pending.remove(id);
	assert.strictEqual(pending.get(id), null);
});

test('ids are unique across many creates', () => {
	const ids = new Set(Array.from({ length: 200 }, () => pending.create('todo_done', { text: 'x' })));
	assert.strictEqual(ids.size, 200);
});

test('an entry survives a "restart" — it is read back from .state/pending.json, not memory', () => {
	const id = pending.create('broadcast', { brief: 'persisted across restart' });
	// Simulate a restart: nothing in this module is memory-cached across
	// calls (every create/get/remove reloads from disk), but assert the
	// on-disk file itself has the entry, proving it isn't purely in-process.
	const onDisk = state.readJson('pending.json', {});
	assert.ok(onDisk[id]);
	assert.strictEqual(onDisk[id].data.brief, 'persisted across restart');
});

test('an entry older than the 6h TTL is treated as expired and purged on the next access', (t) => {
	const id = pending.create('broadcast', { brief: 'stale' });
	// Back-date it directly on disk, past the TTL.
	const store = state.readJson('pending.json', {});
	store[id].at = Date.now() - (pending.TTL_MS + 60_000);
	state.writeJson('pending.json', store);

	assert.strictEqual(pending.get(id), null, 'an entry past its TTL must not be returned');
	const onDiskAfter = state.readJson('pending.json', {});
	assert.ok(!(id in onDiskAfter), 'it should also have been purged from disk, not just hidden');
});

test('an entry just inside the TTL is still returned', () => {
	const id = pending.create('broadcast', { brief: 'fresh enough' });
	const store = state.readJson('pending.json', {});
	store[id].at = Date.now() - (pending.TTL_MS - 60_000); // 1 minute inside the window
	state.writeJson('pending.json', store);

	const entry = pending.get(id);
	assert.ok(entry);
	assert.strictEqual(entry.data.brief, 'fresh enough');
});
