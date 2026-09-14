const { test } = require('node:test');

// docs/V2-SPEC.md §1 calls for a splitter that breaks long replies at
// paragraph boundaries instead of truncating (see /get today) or letting a
// >4096-char sendMessage throw inside a try block that then reports an
// unrelated "failed" error (docs/ANALYSIS.md bug #3). That helper doesn't
// exist in lib/ yet, so there is nothing to test. Left in place — and not
// skipped silently — so implementing the splitter and forgetting to unskip
// this shows up as a red suite instead of a quiet gap.
test(
	'long replies are split at paragraph boundaries under 4096 chars, never truncated',
	{ skip: 'splitter not implemented yet — see docs/ANALYSIS.md bug #3 / docs/V2-SPEC.md §1' },
	() => {},
);
