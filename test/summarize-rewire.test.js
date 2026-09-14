const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const cp = require('child_process'); // same specifier lib/claude.js uses

const summarize = require('../lib/summarize');

function fakeChild() {
	const child = new EventEmitter();
	child.stdin = {
		chunks: [],
		write(chunk) {
			this.chunks.push(chunk);
		},
		end() {},
		on() {},
	};
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.kill = () => {};
	return child;
}
const envelope = (obj) => Buffer.from(JSON.stringify(obj));

test('short text stays on the fast tier (summarize-short), plain text out', async (t) => {
	t.mock.method(cp, 'spawn', () => {
		throw new Error('short text must not reach the Claude CLI');
	});
	const chat = async () => 'Overview.\n\n• point one\n• point two\n\nNext: review it.';
	const result = await summarize.summarize('short text under the threshold', chat);
	assert.strictEqual(result, 'Overview.\n\n• point one\n• point two\n\nNext: review it.');
});

test('long text goes to the CLI via stdin (summarize-long), never as an argv element', async (t) => {
	const child = fakeChild();
	let seenArgs;
	t.mock.method(cp, 'spawn', (bin, args) => {
		seenArgs = args;
		return child;
	});

	const longText = 'x'.repeat(25000); // over CLAUDE_LENGTH_THRESHOLD
	const resultPromise = summarize.summarize(longText, async () => 'unused', 'My Document');

	assert.ok(child.stdin.chunks.join('').includes(longText), 'the document should be on stdin');
	assert.ok(!seenArgs.some((a) => a.includes('x'.repeat(100))), 'the document must never be an argv element');
	assert.strictEqual(seenArgs[seenArgs.indexOf('--agent') + 1], 'long-doc-summarizer');

	child.stdout.emit(
		'data',
		envelope({
			is_error: false,
			result: JSON.stringify({
				overview: 'This document covers X.',
				key_points: ['Point A', 'Point B'],
				next_action: 'Review before Friday.',
				language: 'en',
			}),
		}),
	);
	child.emit('close', 0);

	const result = await resultPromise;
	assert.strictEqual(result, 'This document covers X.\n\n• Point A\n• Point B\n\nReview before Friday.');
});

test('long-path summary falls back to the raw text if the CLI reply is not the expected JSON shape', async (t) => {
	const child = fakeChild();
	t.mock.method(cp, 'spawn', () => child);

	const resultPromise = summarize.summarize('y'.repeat(25000), async () => 'unused', 'Doc');
	child.stdout.emit('data', envelope({ is_error: false, result: 'plain text reply, not JSON' }));
	child.emit('close', 0);

	const result = await resultPromise;
	assert.strictEqual(result, 'plain text reply, not JSON');
});
