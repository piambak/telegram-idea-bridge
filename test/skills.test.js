const { test } = require('node:test');
const assert = require('node:assert');

const skills = require('../lib/skills');

const EXPECTED_SKILLS = [
	// docs/ANALYSIS.md §6
	'idea-enhance',
	'ask',
	'grammar-fix',
	'prompt-gen',
	'wa-broadcast',
	'calc-expression',
	'calc-vision',
	'summarize-short',
	'summarize-long',
	'source-capture',
	'news-digest',
	'event-parse',
	'office-doc',
	'table-builder',
	'reg-digest',
	'reg-deep-dive',
	'image-query',
	'vault-review',
	// docs/V2-SPEC.md §5 / §3
	'email-triage',
	'txn-extract',
	'reminder-parse',
	'finance-commentary',
	'receipt-vision',
];

test('every expected skill directory exists and its SKILL.md parses', () => {
	const found = skills.listSkillNames();
	for (const name of EXPECTED_SKILLS) {
		assert.ok(found.includes(name), `missing .claude/skills/${name}/SKILL.md`);
		const skill = skills.loadSkill(name);
		assert.strictEqual(skill.meta.name, name, `frontmatter name should match the directory for ${name}`);
		assert.ok(skill.meta.description, `${name} should have a frontmatter description`);
		assert.ok(skill.body.length > 0, `${name}'s body should not be empty`);
	}
	assert.strictEqual(found.length, EXPECTED_SKILLS.length, 'no extra or missing skill directories');
});

test('every skill states its language rule, one way or another', () => {
	for (const name of skills.listSkillNames()) {
		const skill = skills.loadSkill(name);
		assert.ok('language_rule' in skill.meta, `${name} should declare language_rule in frontmatter`);
		assert.match(skill.body, /## Language rule/, `${name}'s body should have a "## Language rule" section`);
	}
});

test('every skill documents role, procedure, output contract, and guardrails', () => {
	for (const name of skills.listSkillNames()) {
		const skill = skills.loadSkill(name);
		assert.match(skill.body, /## Role/, `${name} missing ## Role`);
		assert.match(skill.body, /## Procedure/, `${name} missing ## Procedure`);
		assert.match(skill.body, /## Output contract/, `${name} missing ## Output contract`);
		assert.match(skill.body, /## Guardrails/, `${name} missing ## Guardrails`);
	}
});

test('every json_mode skill\'s declared contract validates against its own documented example', () => {
	const jsonModeSkills = skills.listSkillNames().filter((name) => skills.loadSkill(name).meta.json_mode);
	assert.ok(jsonModeSkills.length > 0, 'sanity check: there should be at least one json_mode skill');

	for (const name of jsonModeSkills) {
		const skill = skills.loadSkill(name);
		const example = skills.extractJsonExample(skill.body);
		assert.ok(example, `${name} declares json_mode but has no \`\`\`json example in its body`);
		const errors = skills.validateContract(skill.meta, example);
		assert.deepStrictEqual(errors, [], `${name}'s own example fails its declared contract:\n${errors.join('\n')}`);
	}
});

test('a plain-text (json_mode: false) skill has no output_required to validate', () => {
	const skill = skills.loadSkill('ask');
	assert.strictEqual(skill.meta.json_mode, false);
	assert.strictEqual(skill.meta.output_required, undefined);
});

// --- lib/skills.js mechanics ---

test('renderSkillBody substitutes {{var}} tokens and blanks out ones with no value', () => {
	const rendered = skills.renderSkillBody('Now: {{extra}}. Unset: [{{missing}}].', { extra: 'Senin, 2026-09-14 09:30 WIB' });
	assert.strictEqual(rendered, 'Now: Senin, 2026-09-14 09:30 WIB. Unset: [].');
});

test('event-parse\'s real {{extra}} token is substituted end-to-end by runFast', async () => {
	let seenSystemPrompt;
	const chat = async (messages) => {
		seenSystemPrompt = messages[0].content;
		return JSON.stringify({ title: 'Rapat', start: '2026-09-18T10:00', end: '2026-09-18T11:00', location: '', description: '', confidence: 0.9 });
	};

	await skills.runFast('event-parse', 'rapat besok', chat, { extra: 'Senin, 2026-09-14 09:30 WIB' });

	assert.ok(seenSystemPrompt.includes('Senin, 2026-09-14 09:30 WIB'), 'the substituted value should reach the system prompt');
	assert.ok(!seenSystemPrompt.includes('{{extra}}'), 'the raw token should not survive substitution');
});

test('runFast parses a json_mode skill\'s reply into an object using the skill\'s own params', async () => {
	let seenOpts;
	const chat = async (messages, opts) => {
		seenOpts = opts;
		return '{"corrected": "Halo, apa kabar?", "changes": ["added comma"]}';
	};

	const result = await skills.runFast('grammar-fix', 'Halo apa kabar', chat);

	assert.deepStrictEqual(result, { corrected: 'Halo, apa kabar?', changes: ['added comma'] });
	assert.strictEqual(seenOpts.params.temperature, 0.2, 'grammar-fix declares temperature: 0.2 in its frontmatter');
	assert.deepStrictEqual(seenOpts.params.response_format, { type: 'json_object' });
});

test('runFast tolerates a markdown-fenced JSON reply from a json_mode skill', async () => {
	const chat = async () => '```json\n{"expression": "5 + 3"}\n```';
	const result = await skills.runFast('calc-expression', '5 tambah 3', chat);
	assert.deepStrictEqual(result, { expression: '5 + 3' });
});

test('runFast returns the raw text unparsed for a non-json_mode skill', async () => {
	const chat = async () => 'Halo! Apa kabar?';
	const result = await skills.runFast('ask', 'halo', chat);
	assert.strictEqual(result, 'Halo! Apa kabar?');
});

// --- schemaFor: derives a --json-schema for claude.runSkill from a skill's
// own output_required/output_types, so the deep tier's schema can never
// drift out of sync with what the SKILL.md itself documents ---

test('schemaFor builds a JSON Schema matching the skill\'s output_required/output_types', () => {
	const schema = skills.schemaFor('idea-enhance');
	assert.strictEqual(schema.type, 'object');
	assert.deepStrictEqual(new Set(schema.required), new Set(['title', 'tags', 'body', 'language', 'save_confidence']));
	assert.deepStrictEqual(schema.properties.title, { type: 'string' });
	assert.deepStrictEqual(schema.properties.tags, { type: 'array' });
	assert.deepStrictEqual(schema.properties.save_confidence, { type: 'number' });
});

test('every deep-tier skill\'s schemaFor() output validates its own documented example', () => {
	for (const name of skills.listSkillNames()) {
		const skill = skills.loadSkill(name);
		if (skill.meta.tier !== 'deep' || !skill.meta.json_mode) continue;
		const schema = skills.schemaFor(name);
		const example = skills.extractJsonExample(skill.body);
		for (const key of schema.required) {
			assert.ok(key in example, `${name}: schemaFor() requires "${key}" but the example is missing it`);
		}
	}
});
