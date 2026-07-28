/**
 * Unit tests for the two pieces of logic that are easy to get subtly wrong and
 * impossible to catch with `tsc`: the eval grader's fact matcher, and the shim's
 * tool-call extractor.
 *
 * Both have already shipped one real bug each — the grader scored a fully
 * correct answer 60% because the model wrote "2½" where the golden set says
 * "2-1/2", and the extractor hung forever on a truncated payload. These tests
 * pin that behaviour down.
 *
 * No API key, no network, no model. Run: `npm test`.
 */

import { includesFact } from './run.js';
import {
	extractToolCalls,
	stripUnparsedToolCallJson,
} from '../src/shim/copilot-proxy.js';

let failures = 0;

function check(condition: boolean, label: string): void {
	if (condition) {
		console.log(`  ok    ${label}`);
	} else {
		failures += 1;
		console.log(`  FAIL  ${label}`);
	}
}

function group(name: string): void {
	console.log(`\n${name}`);
}

/* ------------------------------------------------------------- eval grader */

// The real q01 answer that exposed the bug: correct in substance, but written
// with U+00BD where the golden set uses "2-1/2".
const Q01_ANSWER =
	'At 240 V and 200 A, the machine is rated for **25% duty cycle**: 2\u00bd minutes ' +
	'of welding, then 7\u00bd minutes resting, in any 10-minute window (p. 23, p. 7).';

group('grader: facts that must match (were false negatives)');
for (const fact of ['25%', '200 A', '2-1/2', '7-1/2', '10']) {
	check(includesFact(Q01_ANSWER, fact), `matches ${fact}`);
}

// The important half: a looser matcher must not start accepting wrong numbers.
// Every one of these is a plausible near-miss against the same answer.
group('grader: facts that must still be rejected (no score inflation)');
for (const fact of ['30%', '175 A', '3-1/2', '9-1/2', '115 A', '50%']) {
	check(!includesFact(Q01_ANSWER, fact), `rejects ${fact}`);
}

group('grader: fraction/separator equivalence');
check(!includesFact('rated 25% duty cycle', '35%'), 'rejects 35% against 25%');
check(!includesFact('duty cycle 30% at 175 A', '25%'), 'rejects 25% against 30%');
check(includesFact('2 1/2 minutes', '2-1/2'), 'space-separated form matches hyphenated');
check(includesFact('2-1/2 minutes', '2\u00bd'), 'unicode needle matches ascii haystack');

/* -------------------------------------------------------- shim: extraction */

group('shim: tool_call extraction');

// Regression: Copilot emitted one unescaped literal newline inside a 4.5 KB
// `code` string. JSON.parse threw and the whole payload leaked as prose.
const rawNewline =
	'{"tool_calls":[{"name":"mk","input":{"code":"function App(){\n  const r = 1;\n}"}}]}';
const parsed = extractToolCalls(rawNewline);
check(
	parsed?.calls.length === 1 &&
		String(parsed.calls[0]?.input?.code ?? '').includes('const r'),
	'literal newline inside a code string parses and round-trips',
);

const multi = extractToolCalls(
	'{"tool_calls":[{"name":"a","input":{}},{"name":"b","input":{}}]}',
);
check(multi?.calls.length === 2, 'multiple tool_calls yield multiple calls');

const fenced = extractToolCalls(
	'Looking.\n```json\n{"tool_calls":[{"name":"s","input":{"q":"x"}}]}\n```\nDone.',
);
check(
	fenced?.calls.length === 1 && !fenced.residualText.includes('tool_calls'),
	'fenced JSON is excised from surrounding prose with no leak',
);

check(
	extractToolCalls('Duty cycle is 25% at 200 A (p. 7).') === null,
	'pure prose returns null (passes through untouched)',
);

// Regression: `lastIndexOf(x, -1)` clamps to 0 instead of returning -1, so
// scanning backwards from index 0 looped forever and wedged the request.
group('shim: unbalanced payloads terminate and never leak');
const UNBALANCED = [
	'{"tool_calls":[{"name":"x","input":{"code":"fn(){ return 1;',
	'{"tool_calls"',
	'"tool_calls" mentioned with no object',
	'prose {"a":{"tool_calls":[{"b":{',
];
const started = Date.now();
for (const payload of UNBALANCED) {
	extractToolCalls(payload);
	check(
		!stripUnparsedToolCallJson(payload).includes('tool_calls'),
		`stripped: ${payload.slice(0, 28)}`,
	);
}
check(Date.now() - started < 3000, 'all unbalanced shapes return promptly (no infinite loop)');
check(
	stripUnparsedToolCallJson('Duty cycle is 25% (p. 7).') === 'Duty cycle is 25% (p. 7).',
	'clean prose is preserved verbatim',
);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
