const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// docs/V2-SPEC.md §2, §6: mail.fetchNew -> digest.triage -> autoActions ->
// one Telegram card, silent when there's nothing new.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-bridge-digest-'));
process.env.STATE_DIR = path.join(tmpRoot, '.state');

const telegram = require('../lib/telegram');
const events = [];
telegram.sendMessage = async (chatId, text, extra) => {
	events.push({ type: 'send', chatId, text, extra });
	return { message_id: events.length };
};
telegram.sendChatAction = async () => {};
telegram.setMyCommands = async () => {};

const models = require('../lib/models');
for (const key of Object.keys(models.MODELS)) {
	models.MODELS[key].chat = async () => JSON.stringify({ items: [] });
}

const mail = require('../lib/mail');
const { allowedChatId } = require('../lib/config');
const { runInboxDigest } = require('../bridge');

test.after(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	delete process.env.STATE_DIR;
});

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

test('runInboxDigest: nothing new and no provider errors -> silent, nothing sent', async (t) => {
	events.length = 0;
	t.mock.method(mail, 'fetchNew', async () => ({ messages: [], errors: [] }));

	const result = await runInboxDigest();
	assert.strictEqual(result.sent, false);
	assert.strictEqual(events.length, 0);
});

test('runInboxDigest: a provider error with zero messages still gets a heads-up, not silence', async (t) => {
	events.length = 0;
	t.mock.method(mail, 'fetchNew', async () => ({ messages: [], errors: [{ provider: 'outlook', message: 'token expired' }] }));

	const result = await runInboxDigest();
	assert.strictEqual(result.sent, true);
	assert.match(events.at(-1).text, /outlook/);
	assert.match(events.at(-1).text, /token expired/);
});

test('runInboxDigest: sends one card grouped by category, in the fixed display order', async (t) => {
	events.length = 0;
	const meetingMsg = baseMsg({ id: 'meeting', ics: 'BEGIN:VEVENT\r\nDTSTART:20260918T070000Z\r\nSUMMARY:Standup\r\nEND:VEVENT' });
	const financeMsg = baseMsg({ id: 'finance', from: { name: 'BCA', email: 'notifikasi@bca.co.id' }, text: 'Transaksi Rp 50.000 berhasil.' });
	const newsletterMsg = baseMsg({ id: 'newsletter', text: 'unsubscribe anytime' });
	t.mock.method(mail, 'fetchNew', async () => ({ messages: [meetingMsg, financeMsg, newsletterMsg], errors: [] }));

	const result = await runInboxDigest();
	assert.strictEqual(result.sent, true);
	assert.strictEqual(result.count, 3);

	const last = events.at(-1);
	const idxMeeting = last.text.indexOf('Undangan');
	const idxFinance = last.text.indexOf('Transaksi');
	assert.ok(idxMeeting !== -1 && idxFinance !== -1 && idxMeeting < idxFinance, 'meeting category must be listed before finance, per the fixed order');
	assert.match(last.text, /Rp 50\.000/);
	assert.match(last.text, /Newsletter/, 'newsletter still appears, just as a collapsed quiet section');
});

test('runInboxDigest: /inbox 72h overrides the lookback window', async (t) => {
	events.length = 0;
	let seenOverride;
	t.mock.method(mail, 'fetchNew', async ({ overrideHours }) => {
		seenOverride = overrideHours;
		return { messages: [], errors: [] };
	});

	await runInboxDigest({ overrideHours: 72 });
	assert.strictEqual(seenOverride, 72);
});

test('runInboxDigest: a provider erroring alongside real new mail still shows both the mail and the error', async (t) => {
	events.length = 0;
	const officeMsg = baseMsg({ id: 'office', subject: 'Info kantor' });
	t.mock.method(mail, 'fetchNew', async () => ({ messages: [officeMsg], errors: [{ provider: 'gmail', message: 'HTTP 401' }] }));

	await runInboxDigest();
	const last = events.at(-1);
	assert.match(last.text, /gmail/);
	assert.match(last.text, /HTTP 401/);
});
