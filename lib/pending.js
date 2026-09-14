const crypto = require('crypto');
const state = require('./state');

// Telegram caps callback_data at 64 bytes, so the button carries a short
// random id, not the payload — the actual draft/target lives in
// .state/pending.json, keyed by that id, so a restart never loses it
// (docs/V2-SPEC.md §1).
const FILE = 'pending.json';
const TTL_MS = 6 * 60 * 60 * 1000; // 6h
const ID_BYTES = 6; // base64url-encoded -> 8 chars, well under the 64-byte cap

function purge(store) {
	const cutoff = Date.now() - TTL_MS;
	for (const [id, entry] of Object.entries(store)) {
		if (entry.at < cutoff) delete store[id];
	}
	return store;
}

function save(store) {
	state.writeJson(FILE, store);
}

// Purges on every load, and — unlike a purely lazy filter — persists the
// purge when it actually drops something, so a chat that only ever reads
// (get() with no matching create()/remove() nearby) doesn't let expired
// entries pile up in the file forever.
function load() {
	const store = state.readJson(FILE, {});
	const before = Object.keys(store).length;
	purge(store);
	if (Object.keys(store).length !== before) save(store);
	return store;
}

// Stores `data` under a fresh short id and returns that id — put it in a
// button's callback_data (e.g. `bcsend:${id}`), look it up later with get().
function create(type, data) {
	const store = load();
	const id = crypto.randomBytes(ID_BYTES).toString('base64url');
	store[id] = { type, data, at: Date.now() };
	save(store);
	return id;
}

// Returns the stored entry, or null if it never existed or has expired.
function get(id) {
	if (!id) return null;
	return load()[id] || null;
}

function remove(id) {
	const store = load();
	delete store[id];
	save(store);
}

module.exports = { create, get, remove, TTL_MS };
