const { test } = require('node:test');
const assert = require('node:assert');

// docs/ANALYSIS.md bug #18: prompts didn't pin the language, so an
// Indonesian idea/text often came back in English. Each of these prompts
// must now explicitly tell the model to match the input's language.
const { ENHANCE_SYSTEM_PROMPT } = require('../lib/enhance');
const { GRAMMAR_PROMPT, PROMPTGEN_PROMPT } = require('../lib/jobs');
const { SUMMARY_PROMPT } = require('../lib/summarize');

const LANGUAGE_RULE = /same language/i;

test('idea-enhance prompt pins the reply language', () => {
	assert.match(ENHANCE_SYSTEM_PROMPT, LANGUAGE_RULE);
});

test('grammar-fix prompt pins the reply language', () => {
	assert.match(GRAMMAR_PROMPT, LANGUAGE_RULE);
});

test('promptgen prompt pins the reply language', () => {
	assert.match(PROMPTGEN_PROMPT, LANGUAGE_RULE);
});

test('summarize prompt pins the reply language', () => {
	assert.match(SUMMARY_PROMPT, LANGUAGE_RULE);
});
