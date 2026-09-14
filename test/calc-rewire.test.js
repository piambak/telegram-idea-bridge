const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const cp = require('child_process'); // same specifier lib/claude.js uses

const calc = require('../lib/calc');
const models = require('../lib/models');

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

function tmpImagePath() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calc-img-'));
	const file = path.join(dir, 'problem.png');
	fs.writeFileSync(file, Buffer.from([1, 2, 3, 4]));
	return file;
}

test('solveText: a word problem routes through calc-expression, mathjs evaluates it', async () => {
	const chat = async () => JSON.stringify({ expression: '5 + 3 * 2' });
	const result = await calc.solveText('lima ditambah tiga kali dua', chat);
	assert.strictEqual(result.expression, '5 + 3 * 2');
	assert.strictEqual(result.result, '11');
});

test('solveText: {none:true} from calc-expression throws a clear error', async () => {
	const chat = async () => JSON.stringify({ none: true });
	await assert.rejects(() => calc.solveText('what is the meaning of life', chat), /couldn't turn/i);
});

test('solveImage: Gemini Flash vision (fast tier) succeeds without ever touching the Claude CLI', async (t) => {
	t.mock.method(cp, 'spawn', () => {
		throw new Error('the Claude CLI must not run when the fast vision path succeeds');
	});
	t.mock.method(models.MODELS.gemini, 'chat', async (messages) => {
		const userContent = messages[1].content;
		assert.ok(Array.isArray(userContent), 'the image should go in as an image_url content part, not plain text');
		assert.ok(
			userContent.some((part) => part.type === 'image_url' && part.image_url.url.startsWith('data:image/')),
			'an image_url part with a data: URL should be present',
		);
		return JSON.stringify({ expression: '7 * 6' });
	});

	const result = await calc.solveImage(tmpImagePath());
	assert.strictEqual(result.expression, '7 * 6');
	assert.strictEqual(result.result, '42');
});

test('solveImage: falls back to the vision-math-reader Claude agent when Gemini fails', async (t) => {
	t.mock.method(models.MODELS.gemini, 'chat', async () => {
		throw new Error('Gemini is down');
	});

	const child = fakeChild();
	let seenArgs;
	t.mock.method(cp, 'spawn', (bin, args) => {
		seenArgs = args;
		return child;
	});

	const resultPromise = calc.solveImage(tmpImagePath());

	// Let the fast-path rejection and the fallback's spawn call settle.
	await new Promise((r) => setImmediate(r));
	assert.ok(seenArgs, 'the deep-tier fallback should have spawned the Claude CLI');
	assert.strictEqual(seenArgs[seenArgs.indexOf('--agent') + 1], 'vision-math-reader');
	assert.strictEqual(seenArgs[seenArgs.indexOf('--allowedTools') + 1], 'Read');

	child.stdout.emit('data', envelope({ is_error: false, result: JSON.stringify({ expression: '9 - 4' }) }));
	child.emit('close', 0);

	const result = await resultPromise;
	assert.strictEqual(result.expression, '9 - 4');
	assert.strictEqual(result.result, '5');
});

test('solveImage: both tiers failing surfaces a clear "no math problem" error, not a raw CLI error', async (t) => {
	t.mock.method(models.MODELS.gemini, 'chat', async () => {
		throw new Error('Gemini is down');
	});
	const child = fakeChild();
	t.mock.method(cp, 'spawn', () => child);

	const resultPromise = calc.solveImage(tmpImagePath());
	await new Promise((r) => setImmediate(r));
	child.stdout.emit('data', envelope({ is_error: false, result: JSON.stringify({ none: true }) }));
	child.emit('close', 0);

	await assert.rejects(() => resultPromise, /no math problem found/i);
});
