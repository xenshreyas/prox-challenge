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

import { classifyAgainstBest, includesFact, isBackendRefusal } from './run.js';
import { wrapArtifact } from '../src/agent/artifact-harness.js';
import { figureCallToAction } from '../src/agent/tools.js';
import { search } from '../src/kb/search.js';
import {
	buildPrompt,
	extractToolCalls,
	RESPONSE_CONTRACT_TAIL,
	salvageProse,
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

group('shim: prose salvage when the stripper over-consumes');
// Regression: q20 returned "(empty response)" — the model wrote prose alongside
// a malformed JSON fragment, the aggressive stripper ate the whole thing, and
// the user saw nothing. Losing a fragment is fine; losing the answer is not.
const mixed =
	'Unscrew the feed roller knob counterclockwise (p. 12).\n' +
	'{"tool_calls":[{"name":"x","input":{"code":"fn(){\n' +
	'The knurled groove is for flux-cored wire.';
const salvaged = salvageProse(mixed);
check(salvaged.includes('counterclockwise'), 'keeps leading prose');
check(salvaged.includes('knurled'), 'keeps trailing prose');
check(!salvaged.includes('tool_calls'), 'drops the JSON fragment');

check(
	salvageProse('● Web Search (MCP: github-mcp-server) · query\n  └ {"type":"output_text","text":{"value":"x"}}\nThe duty cycle is 25% (p. 7).')
		=== 'The duty cycle is 25% (p. 7).',
	"strips Copilot's own agent-trace lines",
);
check(
	salvageProse('Plain answer with no payload at all.') === 'Plain answer with no payload at all.',
	'clean prose untouched',
);

group('shim: protocol contract must be LAST in the prompt');
// Regression, and the highest-value invariant in this file. The SDK appends a
// host-injected "CONTEXT NOTE" (Claude Code agent roster + skill catalog) to the
// END of the conversation. When the response-format contract lived only near the
// top, that note was the last thing the model read, so it behaved like that
// agent harness and tried to genuinely EXECUTE mcp__manual__search_manual —
// producing zero tool calls and an apologetic non-answer.
//
// Measured on the captured q11 prompt: contract-at-top 3/5 compliant,
// contract-restated-last 6/6. Recency, not prompt length, was the trigger.
const promptWithContextNote = buildPrompt({
	model: 'claude-sonnet-4-5',
	max_tokens: 1024,
	system: 'You are the Vulcan OmniPro 220 expert assistant.',
	tools: [
		{
			name: 'mcp__manual__search_manual',
			description: 'Search the manual.',
			input_schema: { type: 'object', properties: { query: { type: 'string' } } },
		},
	],
	messages: [
		{ role: 'user', content: 'What polarity for flux-cored?' },
		// Stand-in for the SDK's trailing host-injected note.
		{ role: 'user', content: 'CONTEXT NOTE: available agent types include general-purpose...' },
	],
} as never);

const tailIndex = promptWithContextNote.lastIndexOf(RESPONSE_CONTRACT_TAIL.slice(0, 40));
const noteIndex = promptWithContextNote.lastIndexOf('CONTEXT NOTE');
check(tailIndex !== -1, 'contract tail is present in the prompt');
check(
	tailIndex > noteIndex,
	'contract tail appears AFTER the trailing host-injected context note',
);

group('eval: backend-refusal detection must not over-match');
// Real refusal text observed on q07/q26/q29 of the 40-question sweep.
const REFUSALS = [
	"I'm the GitHub Copilot CLI (powered by Claude Sonnet 5), a terminal coding assistant — not the Vulcan OmniPro 220 welding assistant described in that prompt.",
	"It looks like this conversation was set up for a different tool environment (a Vulcan OmniPro 220 manual assistant with specialized MCP tools) that isn't actually available in my current toolset.",
	"I'm unable to complete this request. The task describes a Vulcan OmniPro 220 welding-manual assistant with tools like search_manual, but none of those tools actually exist in this environment.",
];
// Real GOOD answers from the same sweep. These must NOT be flagged — a
// false positive would silently delete a genuine failure from the denominator
// and inflate the reported score.
const GOOD = [
	'At 200 A on 240 V MIG, the rated duty cycle is **25%** (p. 23, p. 25). In a 10-minute window that is 2 1/2 minutes welding and 7 1/2 minutes resting.',
	'At **175 A on 240 V, the TIG duty cycle is 30%** — 3 minutes welding, 7 minutes resting (p. 29, p. 7).',
	'Wire feed power cable goes into the **negative (–) socket**, and the ground clamp cable goes into the **positive (+) socket** — this is DCEN (p. 13).',
	"The manual doesn't specify a wire supplier, so I can't give you a part number for that (p. 7).",
];
for (const [i, t] of REFUSALS.entries()) check(isBackendRefusal(t), `flags refusal ${i + 1}`);
for (const [i, t] of GOOD.entries()) check(!isBackendRefusal(t), `does NOT flag good answer ${i + 1}`);

group('artifact harness: TypeScript-flavoured source must compile TS-first');
// Regression, found by rendering in a real browser rather than unit-testing the
// wrapper in isolation. `useState<number>(0)` is NOT a syntax error to Babel's
// react preset — it parses as a chain of comparisons — so the react attempt
// "succeeds", emits code referencing a bare identifier `number`, and the
// artifact dies at RENDER time with "number is not defined". Trying react first
// and breaking on success never reaches the TypeScript fallback for exactly the
// input that needs it. The harness now sniffs TS syntax and reorders.
const tsArtifact = wrapArtifact(
	'react',
	'function App() {\n  const [amps, setAmps] = useState<number>(200);\n  return <div>{amps}</div>;\n}',
);
const tsIdx = tsArtifact.html.indexOf("typescript");
const jsxIdx = tsArtifact.html.indexOf("artifact.jsx");
check(tsArtifact.html.includes('looksTypeScript'), 'harness ships the TS-detection branch');
check(tsIdx !== -1 && jsxIdx !== -1, 'both Babel presets are present');

group('tools: unshown figures get an explicit call-to-action');
// The agent showed no figure on 10 of 21 questions that needed one, even though
// retrieval returned a relevant figure for nearly all of them. The per-hit hint
// was buried at the end of a long chunk body and got skimmed past. This block
// restates them LAST, where they are read most reliably.
const figHits = search('What are the material thickness ranges each process covers?', {
	limit: 10,
});
const onlyFigs = figHits.filter((h) => h.chunk.kind === 'figure' && h.chunk.figure);
const cta = figureCallToAction(figHits, new Set());
check(onlyFigs.length > 0, 'retrieval returns figures for a thickness question');
check(cta.length > 0, 'a call-to-action is emitted when figures are unshown');
check(
	onlyFigs.every((h) => cta.includes(h.chunk.figure!.slug)),
	'every unshown figure is named with its slug',
);
check(
	cta.includes('selection-chart'),
	'surfaces the image-only selection chart (1 byte of text layer)',
);
// Must not nag about figures the user has already seen.
const allShown = new Set(
	onlyFigs.map((h) => `${h.chunk.doc}#${h.chunk.page}#${h.chunk.figure!.slug}`),
);
check(figureCallToAction(figHits, allShown) === '', 'suppressed once every figure is shown');
check(
	figureCallToAction(
		figHits.filter((h) => h.chunk.kind !== 'figure'),
		new Set(),
	) === '',
	'silent when the result set has no figures (adds no noise)',
);

group('eval: max-score verdict compares against previous runs');
// Regression: the harness appended the current run, selected the best run from
// that history (including current), then skipped comparison when the best was
// current. A genuine new best therefore produced no NEW BEST verdict at all.
const incumbent = {
	at: '2026-07-28T05:03:09.754Z',
	n: 40,
	total: 0.7617,
	ci95: 0.01,
};
const improved = {
	at: '2026-07-28T06:00:00.000Z',
	n: 40,
	total: 0.8017,
	ci95: 0.01,
};
const verdict = classifyAgainstBest(improved, [incumbent, improved]);
check(verdict.kind === 'new-best', 'current run can be classified as a genuine new best');
check(
	verdict.kind !== 'first' && verdict.best.at === incumbent.at,
	'comparison incumbent excludes the current run',
);
check(
	classifyAgainstBest(incumbent, [incumbent]).kind === 'first',
	'a first run has no fabricated comparison',
);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
