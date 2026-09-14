const { test } = require('node:test');
const assert = require('node:assert');

const telegram = require('../lib/telegram');

// A fetch that only ever settles via the AbortSignal — proves call() aborts
// a hung request instead of waiting forever (docs/ANALYSIS.md bug #21). Uses
// a short custom timeoutMs (not the real 35s getUpdates() uses) so the test
// stays fast; the mechanism is what's under test, not the specific value.
function hangingFetch(t) {
	t.mock.method(global, 'fetch', (url, opts) => {
		return new Promise((resolve, reject) => {
			opts.signal.addEventListener('abort', () => {
				const err = new Error('The operation was aborted.');
				err.name = 'AbortError';
				reject(err);
			});
		});
	});
}

test('call() aborts and rejects instead of hanging forever when the request never responds', async (t) => {
	hangingFetch(t);
	const start = Date.now();
	await assert.rejects(() => telegram.call('getUpdates', { offset: 0 }, { timeoutMs: 30 }), /aborted/i);
	assert.ok(Date.now() - start < 2000, 'the abort should fire close to timeoutMs, not hang');
});

test('a fast, normal response is unaffected by the abort timer', async (t) => {
	t.mock.method(global, 'fetch', async () => ({
		ok: true,
		json: async () => ({ ok: true, result: [{ update_id: 1 }] }),
	}));
	const result = await telegram.call('getUpdates', { offset: 0 }, { timeoutMs: 30 });
	assert.deepStrictEqual(result, [{ update_id: 1 }]);
});

test('getUpdates() issues its request with an AbortSignal (goes through the abortable path)', async (t) => {
	let seenSignal;
	t.mock.method(global, 'fetch', async (url, opts) => {
		seenSignal = opts.signal;
		return { ok: true, json: async () => ({ ok: true, result: [] }) };
	});
	await telegram.getUpdates(5);
	assert.ok(seenSignal instanceof AbortSignal);
});
