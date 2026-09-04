const { execFile } = require('child_process');

// Invokes the local Claude Code CLI headlessly (-p) for high-workload jobs
// that benefit from stronger reasoning/context than the fast free models —
// long-document summarization, drafting, image reading, etc.
function runHeadless(prompt, { timeoutMs = 5 * 60 * 1000, addDir, allowedTools } = {}) {
	return new Promise((resolve, reject) => {
		const args = ['-p', prompt];
		if (addDir) args.push('--add-dir', addDir);
		if (allowedTools) args.push('--allowedTools', allowedTools);
		execFile('claude', args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
			if (err) return reject(new Error(`Claude CLI failed: ${stderr || err.message}`));
			resolve(stdout.trim());
		});
	});
}

module.exports = { runHeadless };
