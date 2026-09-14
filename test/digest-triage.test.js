const { test } = require('node:test');
const assert = require('node:assert');

const digest = require('../lib/digest');

function baseMsg(overrides) {
	return {
		id: 'm1',
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

// --- individual rules ---

test('rule: an .ics-bearing message is always a meeting, regardless of content', () => {
	const msg = baseMsg({ ics: 'BEGIN:VEVENT\r\nDTSTART:20260918T070000Z\r\nSUMMARY:Sync\r\nEND:VEVENT', text: 'Rp 50.000 transaksi' });
	assert.strictEqual(digest.isMeeting(msg), true);
});

test('rule: a known bank/e-wallet sender still needs a readable amount — a plain statement notice is not a transaction', () => {
	const msg = baseMsg({ from: { name: 'BCA', email: 'notifikasi@bca.co.id' }, text: 'Your statement is ready.' });
	assert.strictEqual(digest.isFinance(msg), false);
});

test('rule: a known bank/e-wallet sender with a readable amount is finance', () => {
	const msg = baseMsg({ from: { name: 'BCA', email: 'notifikasi@bca.co.id' }, text: 'Transaksi Rp 50.000 berhasil.' });
	assert.strictEqual(digest.isFinance(msg), true);
});

test('rule: a readable Rp amount is finance even from an unknown sender (delegated to lib/finance.js)', () => {
	const msg = baseMsg({ text: 'Pembayaran Rp 125.000 berhasil diproses.' });
	assert.strictEqual(digest.isFinance(msg), true);
});

test('rule: no readable amount and not a known finance sender is NOT finance', () => {
	const msg = baseMsg({ text: 'Just a normal email with no numbers in it.' });
	assert.strictEqual(digest.isFinance(msg), false);
});

test('rule: OTP/login codes are system notifications', () => {
	const msg = baseMsg({ subject: 'Your OTP code', text: 'Your verification code is 123456.' });
	assert.strictEqual(digest.isSystem(msg), true);
});

test('rule: CATEGORY_PROMOTIONS label or unsubscribe/promo wording is newsletter', () => {
	assert.strictEqual(digest.isNewsletter(baseMsg({ labels: ['CATEGORY_PROMOTIONS'] })), true);
	assert.strictEqual(digest.isNewsletter(baseMsg({ text: 'Click here to unsubscribe from this list.' })), true);
	assert.strictEqual(digest.isNewsletter(baseMsg({ text: 'Diskon 50% khusus hari ini!' })), true);
	assert.strictEqual(digest.isNewsletter(baseMsg({ text: 'Just a normal email.' })), false);
});

// Amount/direction/account extraction and Rupiah parsing now live in
// lib/finance.js (see test/finance-amount.test.js and test/finance-email.test.js)
// — digest.js just delegates to finance.fromEmail, tested above via isFinance.

// --- triage(): rules-first, model for the rest, merged in original order ---

test('triage(): rule-matched messages never reach the model; the rest go to email-triage in order', async () => {
	const meetingMsg = baseMsg({ id: 'meeting', ics: 'BEGIN:VEVENT\r\nDTSTART:20260918T070000Z\r\nSUMMARY:Standup\r\nEND:VEVENT' });
	const financeMsg = baseMsg({ id: 'finance', from: { name: 'BCA', email: 'noreply@bca.co.id' }, text: 'transaksi Rp 10.000' });
	const otpMsg = baseMsg({ id: 'otp', subject: 'OTP', text: 'Your verification code is 111111' });
	const newsletterMsg = baseMsg({ id: 'newsletter', text: 'unsubscribe anytime' });
	const officeMsg = baseMsg({ id: 'office', subject: 'Rapat koordinasi minggu depan', text: 'Mohon konfirmasi kehadiran.' });

	let seenListing;
	const chat = async (messages) => {
		seenListing = messages[1].content; // [system, user]
		return JSON.stringify({ items: [{ category: 'action', summary: 'Konfirmasi kehadiran rapat', action: 'Balas email', due: null, priority: 'high', event: null }] });
	};

	const results = await digest.triage([meetingMsg, financeMsg, otpMsg, newsletterMsg, officeMsg], chat);

	assert.strictEqual(results.length, 5);
	assert.strictEqual(results[0].category, 'meeting');
	assert.strictEqual(results[0].event.title, 'Standup');
	assert.strictEqual(results[1].category, 'finance');
	assert.strictEqual(results[1].transaction.amount, 10000);
	assert.strictEqual(results[1].transaction.ref, 'finance', 'ref must be the email id, for dedup on re-run');
	assert.strictEqual(results[2].category, 'system');
	assert.strictEqual(results[3].category, 'newsletter');
	assert.strictEqual(results[4].category, 'action', 'the one message with no rule match should get the model\'s category');
	assert.strictEqual(results[4].action, 'Balas email');
	assert.ok(seenListing.includes('Rapat koordinasi minggu depan'), 'only the non-rule-matched message should have been sent to the model');
	assert.ok(!seenListing.includes('Standup'), 'rule-matched messages must not reach the model at all');
});

test('triage(): batches model-bound messages 8 at a time', async () => {
	const messages = Array.from({ length: 10 }, (_, i) => baseMsg({ id: `office-${i}`, subject: `Info ${i}` }));
	const batchSizes = [];
	const chat = async (messages) => {
		const count = messages[1].content.split('---').length;
		batchSizes.push(count);
		return JSON.stringify({ items: Array.from({ length: count }, () => ({ category: 'office', summary: 'x', action: null, due: null, priority: 'low', event: null })) });
	};
	const results = await digest.triage(messages, chat);
	assert.deepStrictEqual(batchSizes, [8, 2]);
	assert.strictEqual(results.length, 10);
});

test('triage(): a failed email-triage call falls back to a safe default per item instead of throwing', async () => {
	const messages = [baseMsg({ id: 'a' }), baseMsg({ id: 'b' })];
	const chat = async () => {
		throw new Error('model unavailable');
	};
	const results = await digest.triage(messages, chat);
	assert.strictEqual(results.length, 2);
	for (const r of results) {
		assert.strictEqual(r.category, 'office');
		assert.strictEqual(r.priority, 'low');
	}
});

// --- groupByCategory(): fixed display order, empty categories omitted ---

test('groupByCategory: fixed display order regardless of input order, empty categories omitted', () => {
	const triaged = [
		{ message: baseMsg({ id: '1' }), category: 'newsletter' },
		{ message: baseMsg({ id: '2' }), category: 'action' },
		{ message: baseMsg({ id: '3' }), category: 'meeting' },
		{ message: baseMsg({ id: '4' }), category: 'action' },
	];
	const grouped = digest.groupByCategory(triaged);
	assert.deepStrictEqual(grouped.map((g) => g.category), ['action', 'meeting', 'newsletter']);
	assert.strictEqual(grouped[0].label, '🔴 Perlu tindakan');
	assert.strictEqual(grouped[0].items.length, 2);
	assert.strictEqual(grouped.find((g) => g.category === 'finance'), undefined, 'a category with no items must not appear');
});
