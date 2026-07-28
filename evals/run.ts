/**
 * Evaluation harness.
 *
 * Scores the agent against the 40 page-grounded golden questions in
 * `research/eval-questions.json`. Four sub-scores, deliberately separated
 * because the challenge weights them differently and averaging them into one
 * number would hide exactly the regressions we care about:
 *
 *   accuracy    — did the required facts appear, and did it cite the right pages?
 *   multimodal  — did it show a figure when the question needed one?
 *   artifact    — did it build an interactive tool when the question warranted one?
 *   grounding   — did it cite at all, and did it avoid unsupported numbers?
 *
 * Results are appended to `evals/history.jsonl` so `max_score(current, best)`
 * can be evaluated across runs rather than trusting a single noisy sample.
 */

import { appendFile, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import 'dotenv/config';

import { ask } from '../src/agent/agent.js';
import { REPO_ROOT } from '../src/kb/search.js';
import type { AgentEvent } from '../src/agent/events.js';

interface GoldenQuestion {
	id: string;
	question: string;
	expected_answer: string;
	must_include: string[];
	requires_visual: boolean;
	requires_artifact: boolean;
	page_refs: number[];
}

interface QuestionResult {
	id: string;
	question: string;
	answer: string;
	figures: { doc: string; page: number; slug: string | null }[];
	artifacts: { title: string; kind: string }[];
	citedPages: number[];
	toolCalls: string[];
	scores: {
		accuracy: number;
		multimodal: number;
		artifact: number;
		grounding: number;
		total: number;
	};
	missing: string[];
	durationMs: number;
	error?: string;
}

/** Normalizes for tolerant substring matching: "2-1/2" vs "2 1/2", "200A" vs "200 A". */
function norm(s: string): string {
	return s
		.toLowerCase()
		.replace(/[\u2013\u2014]/g, '-')
		// Unicode vulgar fractions -> ASCII. Models write "2½ minutes" while the
		// golden set says "2-1/2"; without this the grader marks a correct answer
		// wrong. The leading `-` keeps "2½" normalizing to "2-1/2", not "21/2".
		.replace(/\u00bd/g, '-1/2')
		.replace(/\u00bc/g, '-1/4')
		.replace(/\u00be/g, '-3/4')
		.replace(/\u2153/g, '-1/3')
		.replace(/\u2154/g, '-2/3')
		.replace(/\s*-\s*/g, '-')
		.replace(/(\d)\s+([a-z])/g, '$1$2')
		.replace(/[^a-z0-9%./-]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function includesFact(haystack: string, needle: string): boolean {
	const h = norm(haystack);
	const n = norm(needle);
	if (h.includes(n)) return true;
	// Spaceless compare so "2-1/2 minutes" matches "2 1/2minutes".
	if (h.replace(/ /g, '').includes(n.replace(/ /g, ''))) return true;
	// Last resort: strip separators entirely, so "2-1/2" matches "21/2" and
	// "2 1/2". Only applied to needles with a digit, to avoid false positives on
	// short prose fragments.
	if (/\d/.test(n)) {
		const squash = (x: string) => x.replace(/[\s-]/g, '');
		return squash(h).includes(squash(n));
	}
	return false;
}

function scoreOne(q: GoldenQuestion, r: Omit<QuestionResult, 'scores' | 'missing'>) {
	const missing = q.must_include.filter((f) => !includesFact(r.answer, f));
	const accuracy =
		q.must_include.length === 0
			? 1
			: (q.must_include.length - missing.length) / q.must_include.length;

	// Multimodal credit requires the figure to be on a page the question is
	// actually grounded in — showing *a* picture isn't the same as showing the
	// right one.
	const relevantFigure = r.figures.some(
		(f) => q.page_refs.length === 0 || q.page_refs.includes(f.page),
	);
	const multimodal = q.requires_visual ? (relevantFigure ? 1 : 0) : r.figures.length ? 1 : 0.5;

	const artifact = q.requires_artifact ? (r.artifacts.length ? 1 : 0) : r.artifacts.length ? 1 : 0.5;

	const citedRight = r.citedPages.some((p) => q.page_refs.includes(p));
	const grounding = r.citedPages.length === 0 ? 0 : citedRight ? 1 : 0.4;

	// Accuracy and grounding dominate: a beautiful artifact containing a wrong
	// duty cycle is worse than useless on a machine that draws 240 V.
	const total = accuracy * 0.45 + grounding * 0.2 + multimodal * 0.2 + artifact * 0.15;
	return { scores: { accuracy, multimodal, artifact, grounding, total }, missing };
}

async function runQuestion(q: GoldenQuestion): Promise<QuestionResult> {
	const started = Date.now();
	let answer = '';
	const figures: QuestionResult['figures'] = [];
	const artifacts: QuestionResult['artifacts'] = [];
	const citedPages = new Set<number>();
	const toolCalls: string[] = [];
	let error: string | undefined;

	for await (const ev of ask({ question: q.question }) as AsyncGenerator<AgentEvent>) {
		switch (ev.type) {
			case 'token':
				answer += ev.text;
				break;
			case 'figure':
				figures.push({ doc: ev.doc, page: ev.page, slug: ev.slug });
				citedPages.add(ev.page);
				break;
			case 'artifact':
				artifacts.push({ title: ev.title, kind: ev.kind });
				break;
			case 'citation':
				citedPages.add(ev.page);
				break;
			case 'tool':
				toolCalls.push(ev.name);
				break;
			case 'error':
				error = ev.message;
				break;
			default:
				break;
		}
	}

	// Also honour inline "(p. 19)" citations the model writes into prose.
	for (const m of answer.matchAll(/\bp\.?\s*(\d{1,2})\b/gi)) {
		citedPages.add(Number(m[1]));
	}

	const partial = {
		id: q.id,
		question: q.question,
		answer,
		figures,
		artifacts,
		citedPages: [...citedPages].sort((a, b) => a - b),
		toolCalls,
		durationMs: Date.now() - started,
		error,
	};
	return { ...partial, ...scoreOne(q, partial) };
}

async function main() {
	const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
	const limitArg = process.argv.find((a) => a.startsWith('--limit='));
	const limit = limitArg ? Number(limitArg.split('=')[1]) : Infinity;

	const raw = await readFile(path.join(REPO_ROOT, 'research', 'eval-questions.json'), 'utf8');
	let questions: GoldenQuestion[] = JSON.parse(raw);
	if (only.length) questions = questions.filter((q) => only.includes(q.id));
	questions = questions.slice(0, limit);

	console.log(`Running ${questions.length} golden questions...\n`);
	const results: QuestionResult[] = [];

	// Sequential: each query spawns an SDK subprocess, so parallelism here is
	// RAM-bound and makes failures much harder to attribute.
	for (const q of questions) {
		const r = await runQuestion(q);
		results.push(r);
		const pct = (r.scores.total * 100).toFixed(0);
		const flag = r.error ? ' ERROR' : r.missing.length ? ` missing: ${r.missing.join(', ')}` : '';
		console.log(
			`  ${r.id}  ${pct.padStart(3)}%  ` +
				`acc ${(r.scores.accuracy * 100).toFixed(0)}%  ` +
				`fig ${r.figures.length}  art ${r.artifacts.length}  ` +
				`${(r.durationMs / 1000).toFixed(1)}s${flag}`,
		);
	}

	const avg = (f: (r: QuestionResult) => number) =>
		results.length ? results.reduce((s, r) => s + f(r), 0) / results.length : 0;

	const summary = {
		at: new Date().toISOString(),
		n: results.length,
		accuracy: avg((r) => r.scores.accuracy),
		multimodal: avg((r) => r.scores.multimodal),
		artifact: avg((r) => r.scores.artifact),
		grounding: avg((r) => r.scores.grounding),
		total: avg((r) => r.scores.total),
		errors: results.filter((r) => r.error).length,
	};

	console.log('\n─────────────────────────────────────');
	console.log(`  TOTAL       ${(summary.total * 100).toFixed(1)}%`);
	console.log(`  accuracy    ${(summary.accuracy * 100).toFixed(1)}%`);
	console.log(`  grounding   ${(summary.grounding * 100).toFixed(1)}%`);
	console.log(`  multimodal  ${(summary.multimodal * 100).toFixed(1)}%`);
	console.log(`  artifact    ${(summary.artifact * 100).toFixed(1)}%`);
	if (summary.errors) console.log(`  errors      ${summary.errors}`);
	console.log('─────────────────────────────────────\n');

	const evalDir = path.join(REPO_ROOT, 'evals');
	await mkdir(evalDir, { recursive: true });
	await writeFile(
		path.join(evalDir, 'last-run.json'),
		JSON.stringify({ summary, results }, null, 2),
		'utf8',
	);
	await appendFile(path.join(evalDir, 'history.jsonl'), JSON.stringify(summary) + '\n', 'utf8');

	// Report against the incumbent so a regression is impossible to miss.
	try {
		const hist = (await readFile(path.join(evalDir, 'history.jsonl'), 'utf8'))
			.trim()
			.split('\n')
			.map((l) => JSON.parse(l) as typeof summary)
			.filter((h) => h.n === summary.n);
		const best = hist.reduce((a, b) => (b.total > a.total ? b : a), hist[0]);
		if (best && best.at !== summary.at) {
			const delta = (summary.total - best.total) * 100;
			console.log(
				delta >= 0
					? `  NEW BEST (+${delta.toFixed(1)} pts over ${best.at})`
					: `  REGRESSION (${delta.toFixed(1)} pts vs best ${(best.total * 100).toFixed(1)}% at ${best.at}) — keep the previous approach`,
			);
		}
	} catch {
		/* first run */
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
