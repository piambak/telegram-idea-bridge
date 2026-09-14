const { test } = require('node:test');
const assert = require('node:assert');

// syncVaultQuietly's whole reason to exist: a vault push failure must never
// reach the caller as a rejection — handleIdea/handleTodo rely on that to
// answer the user regardless of git/network trouble (docs/ANALYSIS.md bug #5).
const vaultsync = require('../lib/vaultsync');
const { syncVaultQuietly } = require('../bridge');

test('syncVaultQuietly resolves even when vaultsync.sync rejects', async (t) => {
	t.mock.method(console, 'error', () => {}); // keep the expected failure out of test output
	t.mock.method(vaultsync, 'sync', async () => {
		throw new Error('push failed: non-fast-forward');
	});

	await assert.doesNotReject(() => syncVaultQuietly('a message'));
});

test('syncVaultQuietly still resolves when vaultsync.sync succeeds', async (t) => {
	t.mock.method(vaultsync, 'sync', async () => 'ok');
	await assert.doesNotReject(() => syncVaultQuietly('a message'));
});
