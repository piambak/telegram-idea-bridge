const { test } = require('node:test');
const assert = require('node:assert');

const ui = require('../lib/ui');
const telegram = require('../lib/telegram');

test('card: assembles icon+title, subtitle, blockquote body, sections, footer — all escaped', () => {
	const html = ui.card({
		icon: '💡',
		title: 'Kios <Pajak>',
		subtitle: '#pajak #layanan',
		body: 'Ide bagus & menarik.',
		sections: [{ label: 'Poin penting', items: ['risiko: adopsi', 'butuh <riset>'] }],
		footer: '💾 notes/x.md',
	});

	assert.strictEqual(
		html,
		[
			'💡 <b>Kios &lt;Pajak&gt;</b>',
			'<i>#pajak #layanan</i>',
			'<blockquote>Ide bagus &amp; menarik.</blockquote>',
			'<b>Poin penting</b>',
			'▸ risiko: adopsi',
			'▸ butuh &lt;riset&gt;',
			'<i>💾 notes/x.md</i>',
		].join('\n'),
	);
});

test('card: omits a field entirely when not given, instead of an empty line', () => {
	const html = ui.card({ title: 'Just a title' });
	assert.strictEqual(html, '<b>Just a title</b>');
});

test('card: a long body becomes an expandable blockquote; a short one does not', () => {
	const short = ui.card({ title: 'x', body: 'short body' });
	assert.match(short, /<blockquote>short body<\/blockquote>/);
	assert.doesNotMatch(short, /expandable/);

	const long = ui.card({ title: 'x', body: 'y'.repeat(301) });
	assert.match(long, /<blockquote expandable>y+<\/blockquote>/);
});

test('keyboard: wraps rows as inline_keyboard verbatim', () => {
	const rows = [[{ text: 'A', callback_data: 'a:1' }], [{ text: 'B', callback_data: 'b:2' }, { text: 'C', callback_data: 'c:3' }]];
	assert.deepStrictEqual(ui.keyboard(rows), { inline_keyboard: rows });
});

test('progressBar: renders a filled/empty block row proportional to the fraction', () => {
	assert.strictEqual(ui.progressBar(0, 5), '▱▱▱▱▱');
	assert.strictEqual(ui.progressBar(1, 5), '▰▰▰▰▰');
	assert.strictEqual(ui.progressBar(0.5, 4), '▰▰▱▱');
	assert.strictEqual(ui.progressBar(0.6, 5), '▰▰▰▱▱'); // 3/5, matches the spec's example exactly
});

test('progressBar: clamps out-of-range fractions instead of producing a malformed bar', () => {
	assert.strictEqual(ui.progressBar(-1, 5), '▱▱▱▱▱');
	assert.strictEqual(ui.progressBar(2, 5), '▰▰▰▰▰');
	assert.strictEqual(ui.progressBar(NaN, 5), '▱▱▱▱▱');
});

test('quietSection: always expandable regardless of length, items escaped', () => {
	const html = ui.quietSection('Newsletter & promo', ['<b>Deal</b> of the day']);
	assert.strictEqual(html, '<blockquote expandable><b>Newsletter &amp; promo</b>\n▸ &lt;b&gt;Deal&lt;/b&gt; of the day</blockquote>');
});

// --- progress(): post once, edit in place ---

test('progress(): posts a placeholder, then finish() edits that same message', async (t) => {
	const calls = [];
	t.mock.method(telegram, 'sendMessage', async (chatId, text) => {
		calls.push({ type: 'send', chatId, text });
		return { message_id: 777 };
	});
	t.mock.method(telegram, 'editMessageText', async (chatId, messageId, text, extra) => {
		calls.push({ type: 'edit', chatId, messageId, text, extra });
		return { message_id: messageId };
	});

	const job = await ui.progress(9, '⏳ working...');
	assert.strictEqual(job.messageId, 777);
	assert.strictEqual(calls.length, 1);
	assert.strictEqual(calls[0].type, 'send');

	await job.finish('done!', { reply_markup: { x: 1 } });
	assert.strictEqual(calls.length, 2);
	assert.strictEqual(calls[1].type, 'edit');
	assert.strictEqual(calls[1].messageId, 777);
	assert.strictEqual(calls[1].text, 'done!');
	assert.deepStrictEqual(calls[1].extra, { reply_markup: { x: 1 } });
});

test('progress(): update() can be called multiple times before finish() for multi-phase jobs', async (t) => {
	const edits = [];
	t.mock.method(telegram, 'sendMessage', async () => ({ message_id: 5 }));
	t.mock.method(telegram, 'editMessageText', async (chatId, messageId, text) => {
		edits.push(text);
		return { message_id: messageId };
	});

	const job = await ui.progress(1, '⏳ step 1...');
	await job.update('⏳ step 2...');
	await job.update('⏳ step 3...');
	await job.finish('done');

	assert.deepStrictEqual(edits, ['⏳ step 2...', '⏳ step 3...', 'done']);
});

test('progress(): finish() with a result too long for one message edits the first part, sends the rest', async (t) => {
	const sends = [];
	const edits = [];
	t.mock.method(telegram, 'sendMessage', async (chatId, text, extra) => {
		sends.push({ text, extra });
		return { message_id: 42 };
	});
	t.mock.method(telegram, 'editMessageText', async (chatId, messageId, text, extra) => {
		edits.push({ text, extra });
		return { message_id: messageId };
	});

	const job = await ui.progress(1, '⏳ working...');
	const paras = Array.from({ length: 30 }, (_, i) => `Paragraph ${i}: ${'lorem ipsum '.repeat(20)}`);
	const html = paras.join('\n\n');
	await job.finish(html, { reply_markup: { final: true } });

	assert.strictEqual(edits.length, 1, 'the placeholder is edited exactly once, into the first part');
	assert.ok(sends.length >= 2, 'a placeholder send plus at least one overflow send');
	assert.deepStrictEqual(sends.at(-1).extra, { reply_markup: { final: true } }, 'extra lands on the true last part');
	assert.strictEqual(edits[0].extra, undefined, 'extra must not be on the edited first part when more parts follow');
});
