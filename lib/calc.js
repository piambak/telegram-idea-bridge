const { execFile } = require('child_process');
const math = require('mathjs');

const EXTRACT_EXPRESSION_PROMPT = `You convert word problems into a single mathjs-compatible
math expression. The user will describe a math problem in words. Respond with ONLY the
expression (numbers and operators, e.g. "5 + 3 * 2" or "(120 - 20) / 4") — no words, no
explanation, no units, no "=", no code fences. If the problem cannot be reduced to a single
expression, respond with exactly: NONE`;

// Real computation only — never trust a model's own arithmetic. Models are
// used only to turn words/images into an expression string; mathjs evaluates it.
function evaluateExpression(expr) {
	const result = math.evaluate(expr.trim());
	if (typeof result === 'function') throw new Error('Not a valid expression');
	return math.format(result, { precision: 12 });
}

async function solveText(text, chat) {
	try {
		return { expression: text.trim(), result: evaluateExpression(text) };
	} catch {
		// Not a bare expression — treat as a word problem.
	}
	const expr = await chat([
		{ role: 'system', content: EXTRACT_EXPRESSION_PROMPT },
		{ role: 'user', content: text },
	]);
	if (expr.trim().toUpperCase() === 'NONE') {
		throw new Error("Couldn't turn that into a calculation");
	}
	return { expression: expr.trim(), result: evaluateExpression(expr) };
}

// Uses the local Claude Code CLI (headless) to read an image and extract a
// math expression from it — Claude's Read tool handles images natively.
function solveImage(imagePath, { timeoutMs = 90 * 1000 } = {}) {
	return new Promise((resolve, reject) => {
		const prompt = `Read the image at "${imagePath}" and extract the math problem shown. ` +
			`Respond with ONLY a single mathjs-compatible expression (e.g. "5 + 3 * 2"), no words, ` +
			`no explanation, no units. If no math problem is visible, respond with exactly: NONE`;
		execFile(
			'claude',
			['-p', prompt, '--add-dir', require('path').dirname(imagePath), '--allowedTools', 'Read'],
			{ timeout: timeoutMs, maxBuffer: 1024 * 1024 },
			(err, stdout, stderr) => {
				if (err) return reject(new Error(`Claude CLI failed: ${stderr || err.message}`));
				const expr = stdout.trim();
				if (!expr || expr.toUpperCase() === 'NONE') {
					return reject(new Error('No math problem found in the image'));
				}
				try {
					resolve({ expression: expr, result: evaluateExpression(expr) });
				} catch (e) {
					reject(new Error(`Claude read "${expr}" but that's not a valid expression`));
				}
			},
		);
	});
}

module.exports = { solveText, solveImage, evaluateExpression };
