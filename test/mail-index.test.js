const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// STATE_DIR must be set before lib/config (and therefore lib/mail/index) is
// first required, so cursor/seen files never touch the real repo.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-bridge-mailindex-'));
process.env.STATE_DIR = path.join(tmpRoot, '.state');
process.env.MAIL_PROVIDERS = 'gmail,outlook';

const mail = require('../lib/mail');
const gmail = require('../lib/mail/gmail');
const outlook = require('../lib/mail/outlook');
const state = require('../lib/state');

test.after(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	delete process.env.STATE_DIR;
	delete process.env.MAIL_PROVIDERS;
});

const fixtureMsg = (id, provider, overrides = {}) => ({
	id,
	provider,
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
});

test('fetchNew: merges messages from every configured provider', async (t) => {
	t.mock.method(gmail, 'fetchNew', async () => [fixtureMsg('g1', 'gmail')]);
	t.mock.method(outlook, 'fetchNew', async () => [fixtureMsg('o1', 'outlook')]);

	const { messages, errors } = await mail.fetchNew();

	assert.strictEqual(errors.length, 0);
	assert.deepStrictEqual(
		messages.map((m) => m.id).sort(),
		['g1', 'o1'],
	);
});

test('fetchNew: a message id already in the seen-set is not returned again on a later call', async (t) => {
	t.mock.method(gmail, 'fetchNew', async () => [fixtureMsg('dup1', 'gmail')]);
	t.mock.method(outlook, 'fetchNew', async () => []);

	const first = await mail.fetchNew();
	assert.ok(first.messages.some((m) => m.id === 'dup1'));

	const second = await mail.fetchNew();
	assert.ok(!second.messages.some((m) => m.id === 'dup1'), 'a previously-seen id must not resurface');
});

test('fetchNew: one provider failing does not hide the other — collected in errors, not thrown', async (t) => {
	t.mock.method(gmail, 'fetchNew', async () => {
		throw new Error('invalid_grant: token revoked');
	});
	t.mock.method(outlook, 'fetchNew', async () => [fixtureMsg('o-ok', 'outlook')]);

	const { messages, errors } = await mail.fetchNew();

	assert.strictEqual(messages.length, 1);
	assert.strictEqual(messages[0].id, 'o-ok');
	assert.strictEqual(errors.length, 1);
	assert.strictEqual(errors[0].provider, 'gmail');
	assert.match(errors[0].message, /invalid_grant/);
});

test('fetchNew: a failing provider\'s cursor is left untouched so the next run retries the same window', async (t) => {
	const seenSince = [];
	t.mock.method(gmail, 'fetchNew', async ({ sinceMs }) => {
		seenSince.push(sinceMs);
		throw new Error('down');
	});
	t.mock.method(outlook, 'fetchNew', async () => []);

	await mail.fetchNew();
	await mail.fetchNew();

	assert.strictEqual(seenSince.length, 2);
	assert.strictEqual(seenSince[0], seenSince[1], 'the cursor must not have advanced after a failure');
});

test('fetchNew: a succeeding provider\'s cursor DOES advance, narrowing the next call\'s window', async (t) => {
	const seenSince = [];
	t.mock.method(outlook, 'fetchNew', async ({ sinceMs }) => {
		seenSince.push(sinceMs);
		return [];
	});
	t.mock.method(gmail, 'fetchNew', async () => []);

	await mail.fetchNew();
	await new Promise((r) => setTimeout(r, 5));
	await mail.fetchNew();

	assert.strictEqual(seenSince.length, 2);
	assert.ok(seenSince[1] > seenSince[0], 'the second call\'s cursor should start later than the first');
});

test('fetchNew({overrideHours}): widens the lookback window for this call ("/inbox 72h")', async (t) => {
	let seenSince;
	t.mock.method(gmail, 'fetchNew', async ({ sinceMs }) => {
		seenSince = sinceMs;
		return [];
	});
	t.mock.method(outlook, 'fetchNew', async () => []);

	const before = Date.now();
	await mail.fetchNew({ overrideHours: 72 });
	const expectedFloor = before - 72 * 3600 * 1000;

	assert.ok(Math.abs(seenSince - expectedFloor) < 5000, 'sinceMs should reflect a 72h lookback, not the stored cursor');
});

test('fetchNew: cursors and the seen-set actually persist to .state/, surviving a fresh require (a "restart")', async (t) => {
	t.mock.method(gmail, 'fetchNew', async () => [fixtureMsg('persisted-1', 'gmail')]);
	t.mock.method(outlook, 'fetchNew', async () => []);

	await mail.fetchNew();

	const cursors = state.readJson('mail-cursor.json', {});
	const seen = state.readJson('mail-seen.json', []);
	assert.ok(typeof cursors.gmail === 'number');
	assert.ok(seen.includes('persisted-1'));
});
