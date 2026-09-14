const auth = require('./auth');
const { env } = require('../config');

const API_BASE = 'https://tasks.googleapis.com/tasks/v1';

// docs/SETUP-GOOGLE.md §4: nothing to configure — the list is created on
// first use, named "Idea Bridge" unless overridden.
function listName() {
	return env.GOOGLE_TASKS_LIST || 'Idea Bridge';
}

async function apiFetch(accessToken, method, pathSuffix, body) {
	const res = await fetch(`${API_BASE}${pathSuffix}`, {
		method,
		headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
		body: body ? JSON.stringify(body) : undefined,
	});
	const json = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(`Google Tasks API failed: HTTP ${res.status}: ${(json.error && json.error.message) || JSON.stringify(json)}`);
	return json;
}

// Finds the task list named listName(), creating it if this is the first
// time it's needed. Not cached — one extra list() call per use is cheap
// for a personal bot, and it keeps this correct even if the list gets
// renamed/deleted out from under a long-running process.
async function ensureTaskList() {
	const accessToken = await auth.getAccessToken();
	const result = await apiFetch(accessToken, 'GET', '/users/@me/lists');
	const existing = (result.items || []).find((l) => l.title === listName());
	if (existing) return existing.id;
	const created = await apiFetch(accessToken, 'POST', '/users/@me/lists', { title: listName() });
	return created.id;
}

// Creates a task with a due date and notes (e.g. an action item's source
// email link) — used for the digest's 📌 Task button and /remind.
async function createTask({ title, due, notes }) {
	const listId = await ensureTaskList();
	const accessToken = await auth.getAccessToken();
	const body = { title, notes: notes || '' };
	if (due) body.due = new Date(due).toISOString();
	const task = await apiFetch(accessToken, 'POST', `/lists/${encodeURIComponent(listId)}/tasks`, body);
	return { id: task.id, listId };
}

// True once the task has been checked off — /remind's daily tick uses this
// to detect completion from the phone and roll the reminder forward.
async function isTaskCompleted(listId, taskId) {
	const accessToken = await auth.getAccessToken();
	const task = await apiFetch(accessToken, 'GET', `/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`);
	return task.status === 'completed';
}

// Marks a task completed from this side — /remind done <n> does the same
// rollover as a phone completion, so the task shouldn't linger open.
async function completeTask(listId, taskId) {
	const accessToken = await auth.getAccessToken();
	await apiFetch(accessToken, 'PATCH', `/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`, { status: 'completed' });
}

module.exports = { ensureTaskList, createTask, isTaskCompleted, completeTask, listName };
