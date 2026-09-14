const cp = require('child_process');
const path = require('path');
const { env } = require('./config');

// So .claude/agents and .claude/skills are discovered regardless of the
// caller's own cwd.
const REPO_ROOT = path.join(__dirname, '..');

// Free/fallback models (and Claude itself, sometimes) wrap structured output
// in a ```json ... ``` fence even when told not to. Strip one fence layer
// if the whole string is wrapped in one, then parse.
function parseJsonLoose(text) {
	const trimmed = text.trim();
	const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	return JSON.parse(fenced ? fenced[1] : trimmed);
}

function buildArgs({ agent, resume, schema, addDir, allowedTools }) {
	// -p reads the prompt from stdin when no positional argument follows it
	// (verified against this box's CLI) — the prompt is written to
	// child.stdin below and never appears in this array. Everything here is
	// a short, bounded flag value, so it never risks Windows' 32,767-char
	// argv limit (docs/ANALYSIS.md bug #1).
	const args = ['-p', '--output-format', 'json'];
	if (agent) args.push('--agent', agent);
	if (resume) args.push('--resume', resume);
	if (schema) args.push('--json-schema', JSON.stringify(schema));
	if (addDir) args.push('--add-dir', addDir);
	if (allowedTools) args.push('--allowedTools', allowedTools);
	// Deliberately never --bare: it skips skill/subagent discovery and
	// requires an API key, but this box is logged in with a subscription
	// (docs/AGENTS-SKILLS.md).
	return args;
}

// stdout is the CLI's own JSON envelope (session id, cost, is_error, and a
// `result` string with the model's actual reply). `raw` below is that
// model reply, not the envelope — callers want the text/JSON the model
// produced, not the accounting around it.
function parseResult(code, stdout, stderr) {
	let envelope;
	try {
		envelope = JSON.parse(stdout);
	} catch {
		return { ok: false, data: null, raw: stdout, error: stderr.trim() || `Claude CLI exited ${code} with unparseable output` };
	}
	const raw = typeof envelope.result === 'string' ? envelope.result : stdout;
	if (envelope.is_error) {
		return { ok: false, data: null, raw, error: raw || `Claude CLI reported an error (exit ${code})` };
	}
	let data;
	try {
		data = parseJsonLoose(raw);
	} catch {
		data = raw; // not every skill returns JSON — plain text is a valid result too
	}
	return { ok: true, data, raw, error: null };
}

// Runs the Claude Code CLI headlessly. `prompt` — which may be a whole
// document, tens of thousands of characters — always goes to the child's
// stdin, never as an argv element: Windows caps a process command line at
// 32,767 chars, and a document in the 32k-60k range used to die with a
// spawn error when passed as `-p <prompt>` (docs/ANALYSIS.md bug #1).
//
// Resolves with { ok, data, raw, error } for anything the CLI itself
// completed and reported on (including its own is_error). Rejects only for
// failures outside that contract: the process couldn't be started, or it
// didn't finish within timeoutMs.
function run(prompt, opts = {}) {
	const { timeoutMs = 5 * 60 * 1000 } = opts;
	// Read fresh per call, not cached at module load, so CLAUDE_BIN/
	// CLAUDE_SHELL can be set (or changed, e.g. in tests) any time before
	// a given call. `claude` is a native .exe on this box (docs/ENVIRONMENT.md)
	// so neither is set here, but an npm .cmd shim elsewhere needs both:
	// CLAUDE_BIN=<path>\claude.cmd and CLAUDE_SHELL=1 (spawn can't exec a
	// .cmd directly without a shell on Windows).
	const bin = env.CLAUDE_BIN || 'claude';
	const useShell = env.CLAUDE_SHELL === '1';
	const args = buildArgs(opts);

	return new Promise((resolve, reject) => {
		const child = cp.spawn(bin, args, { cwd: REPO_ROOT, shell: useShell, windowsHide: true });

		let stdout = '';
		let stderr = '';
		let settled = false;

		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill();
			reject(new Error(`Claude CLI timed out after ${timeoutMs}ms`));
		}, timeoutMs);

		child.stdout.on('data', (chunk) => {
			stdout += chunk;
		});
		child.stderr.on('data', (chunk) => {
			stderr += chunk;
		});

		child.on('error', (err) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new Error(`Failed to start Claude CLI: ${err.message}`));
		});

		child.on('close', (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(parseResult(code, stdout, stderr));
		});

		// If the process has already died by the time we write, stdin emits
		// EPIPE — 'error'/'close' above already reject/resolve for that, so
		// this only needs to stop it becoming an unhandled 'error' event.
		child.stdin.on('error', () => {});
		child.stdin.write(prompt);
		child.stdin.end();
	});
}

module.exports = { run, parseJsonLoose };
