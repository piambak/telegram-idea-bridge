const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const cp = require('child_process'); // same specifier lib/claude.js uses

const docgen = require('../lib/docgen');

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

test('draftTable (table-builder / /excel) stays on the fast tier via the given chat, never the Claude CLI', async (t) => {
	t.mock.method(cp, 'spawn', () => {
		throw new Error('/excel must stay on the fast tier (docs/ANALYSIS.md: move off the Claude CLI)');
	});
	const chat = async () => JSON.stringify({ title: 'Rincian Belanja', headers: ['Tanggal', 'Jumlah'], rows: [['2026-09-01', '150000']] });

	const data = await docgen.draftTable('rincian belanja bulan ini', chat);

	assert.deepStrictEqual(data, { title: 'Rincian Belanja', headers: ['Tanggal', 'Jumlah'], rows: [['2026-09-01', '150000']] });
});

test('draftTable rejects when the reply is not a valid table shape', async () => {
	const chat = async () => JSON.stringify({ title: 'Oops' }); // missing headers/rows
	await assert.rejects(() => docgen.draftTable('brief', chat), /could not parse table data/i);
});

test('draftContent (office-doc / /doc) invokes the Claude CLI with the office-doc-drafter agent', async (t) => {
	const child = fakeChild();
	let seenArgs;
	t.mock.method(cp, 'spawn', (bin, args) => {
		seenArgs = args;
		return child;
	});

	const resultPromise = docgen.draftContent('Memo reminder for monthly report deadline', 'default');

	assert.strictEqual(child.stdin.chunks.join(''), '/office-doc default Memo reminder for monthly report deadline');
	assert.strictEqual(seenArgs[seenArgs.indexOf('--agent') + 1], 'office-doc-drafter');
	assert.strictEqual(seenArgs[seenArgs.indexOf('--add-dir') + 1], docgen.TEMPLATES_DIR);

	child.stdout.emit('data', envelope({ is_error: false, result: JSON.stringify({ title: 'Pengingat Laporan Bulanan', content: 'Isi memo...' }) }));
	child.emit('close', 0);

	const result = await resultPromise;
	assert.deepStrictEqual(result, { title: 'Pengingat Laporan Bulanan', content: 'Isi memo...' });
});

test('draftContent falls back to a truncated brief as the title when the CLI omits one', async (t) => {
	const child = fakeChild();
	t.mock.method(cp, 'spawn', () => child);

	const resultPromise = docgen.draftContent('a brief with no title in the reply', undefined);
	child.stdout.emit('data', envelope({ is_error: false, result: JSON.stringify({ title: '', content: 'body text' }) }));
	child.emit('close', 0);

	const result = await resultPromise;
	assert.strictEqual(result.title, 'a brief with no title in the reply'.slice(0, 60));
});
