/**
 * Retrieval-only evaluation: measures recall@k of the search engine against the
 * golden question set's `page_refs`.
 *
 * This runs with no model and no API key, in about a second. That makes it the
 * fast inner loop for tuning retrieval — if the right page never enters the
 * agent's context, no amount of prompt work will save the answer, so this is
 * the ceiling on end-to-end accuracy and worth optimising independently.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { search, loadKB, REPO_ROOT } from '../src/kb/search.js';
import {
	hasReferences,
	matchesReference,
	referenceLabels,
	type SourceRef,
} from './references.js';

interface GoldenQuestion {
	id: string;
	question: string;
	page_refs: number[];
	source_refs?: SourceRef[];
	requires_visual: boolean;
}

async function main() {
	const kb = loadKB();
	const raw = await readFile(path.join(REPO_ROOT, 'research', 'eval-questions.json'), 'utf8');
	const questions: GoldenQuestion[] = JSON.parse(raw);

	console.log(
		`KB: ${kb.pages.length} pages, ${kb.chunks.length} chunks ` +
			`(${kb.chunks.filter((c) => c.kind === 'figure').length} figures, ` +
			`${kb.chunks.filter((c) => c.kind === 'table').length} tables)\n`,
	);

	const ks = [1, 3, 5, 10];
	const hitsAt: Record<number, number> = Object.fromEntries(ks.map((k) => [k, 0]));
	const worst: { id: string; question: string; got: string[]; want: string[] }[] = [];
	let rrSum = 0;

	for (const q of questions) {
		if (!hasReferences(q)) continue;
		const results = search(q.question, { limit: Math.max(...ks) });
		for (const k of ks) {
			if (results.slice(0, k).some((result) => matchesReference(result.chunk, q))) hitsAt[k] += 1;
		}
		const firstHit = results.findIndex((result) => matchesReference(result.chunk, q));
		if (firstHit >= 0) rrSum += 1 / (firstHit + 1);
		if (!results.slice(0, 10).some((result) => matchesReference(result.chunk, q))) {
			worst.push({
				id: q.id,
				question: q.question,
				got: [...new Set(results.slice(0, 6).map((result) => `${result.chunk.doc}#${result.chunk.page}`))],
				want: referenceLabels(q),
			});
		}
	}

	const n = questions.filter(hasReferences).length;
	console.log(`Retrieval recall over ${n} golden questions:`);
	for (const k of ks) {
		console.log(`  recall@${String(k).padEnd(2)}  ${((hitsAt[k] / n) * 100).toFixed(1)}%`);
	}
	console.log(`  MRR        ${(rrSum / n).toFixed(4)}`);

	if (worst.length) {
		console.log(`\nMisses (${worst.length}) — right page not in top 10:`);
		for (const w of worst) {
			console.log(`  ${w.id}: ${w.question.slice(0, 92)}`);
			console.log(`      want sources ${w.want.join(',')}  got ${w.got.join(',')}`);
		}
	} else {
		console.log('\nNo misses at k=10.');
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
