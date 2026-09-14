const fs = require('fs');
const path = require('path');
const math = require('mathjs');
const skills = require('./skills');
const claude = require('./claude');
const models = require('./models');

// Real computation only — never trust a model's own arithmetic. Models are
// used only to turn words/images into an expression string; mathjs evaluates it.
function evaluateExpression(expr) {
	const result = math.evaluate(expr.trim());
	if (typeof result === 'function') throw new Error('Not a valid expression');
	return math.format(result, { precision: 12 });
}

function fromExpressionResult(data, notFoundMessage) {
	if (!data || data.none || !data.expression) throw new Error(notFoundMessage);
	return { expression: data.expression, result: evaluateExpression(data.expression) };
}

// Word problems -> a single mathjs expression. Prompt lives in
// .claude/skills/calc-expression/SKILL.md.
async function solveText(text, chat) {
	try {
		return { expression: text.trim(), result: evaluateExpression(text) };
	} catch {
		// Not a bare expression — treat as a word problem.
	}
	const data = await skills.runFast('calc-expression', text, chat);
	return fromExpressionResult(data, "Couldn't turn that into a calculation");
}

const MIME_BY_EXT = { '.jpg': 'jpeg', '.jpeg': 'jpeg', '.png': 'png', '.webp': 'webp', '.gif': 'gif' };

// Photo of a math problem -> a single mathjs expression. Fast tier first:
// Gemini Flash vision via the OpenAI-compatible `image_url` content part
// (same contract as calc-expression, prompt in
// .claude/skills/calc-vision/SKILL.md). Falls back to the vision-math-reader
// deep agent (Claude, via Read on the file) if the fast vision call fails —
// docs/AGENTS-SKILLS.md, docs/ANALYSIS.md §6.
async function solveImage(imagePath, { timeoutMs = 90 * 1000 } = {}) {
	try {
		return await solveImageFast(imagePath);
	} catch {
		return await solveImageDeep(imagePath, timeoutMs);
	}
}

async function solveImageFast(imagePath) {
	const buffer = fs.readFileSync(imagePath);
	const mime = MIME_BY_EXT[path.extname(imagePath).toLowerCase()] || 'jpeg';
	const userContent = [
		{ type: 'text', text: 'Read the math problem in this image and follow the system instructions.' },
		{ type: 'image_url', image_url: { url: `data:image/${mime};base64,${buffer.toString('base64')}` } },
	];
	const data = await skills.runFast('calc-vision', userContent, models.MODELS.gemini.chat);
	return fromExpressionResult(data, 'No math problem found in the image');
}

async function solveImageDeep(imagePath, timeoutMs) {
	const result = await claude.runSkill('calc-vision', imagePath, {
		agent: 'vision-math-reader',
		addDir: path.dirname(imagePath),
		allowedTools: 'Read',
		schema: skills.schemaFor('calc-vision'),
		timeoutMs,
	});
	if (!result.ok) throw new Error(result.error || 'Claude CLI failed to read the image');
	return fromExpressionResult(result.data, 'No math problem found in the image');
}

module.exports = { solveText, solveImage, evaluateExpression };
