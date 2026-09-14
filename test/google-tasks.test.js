const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idea-bridge-gtasks-'));
const tokenFile = path.join(tmpRoot, 'token.json');
fs.writeFileSync(tokenFile, JSON.stringify({ access_token: 'a1', refresh_token: 'r1', expiry_date: Date.now() + 3600_000 }));

const { env } = require('../lib/config');
env.GOOGLE_TOKEN_PATH = tokenFile;
env.GOOGLE_CLIENT_ID = 'client-id';
env.GOOGLE_CLIENT_SECRET = 'client-secret';

const tasks = require('../lib/google/tasks');

test.after(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	delete env.GOOGLE_TOKEN_PATH;
	delete env.GOOGLE_TASKS_LIST;
});

test('listName() defaults to "Idea Bridge", honors GOOGLE_TASKS_LIST', () => {
	assert.strictEqual(tasks.listName(), 'Idea Bridge');
	env.GOOGLE_TASKS_LIST = 'My Tasks';
	assert.strictEqual(tasks.listName(), 'My Tasks');
	delete env.GOOGLE_TASKS_LIST;
});

test('ensureTaskList(): returns the existing list\'s id without creating a new one', async (t) => {
	let createCalled = false;
	t.mock.method(global, 'fetch', async (url, opts) => {
		if (String(url).endsWith('/users/@me/lists') && (!opts || opts.method !== 'POST')) {
			return { ok: true, json: async () => ({ items: [{ id: 'list-1', title: 'Idea Bridge' }] }) };
		}
		createCalled = true;
		return { ok: true, json: async () => ({ id: 'should-not-happen' }) };
	});
	const listId = await tasks.ensureTaskList();
	assert.strictEqual(listId, 'list-1');
	assert.strictEqual(createCalled, false);
});

test('ensureTaskList(): creates the list on first use when it does not exist yet', async (t) => {
	t.mock.method(global, 'fetch', async (url, opts) => {
		if (String(url).endsWith('/users/@me/lists') && opts.method === 'POST') {
			const body = JSON.parse(opts.body);
			assert.strictEqual(body.title, 'Idea Bridge');
			return { ok: true, json: async () => ({ id: 'new-list-1', title: 'Idea Bridge' }) };
		}
		return { ok: true, json: async () => ({ items: [] }) };
	});
	const listId = await tasks.ensureTaskList();
	assert.strictEqual(listId, 'new-list-1');
});

test('createTask(): posts a task with due date and notes (e.g. the source email link) to the ensured list', async (t) => {
	let seenBody;
	let seenPath;
	t.mock.method(global, 'fetch', async (url, opts) => {
		if (String(url).endsWith('/users/@me/lists')) {
			return { ok: true, json: async () => ({ items: [{ id: 'list-1', title: 'Idea Bridge' }] }) };
		}
		seenPath = url;
		seenBody = JSON.parse(opts.body);
		return { ok: true, json: async () => ({ id: 'task-1' }) };
	});

	const result = await tasks.createTask({ title: 'Balas email pak Budi', due: '2026-09-20T00:00:00.000Z', notes: 'https://mail.google.com/...' });

	assert.match(String(seenPath), /\/lists\/list-1\/tasks/);
	assert.strictEqual(seenBody.title, 'Balas email pak Budi');
	assert.strictEqual(seenBody.due, '2026-09-20T00:00:00.000Z');
	assert.strictEqual(seenBody.notes, 'https://mail.google.com/...');
	assert.deepStrictEqual(result, { id: 'task-1', listId: 'list-1' });
});

test('createTask(): omits due entirely when none is given, rather than sending a bogus date', async (t) => {
	let seenBody;
	t.mock.method(global, 'fetch', async (url, opts) => {
		if (String(url).endsWith('/users/@me/lists')) return { ok: true, json: async () => ({ items: [{ id: 'list-1', title: 'Idea Bridge' }] }) };
		seenBody = JSON.parse(opts.body);
		return { ok: true, json: async () => ({ id: 'task-2' }) };
	});
	await tasks.createTask({ title: 'No due date' });
	assert.strictEqual('due' in seenBody, false);
});

test('isTaskCompleted(): true once the task status is "completed"', async (t) => {
	t.mock.method(global, 'fetch', async () => ({ ok: true, json: async () => ({ status: 'completed' }) }));
	assert.strictEqual(await tasks.isTaskCompleted('list-1', 'task-1'), true);
});

test('isTaskCompleted(): false while still "needsAction"', async (t) => {
	t.mock.method(global, 'fetch', async () => ({ ok: true, json: async () => ({ status: 'needsAction' }) }));
	assert.strictEqual(await tasks.isTaskCompleted('list-1', 'task-1'), false);
});
