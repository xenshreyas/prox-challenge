/**
 * Retrieval recall harness. Run: npx tsx src/kb/search.test.ts
 *
 * Measures recall@5 / recall@10 of search() against research/eval-questions.json,
 * where a hit is any returned chunk whose .page appears in the question's page_refs.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadKB, search, REPO_ROOT, getPage, getFigure } from './search.js';

interface EvalQ {
	id: string;
	question: string;
	must_include: string[];
	requires_visual: boolean;
	page_refs: number[];
}

const questions = JSON.parse(
	readFileSync(path.join(REPO_ROOT, 'research', 'eval-questions.json'), 'utf8'),
) as EvalQ[];

const t0 = Date.now();
const kb = loadKB();
const bootMs = Date.now() - t0;

interface Row {
	id: string;
	q: string;
	hit5: boolean;
	hit10: boolean;
	rank: number | null;
	refs: number[];
	got: number[];
}

const rows: Row[] = [];

for (const q of questions) {
	const refs = new Set(q.page_refs ?? []);
	if (refs.size === 0) {
		console.warn(`(skipping ${q.id}: no page_refs in golden set)`);
		continue;
	}
	const hits = search(q.question, { limit: 10 });
	const pages = hits.map((h) => h.chunk.page);
	let rank: number | null = null;
	pages.forEach((p, i) => {
		if (rank === null && refs.has(p)) rank = i + 1;
	});
	rows.push({
		id: q.id,
		q: q.question,
		hit5: rank !== null && rank <= 5,
		hit10: rank !== null,
		rank,
		refs: [...refs],
		got: pages,
	});
}

const n = rows.length;
const r5 = rows.filter((r) => r.hit5).length;
const r10 = rows.filter((r) => r.hit10).length;
const mrr = rows.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / n;

// Page-level coverage: fraction of each question's page_refs present in top-10.
const cov = rows.reduce((s, r) => {
	const got = new Set(r.got);
	return s + r.refs.filter((p) => got.has(p)).length / Math.max(1, r.refs.length);
}, 0) / n;

console.log(`KB: ${kb.chunks.length} chunks / ${kb.pages.length} pages, indexed in ${bootMs}ms`);
console.log(`Questions: ${n}`);
console.log(`recall@5  = ${(r5 / n * 100).toFixed(1)}%  (${r5}/${n})`);
console.log(`recall@10 = ${(r10 / n * 100).toFixed(1)}%  (${r10}/${n})`);
console.log(`MRR       = ${mrr.toFixed(3)}`);
console.log(`page_refs coverage@10 = ${(cov * 100).toFixed(1)}%`);

const bad = rows.filter((r) => !r.hit10).concat(rows.filter((r) => r.hit10 && !r.hit5));
if (bad.length) {
	console.log('\n--- worst performers ---');
	for (const r of bad) {
		console.log(
			`${r.id} rank=${r.rank ?? 'MISS'} refs=[${r.refs.join(',')}] got=[${r.got.join(',')}]\n    ${r.q.slice(0, 110)}`,
		);
	}
}

// Smoke-test the helpers.
const pg = getPage('owner-manual', 7);
console.log(`\ngetPage(owner-manual,7): ${pg.chunks.length} chunks, image=${pg.imagePath ? 'ok' : 'missing'}`);
const anyFig = kb.chunks.find((c) => c.figure);
if (anyFig?.figure) {
	const f = getFigure(anyFig.doc, anyFig.page, anyFig.figure.slug);
	console.log(`getFigure(${anyFig.doc},${anyFig.page},${anyFig.figure.slug}): ${f ? 'ok' : 'FAIL'}`);
}
