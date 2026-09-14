const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const cp = require('child_process'); // same specifier lib/claude.js uses — same cached module instance
const path = require('node:path');

const claude = require('../lib/claude');
const { env } = require('../lib/config');

// Fake child_process.ChildProcess: an EventEmitter with just enough shape
// (stdin/stdout/stderr, kill()) for lib/claude.js to drive. Tests emit
// 'data'/'close'/'error' on it themselves to control the outcome.
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
	child.kill = () => {
		child.killed = true;
	};
	return child;
}

const envelope = (obj) => Buffer.from(JSON.stringify(obj));

test('the prompt is written to stdin, never passed as an argv element', async (t) => {
	const child = fakeChild();
	let seenArgs;
	t.mock.method(cp, 'spawn', (bin, args) => {
		seenArgs = args;
		return child;
	});

	// Bigger than Windows' 32,767-char argv cap — this is exactly the
	// regulation-PDF case from docs/ANALYSIS.md bug #1.
	const bigDoc = 'x'.repeat(50000);
	const resultPromise = claude.run(bigDoc, {});

	assert.strictEqual(child.stdin.chunks.join(''), bigDoc, 'the whole prompt should be written to stdin');
	assert.ok(
		seenArgs.every((a) => !a.includes('x'.repeat(100))),
		'the prompt must never appear inside an argv element',
	);

	child.stdout.emit('data', envelope({ is_error: false, result: 'ok' }));
	child.emit('close', 0);
	assert.strictEqual((await resultPromise).ok, true);
});

test('flags are built from options, cwd is the repo root, --bare is never added', async (t) => {
	const child = fakeChild();
	let seen;
	t.mock.method(cp, 'spawn', (bin, args, opts) => {
		seen = { bin, args, opts };
		return child;
	});

	const schema = { type: 'object', required: ['title'] };
	const resultPromise = claude.run('doc text', {
		agent: 'office-doc-drafter',
		resume: 'sess-123',
		schema,
		addDir: 'C:/tpl',
		allowedTools: 'Read',
	});

	assert.deepStrictEqual(seen.args, [
		'-p',
		'--output-format',
		'json',
		'--agent',
		'office-doc-drafter',
		'--resume',
		'sess-123',
		'--json-schema',
		JSON.stringify(schema),
		'--add-dir',
		'C:/tpl',
		'--allowedTools',
		'Read',
	]);
	assert.ok(!seen.args.includes('--bare'), '--bare must never be passed — it needs an API key, this box uses a subscription login');
	assert.strictEqual(seen.opts.cwd, path.join(__dirname, '..'), 'cwd must be the repo root so .claude/agents and .claude/skills are discovered');

	child.stdout.emit('data', envelope({ is_error: false, result: 'ok' }));
	child.emit('close', 0);
	await resultPromise;
});

test('a fenced JSON result is parsed into data, raw keeps the original text', async (t) => {
	const child = fakeChild();
	t.mock.method(cp, 'spawn', () => child);

	const resultPromise = claude.run('summarize this', {});
	const fenced = '```json\n{"title":"Ringkasan","points":["a","b"]}\n```';
	child.stdout.emit('data', envelope({ is_error: false, result: fenced }));
	child.emit('close', 0);

	const res = await resultPromise;
	assert.strictEqual(res.ok, true);
	assert.deepStrictEqual(res.data, { title: 'Ringkasan', points: ['a', 'b'] });
	assert.strictEqual(res.raw, fenced);
});

test('the CLI reporting is_error resolves ok:false instead of throwing', async (t) => {
	const child = fakeChild();
	t.mock.method(cp, 'spawn', () => child);

	const resultPromise = claude.run('doc', {});
	child.stdout.emit('data', envelope({ is_error: true, result: 'permission denied' }));
	child.emit('close', 1);

	assert.deepStrictEqual(await resultPromise, { ok: false, data: null, raw: 'permission denied', error: 'permission denied' });
});

test('a timeout rejects cleanly and kills the child', async (t) => {
	const child = fakeChild();
	t.mock.method(cp, 'spawn', () => child);

	await assert.rejects(() => claude.run('doc', { timeoutMs: 20 }), /timed out/);
	assert.strictEqual(child.killed, true, 'the hung process should be killed');
});

test('a spawn failure (e.g. missing binary) rejects instead of hanging', async (t) => {
	const child = fakeChild();
	t.mock.method(cp, 'spawn', () => child);

	const resultPromise = claude.run('doc', {});
	child.emit('error', new Error('spawn claude ENOENT'));
	await assert.rejects(() => resultPromise, /Failed to start Claude CLI/);
});

test('CLAUDE_BIN and CLAUDE_SHELL=1 are read from .env for the npm .cmd shim case', async (t) => {
	const originalBin = env.CLAUDE_BIN;
	const originalShell = env.CLAUDE_SHELL;
	t.after(() => {
		env.CLAUDE_BIN = originalBin;
		env.CLAUDE_SHELL = originalShell;
	});
	env.CLAUDE_BIN = 'C:/Users/x/AppData/Roaming/npm/claude.cmd';
	env.CLAUDE_SHELL = '1';

	const child = fakeChild();
	let seen;
	t.mock.method(cp, 'spawn', (bin, args, opts) => {
		seen = { bin, opts };
		return child;
	});

	const resultPromise = claude.run('doc', {});
	child.stdout.emit('data', envelope({ is_error: false, result: 'ok' }));
	child.emit('close', 0);
	await resultPromise;

	assert.strictEqual(seen.bin, 'C:/Users/x/AppData/Roaming/npm/claude.cmd');
	assert.strictEqual(seen.opts.shell, true, 'a .cmd shim needs shell:true to be executable on Windows');
});

test('parseJsonLoose strips a code fence and still parses plain JSON', () => {
	assert.deepStrictEqual(claude.parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
	assert.deepStrictEqual(claude.parseJsonLoose('```\n{"a":1}\n```'), { a: 1 });
	assert.deepStrictEqual(claude.parseJsonLoose('{"a":1}'), { a: 1 });
});

// --- runSkill: the deep-tier entry point docs/AGENTS-SKILLS.md's wiring
// examples call as claude.runSkill(name, args, opts) ---

test('runSkill sends "/<name> <args>" on stdin with no stdin doc given', async (t) => {
	const child = fakeChild();
	t.mock.method(cp, 'spawn', () => child);

	const resultPromise = claude.runSkill('office-doc', 'default Memo reminder', {});

	assert.strictEqual(child.stdin.chunks.join(''), '/office-doc default Memo reminder');

	child.stdout.emit('data', envelope({ is_error: false, result: '{"title":"Memo","content":"..."}' }));
	child.emit('close', 0);
	const res = await resultPromise;
	assert.deepStrictEqual(res.data, { title: 'Memo', content: '...' });
});

test('runSkill appends a large stdin document after the header line, never as argv', async (t) => {
	const child = fakeChild();
	let seenArgs;
	t.mock.method(cp, 'spawn', (bin, args) => {
		seenArgs = args;
		return child;
	});

	const bigDoc = 'y'.repeat(50000);
	const resultPromise = claude.runSkill('summarize-long', 'Some Title', { stdin: bigDoc, agent: 'long-doc-summarizer' });

	assert.strictEqual(child.stdin.chunks.join(''), `/summarize-long Some Title\n\n${bigDoc}`);
	assert.ok(!seenArgs.some((a) => a.includes('y'.repeat(100))), 'the document must never appear in argv');
	assert.deepStrictEqual(
		seenArgs.slice(seenArgs.indexOf('--agent'), seenArgs.indexOf('--agent') + 2),
		['--agent', 'long-doc-summarizer'],
	);

	child.stdout.emit('data', envelope({ is_error: false, result: 'ok' }));
	child.emit('close', 0);
	await resultPromise;
});

test('runSkill with no args still produces a valid "/<name>" header', async (t) => {
	const child = fakeChild();
	t.mock.method(cp, 'spawn', () => child);

	const resultPromise = claude.runSkill('calc-vision', '', { agent: 'vision-math-reader' });
	assert.strictEqual(child.stdin.chunks.join(''), '/calc-vision');

	child.stdout.emit('data', envelope({ is_error: false, result: '{"expression":"1+1"}' }));
	child.emit('close', 0);
	await resultPromise;
});

// --- version() — /status's cheap liveness check ---------------------------

test('version(): resolves with stdout on a clean exit, never writes to stdin', async (t) => {
	const child = fakeChild();
	let seenArgs;
	t.mock.method(cp, 'spawn', (bin, args) => {
		seenArgs = args;
		return child;
	});

	const resultPromise = claude.version();
	assert.deepStrictEqual(seenArgs, ['--version']);
	assert.deepStrictEqual(child.stdin.chunks, [], 'version() has no prompt to send');

	child.stdout.emit('data', Buffer.from('2.1.0 (Claude Code)\n'));
	child.emit('close', 0);
	assert.strictEqual(await resultPromise, '2.1.0 (Claude Code)');
});

test('version(): a non-zero exit rejects with a clear message', async (t) => {
	const child = fakeChild();
	t.mock.method(cp, 'spawn', () => child);

	const resultPromise = claude.version();
	child.emit('close', 1);
	await assert.rejects(resultPromise, /exited 1/);
});

test('version(): the binary failing to start (not on PATH) rejects instead of hanging', async (t) => {
	const child = fakeChild();
	t.mock.method(cp, 'spawn', () => child);

	const resultPromise = claude.version();
	child.emit('error', new Error('ENOENT'));
	await assert.rejects(resultPromise, /Failed to start Claude CLI/);
});
