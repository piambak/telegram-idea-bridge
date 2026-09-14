const fs = require('fs');
const path = require('path');
const { parseJsonLoose } = require('./claude');

const SKILLS_DIR = path.join(__dirname, '..', '.claude', 'skills');

// Frontmatter is deliberately flat (key: value, one per line) rather than
// full YAML — everything lib/skills.js needs to configure a fast-tier call
// (model, temperature, max_tokens, json_mode, the output contract) fits
// that, and it avoids adding a YAML parser dependency (CLAUDE.md: keep
// dependencies minimal). Claude Code itself only reads name/description
// from the same frontmatter and ignores the rest.
function parseFrontmatter(raw) {
	const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!match) return { meta: {}, body: raw.trim() };
	const [, fmText, body] = match;
	const meta = {};
	for (const line of fmText.split(/\r?\n/)) {
		const eq = line.indexOf(':');
		if (eq === -1) continue;
		const key = line.slice(0, eq).trim();
		if (!key) continue;
		const value = line.slice(eq + 1).trim();
		if (value === 'true') meta[key] = true;
		else if (value === 'false') meta[key] = false;
		else if (value !== '' && !Number.isNaN(Number(value))) meta[key] = Number(value);
		else meta[key] = value;
	}
	return { meta, body: body.trim() };
}

const cache = new Map();

// Loads and parses <name>/SKILL.md. Cached — the file only changes when
// someone edits a skill, not per call.
function loadSkill(name) {
	if (cache.has(name)) return cache.get(name);
	const filePath = path.join(SKILLS_DIR, name, 'SKILL.md');
	const raw = fs.readFileSync(filePath, 'utf8');
	const { meta, body } = parseFrontmatter(raw);
	const skill = { name, meta, body, filePath };
	cache.set(name, skill);
	return skill;
}

function listSkillNames() {
	return fs.readdirSync(SKILLS_DIR).filter((name) => fs.existsSync(path.join(SKILLS_DIR, name, 'SKILL.md')));
}

// Replaces {{var}} tokens in a skill body with values from `vars` — the
// mechanism event-parse's {{extra}} (today's WIB date+weekday) and similar
// per-call context relies on. A var with no matching key becomes an empty
// string rather than leaving the literal token in the prompt.
function renderSkillBody(body, vars = {}) {
	return body.replace(/\{\{(\w+)\}\}/g, (whole, key) => (key in vars ? String(vars[key]) : ''));
}

// Fast-tier runner: loads <name>/SKILL.md, uses its (rendered) body as the
// system prompt, and calls `chat` with the skill's own
// temperature/max_tokens/json-mode from frontmatter — so a skill's tuning
// lives in one place (the SKILL.md) instead of being duplicated at each
// call site. Returns parsed JSON when the skill declares json_mode, else
// the raw text reply. `vars` fills {{var}} tokens in the skill body (e.g.
// event-parse's {{extra}} — see docs/AGENTS-SKILLS.md's wiring example:
// `skills.runFast('event-parse', rest, model.chat, { extra: ... })`).
async function runFast(name, userText, chat, vars = {}) {
	const skill = loadSkill(name);
	const systemPrompt = renderSkillBody(skill.body, vars);
	const params = {};
	if (typeof skill.meta.temperature === 'number') params.temperature = skill.meta.temperature;
	if (typeof skill.meta.max_tokens === 'number') params.max_tokens = skill.meta.max_tokens;
	if (skill.meta.json_mode) params.response_format = { type: 'json_object' };

	const reply = await chat(
		[
			{ role: 'system', content: systemPrompt },
			{ role: 'user', content: userText },
		],
		{ params },
	);

	return skill.meta.json_mode ? parseJsonLoose(reply) : reply;
}

// output_required/output_types are comma-separated flat lists in
// frontmatter (see parseFrontmatter's rationale above), e.g.
// "output_required: title, tags" / "output_types: title=string, tags=array".
function parseContractFields(meta) {
	const required = String(meta.output_required || '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	const types = {};
	for (const pair of String(meta.output_types || '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean)) {
		const [key, type] = pair.split('=').map((s) => s.trim());
		if (key) types[key] = type;
	}
	return { required, types };
}

const TYPE_CHECKS = {
	string: (v) => typeof v === 'string',
	number: (v) => typeof v === 'number',
	integer: (v) => typeof v === 'number' && Number.isInteger(v),
	boolean: (v) => typeof v === 'boolean',
	array: (v) => Array.isArray(v),
	object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
};

// Not full JSON Schema — just enough to catch a skill's declared contract
// drifting out of sync with its own documented example (which is exactly
// what the test suite checks every skill against).
function validateContract(meta, data) {
	const { required, types } = parseContractFields(meta);
	const errors = [];
	if (data === null || typeof data !== 'object' || Array.isArray(data)) {
		return [`expected a JSON object at the top level, got ${JSON.stringify(data)}`];
	}
	for (const key of required) {
		if (!(key in data)) errors.push(`missing required field "${key}"`);
	}
	for (const [key, type] of Object.entries(types)) {
		if (!(key in data)) continue; // already reported above if it was required
		const check = TYPE_CHECKS[type];
		if (check && !check(data[key])) errors.push(`field "${key}" should be ${type}, got ${JSON.stringify(data[key])}`);
	}
	return errors;
}

// Pulls the first ```json ... ``` block out of a skill's body — the
// "## Output contract" example every json_mode skill documents itself with.
function extractJsonExample(body) {
	const match = body.match(/```json\r?\n([\s\S]*?)\r?\n```/);
	if (!match) return null;
	return JSON.parse(match[1]);
}

const JSON_SCHEMA_TYPE = { string: 'string', number: 'number', integer: 'integer', boolean: 'boolean', array: 'array', object: 'object' };

// Derives a real JSON Schema (for claude.runSkill's --json-schema) from a
// skill's own output_required/output_types frontmatter, so the deep tier's
// schema can never drift out of sync with what the skill itself documents —
// one definition, not a hand-copied duplicate at each call site.
function schemaFor(name) {
	const skill = loadSkill(name);
	const { required, types } = parseContractFields(skill.meta);
	const properties = {};
	for (const [key, type] of Object.entries(types)) {
		properties[key] = { type: JSON_SCHEMA_TYPE[type] || 'string' };
	}
	return { type: 'object', required, properties };
}

module.exports = {
	SKILLS_DIR,
	loadSkill,
	listSkillNames,
	renderSkillBody,
	runFast,
	parseContractFields,
	validateContract,
	extractJsonExample,
	schemaFor,
};
