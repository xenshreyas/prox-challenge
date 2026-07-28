import { readFileSync } from 'node:fs';
import path from 'node:path';
import { search, loadKB, REPO_ROOT } from '../src/kb/search.js';

loadKB();
const qs = JSON.parse(readFileSync(path.join(REPO_ROOT, 'research', 'eval-questions.json'), 'utf8')) as
	{ id: string; question: string; page_refs: number[] }[];

for (const q of qs) {
	if (!q.page_refs?.length) continue;
	const pages = search(q.question, { limit: 10 }).map((r) => r.chunk.page);
	const rank = pages.findIndex((p) => q.page_refs.includes(p));
	if (rank < 0 || rank >= 5) {
		console.log(`${q.id} rank=${rank < 0 ? 'MISS' : rank + 1} want=${q.page_refs.join(',')} got=${pages.join(',')}`);
		console.log(`   ${q.question.slice(0, 110)}`);
	}
}
