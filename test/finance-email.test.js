const { test } = require('node:test');
const assert = require('node:assert');

const finance = require('../lib/finance');

function msg(overrides) {
	return {
		id: 'msg-1',
		provider: 'gmail',
		from: { name: 'Someone', email: 'someone@example.com' },
		subject: 'Subject',
		date: '2026-09-14T00:00:00.000Z',
		text: '',
		snippet: '',
		labels: [],
		unread: true,
		attachments: [],
		ics: null,
		link: '',
		...overrides,
	};
}

test('isFinanceSender: recognizes a representative sample of the ~40 known bank/e-wallet/marketplace domains', () => {
	const knownSenders = [
		'notifikasi@bca.co.id',
		'noreply@bni.co.id',
		'info@bri.co.id',
		'cs@mandiri.co.id',
		'no-reply@dana.id',
		'notif@ovo.id',
		'noreply@gojek.com',
		'receipt@shopeepay.co.id',
		'info@linkaja.id',
		'noreply@jenius.com',
		'notification@paypal.com',
		'noreply@tokopedia.com',
		'order@shopee.co.id',
	];
	for (const email of knownSenders) assert.strictEqual(finance.isFinanceSender(email), true, `${email} should be recognized`);
	assert.ok(finance.FINANCE_SENDER_DOMAINS.length >= 35, 'should be roughly 40 domains, not a token handful');
});

test('isFinanceSender: a subdomain of a known domain still counts (e.g. mail.bca.co.id)', () => {
	assert.strictEqual(finance.isFinanceSender('notif@mail.bca.co.id'), true);
});

test('isFinanceSender: an unrelated sender is not a finance sender', () => {
	assert.strictEqual(finance.isFinanceSender('friend@gmail.com'), false);
	assert.strictEqual(finance.isFinanceSender(''), false);
	assert.strictEqual(finance.isFinanceSender(undefined), false);
});

test('fromEmail: a known bank sender with a readable amount becomes a Transaction with ref = the email id', () => {
	const email = msg({
		id: 'gmail-abc123',
		from: { name: 'BCA', email: 'notifikasi@bca.co.id' },
		subject: 'Transaksi Debit Kartu',
		text: 'Transaksi debit kartu ****1234 sebesar Rp 150.000,00 di Indomaret berhasil.',
	});
	const txn = finance.fromEmail(email);

	assert.ok(txn);
	assert.strictEqual(txn.amount, 150_000);
	assert.strictEqual(txn.type, 'out');
	assert.strictEqual(txn.account, '1234');
	assert.strictEqual(txn.source, 'email');
	assert.strictEqual(txn.ref, 'gmail-abc123', 'ref must be the email id, for dedup on re-run');
});

test('fromEmail: an incoming-funds email is typed "in" and categorized as Pemasukan', () => {
	const email = msg({ from: { name: 'BCA', email: 'notifikasi@bca.co.id' }, text: 'Dana masuk Rp 5.000.000 ke rekening Anda.' });
	const txn = finance.fromEmail(email);
	assert.strictEqual(txn.type, 'in');
	assert.strictEqual(txn.category, 'Pemasukan');
});

test('fromEmail: a non-financial sender with no readable amount is not a transaction at all (null)', () => {
	const email = msg({ from: { name: 'Newsletter', email: 'news@example.com' }, text: 'Check out our latest blog post!' });
	assert.strictEqual(finance.fromEmail(email), null);
});

test('fromEmail: an unrecognized sender but with a clear Rupiah amount + transaction wording still counts (e.g. a merchant not in the list)', () => {
	const email = msg({ from: { name: 'Some Shop', email: 'billing@someshop.example.id' }, text: 'Pembayaran sebesar 45rb telah diterima.' });
	const txn = finance.fromEmail(email);
	assert.ok(txn, 'an amount alone is enough even from an unlisted sender');
	assert.strictEqual(txn.amount, 45_000);
});

test('fromEmail: a known bank sender with NO readable amount is still not turned into a bogus transaction', () => {
	const email = msg({ from: { name: 'BCA', email: 'notifikasi@bca.co.id' }, text: 'Your monthly e-statement is now available.' });
	assert.strictEqual(finance.fromEmail(email), null);
});

test('fromEmail: uses the message date and falls back to "Transaksi" when there is no subject', () => {
	const email = msg({ from: { name: 'BCA', email: 'notifikasi@bca.co.id' }, subject: '', date: '2026-08-01T03:00:00.000Z', text: 'transaksi Rp 20.000' });
	const txn = finance.fromEmail(email);
	assert.strictEqual(txn.date, '2026-08-01T03:00:00.000Z');
	assert.strictEqual(txn.description, 'Transaksi');
});
