const { test } = require('node:test');
const assert = require('node:assert');

const finance = require('../lib/finance');

test('fromText: txn-extract refines description/category/merchant on top of the regex hint', async () => {
	const chat = async () => JSON.stringify({ description: 'Makan siang', category: 'Makan', merchant: 'Warteg Bahari' });
	const txn = await finance.fromText('makan siang 45rb', chat);

	assert.strictEqual(txn.amount, 45_000, 'the amount always comes from the regex, never the model');
	assert.strictEqual(txn.type, 'out');
	assert.strictEqual(txn.description, 'Makan siang');
	assert.strictEqual(txn.category, 'Makan');
	assert.strictEqual(txn.note, 'Warteg Bahari');
	assert.strictEqual(txn.source, 'text');
});

test('fromText: the regex hint (amount/type) survives even when txn-extract fails entirely', async () => {
	const chat = async () => {
		throw new Error('model unavailable');
	};
	const txn = await finance.fromText('makan siang 45rb', chat);

	assert.strictEqual(txn.amount, 45_000, 'the amount must survive a total model failure');
	assert.strictEqual(txn.type, 'out');
	assert.strictEqual(txn.category, 'Lainnya', 'falls back to a safe default category');
	assert.strictEqual(txn.description, 'makan siang 45rb', 'falls back to the raw text as the description');
});

test('fromText: txn-extract returning an invalid category is ignored, falls back to Lainnya', async () => {
	const chat = async () => JSON.stringify({ description: 'Something', category: 'NotARealCategory', merchant: '' });
	const txn = await finance.fromText('beli sesuatu 20rb', chat);
	assert.strictEqual(txn.category, 'Lainnya');
});

test('fromText: an amount-less message still throws via buildTransaction\'s validation (no amount > 0)', async () => {
	const chat = async () => JSON.stringify({ description: 'x', category: 'Lainnya', merchant: '' });
	await assert.rejects(() => finance.fromText('tidak ada nominal di sini', chat), /amount must be greater than 0/);
});

test('fromText: an incoming-money phrase is typed "in"', async () => {
	const chat = async () => JSON.stringify({ description: 'Gaji', category: 'Pemasukan', merchant: '' });
	const txn = await finance.fromText('gaji masuk Rp 5.000.000', chat);
	assert.strictEqual(txn.type, 'in');
	assert.strictEqual(txn.amount, 5_000_000);
});

// --- fromImage (receipt-vision) ---

test('fromImage: builds a transaction from the receipt-vision result, category left as Lainnya for the keypad', async () => {
	const chat = async (messages) => {
		const userContent = messages[1].content;
		assert.ok(Array.isArray(userContent));
		assert.ok(userContent.some((p) => p.type === 'image_url' && p.image_url.url.startsWith('data:image/')));
		return JSON.stringify({ merchant: 'Indomaret', date: '2026-09-14', total: 47_500, items: [{ name: 'Air mineral', amount: 5_000 }] });
	};
	const txn = await finance.fromImage(Buffer.from([1, 2, 3]), chat);

	assert.strictEqual(txn.amount, 47_500);
	assert.strictEqual(txn.type, 'out');
	assert.strictEqual(txn.source, 'photo');
	assert.strictEqual(txn.description, 'Indomaret');
	assert.strictEqual(txn.category, 'Lainnya');
	assert.match(txn.note, /Air mineral/);
});

test('fromImage: an unreadable total (0) throws instead of logging a bogus zero-amount transaction', async () => {
	const chat = async () => JSON.stringify({ merchant: '', date: '', total: 0, items: [] });
	await assert.rejects(() => finance.fromImage(Buffer.from([1]), chat), /Could not read a total/);
});
