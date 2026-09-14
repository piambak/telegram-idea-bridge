const { test } = require('node:test');
const assert = require('node:assert');

const finance = require('../lib/finance');

// docs/V2-SPEC.md §3: "Rp 1.250.000,00" / "45rb" / "1,5jt" amount parsing.
const CASES = [
	// [input, expected]
	['45rb', 45_000],
	['45 rb', 45_000],
	['45ribu', 45_000],
	['500ribu', 500_000],
	['1,5jt', 1_500_000],
	['1.5jt', 1_500_000],
	['2jt', 2_000_000],
	['2 juta', 2_000_000],
	['Rp45rb', 45_000],
	['Rp 45rb', 45_000],
	['Rp 1.250.000,00', 1_250_000],
	['Rp1.250.000,00', 1_250_000],
	['Rp45.000', 45_000],
	['Rp 45.000', 45_000],
	['Rp150000', 150_000],
	['150000', 150_000],
	['1,250,000.00', 1_250_000], // occasional US-style sender
	['0.5jt', 500_000],
];

test('parseAmount: table of rb/jt/dot-thousands/comma-decimal formats', () => {
	for (const [input, expected] of CASES) {
		assert.strictEqual(finance.parseAmount(input), expected, `parseAmount(${JSON.stringify(input)}) should be ${expected}`);
	}
});

test('parseAmount: garbage input returns null, not NaN or a wrong number', () => {
	assert.strictEqual(finance.parseAmount(''), null);
	assert.strictEqual(finance.parseAmount('tidak ada angka'), null);
	assert.strictEqual(finance.parseAmount(null), null);
	assert.strictEqual(finance.parseAmount(undefined), null);
});

test('findAmountToken: locates the amount substring inside a full sentence', () => {
	assert.strictEqual(finance.findAmountToken('bayar makan siang 45rb ya tadi'), '45rb');
	assert.strictEqual(finance.findAmountToken('transfer Rp 1.250.000,00 ke rekening BCA'), 'Rp 1.250.000,00');
	assert.strictEqual(finance.findAmountToken('kirim 1,5jt buat adik'), '1,5jt');
	assert.strictEqual(finance.findAmountToken('tidak ada nominal di sini'), null);
});

test('extractAmount: finds and parses in one step', () => {
	assert.strictEqual(finance.extractAmount('makan siang 45rb'), 45_000);
	assert.strictEqual(finance.extractAmount('transfer Rp 1.250.000,00 ke rekening'), 1_250_000);
	assert.strictEqual(finance.extractAmount('tidak ada nominal'), null);
});

test('regexHint: pairs the extracted amount with an in/out direction guess', () => {
	assert.deepStrictEqual(finance.regexHint('makan siang 45rb'), { amount: 45_000, type: 'out' });
	assert.deepStrictEqual(finance.regexHint('gaji masuk Rp 5.000.000'), { amount: 5_000_000, type: 'in' });
	assert.deepStrictEqual(finance.regexHint('dapat refund 20rb'), { amount: 20_000, type: 'in' });
});
