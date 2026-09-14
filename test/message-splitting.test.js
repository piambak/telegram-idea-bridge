const { test } = require('node:test');
const assert = require('node:assert');

// docs/V2-SPEC.md §1 / docs/ANALYSIS.md bug #3: long replies split at
// paragraph boundaries instead of truncating or letting a >4096-char
// sendMessage throw inside a try block that reports an unrelated error.
const ui = require('../lib/ui');
const telegram = require('../lib/telegram');

test('splitParas: text under the limit is a single, untouched part', () => {
	assert.deepStrictEqual(ui.splitParas('short text', 100), ['short text']);
});

test('splitParas: breaks at blank-line (paragraph) boundaries, not mid-sentence', () => {
	const paras = ['a'.repeat(30), 'b'.repeat(30), 'c'.repeat(30)];
	const html = paras.join('\n\n');
	const parts = ui.splitParas(html, 65); // fits two ~30-char paras + the \n\n, not three
	assert.deepStrictEqual(parts, [`${paras[0]}\n\n${paras[1]}`, paras[2]]);
	assert.strictEqual(parts.join('\n\n'), html, 'rejoining the parts must reproduce the original content exactly — nothing dropped');
});

test('splitParas: never drops content, even across many small paragraphs', () => {
	const paras = Array.from({ length: 50 }, (_, i) => `paragraph number ${i}`.repeat(3));
	const html = paras.join('\n\n');
	const parts = ui.splitParas(html, 200);
	assert.ok(parts.length > 1, 'sanity check: this should actually need multiple parts');
	for (const part of parts) assert.ok(part.length <= 200);
	// every paragraph's text must survive somewhere in the output, in order
	assert.strictEqual(parts.join('\n\n'), html);
});

test('splitParas: a single paragraph bigger than the limit on its own is hard-split, never dropped', () => {
	const huge = 'x'.repeat(250);
	const parts = ui.splitParas(huge, 100);
	assert.ok(parts.length >= 3);
	for (const part of parts) assert.ok(part.length <= 100);
	assert.strictEqual(parts.join(''), huge, 'concatenating the hard-split parts must reproduce the original exactly');
});

test('splitParas: an oversized paragraph mixed with normal ones loses nothing', () => {
	const html = `intro\n\n${'y'.repeat(250)}\n\noutro`;
	const parts = ui.splitParas(html, 100);
	const rejoined = parts.join('');
	assert.ok(rejoined.includes('intro'));
	assert.ok(rejoined.includes('outro'));
	assert.strictEqual((rejoined.match(/y/g) || []).length, 250, 'every "y" from the oversized paragraph must survive');
});

test('ui.send: a reply under the limit is one sendMessage call', async (t) => {
	const calls = [];
	t.mock.method(telegram, 'sendMessage', async (chatId, text, extra) => {
		calls.push({ chatId, text, extra });
		return { message_id: 1 };
	});

	await ui.send(42, 'short reply', { reply_markup: { x: 1 } });

	assert.strictEqual(calls.length, 1);
	assert.deepStrictEqual(calls[0].extra, { reply_markup: { x: 1 } });
});

test('ui.send: a long reply is split into multiple sendMessage calls, extra only on the last', async (t) => {
	const calls = [];
	t.mock.method(telegram, 'sendMessage', async (chatId, text, extra) => {
		calls.push({ text, extra });
		return { message_id: calls.length };
	});

	const paras = Array.from({ length: 30 }, (_, i) => `Paragraph ${i}: ${'lorem ipsum '.repeat(20)}`);
	const html = paras.join('\n\n');
	await ui.send(42, html, { reply_markup: { buttons: true } });

	assert.ok(calls.length > 1, 'this input should not fit in a single message');
	for (let i = 0; i < calls.length - 1; i++) assert.strictEqual(calls[i].extra, undefined, 'extra must not appear on non-final parts');
	assert.deepStrictEqual(calls.at(-1).extra, { reply_markup: { buttons: true } });
	// nothing lost across the split
	assert.strictEqual(calls.map((c) => c.text).join('\n\n'), html);
});
