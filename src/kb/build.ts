/**
 * Builds `kb/index.json` from the vision-extracted page markdown in `kb/extracted/`.
 *
 * This runs offline at authoring time. The resulting index is committed to the
 * repo so that a fresh clone needs only `npm install` + an Anthropic key — no
 * extraction step on the grader's machine.
 */

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parsePage } from './parse.js';
import type { Chunk, KnowledgeBase, PageMeta } from './types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const EXTRACTED = path.join(ROOT, 'kb', 'extracted');
const OUT = path.join(ROOT, 'kb', 'index.json');

export async function build(): Promise<KnowledgeBase> {
	const files = (await readdir(EXTRACTED))
		.filter((f) => f.endsWith('.md'))
		.sort();

	const chunks: Chunk[] = [];
	const pages: PageMeta[] = [];
	const skipped: string[] = [];

	for (const file of files) {
		const stem = file.replace(/\.md$/, '');
		const raw = await readFile(path.join(EXTRACTED, file), 'utf8');
		const parsed = parsePage(stem, raw);
		if (!parsed) {
			skipped.push(stem);
			continue;
		}
		pages.push(parsed.meta);
		chunks.push(...parsed.chunks);
	}

	pages.sort((a, b) => a.doc.localeCompare(b.doc) || a.page - b.page);

	const docPageCounts: Record<string, number> = {};
	for (const p of pages) {
		docPageCounts[p.doc] = Math.max(docPageCounts[p.doc] ?? 0, p.page);
	}

	const kb: KnowledgeBase = {
		builtAt: new Date().toISOString(),
		chunks,
		pages,
		docPageCounts,
	};

	await mkdir(path.dirname(OUT), { recursive: true });
	await writeFile(OUT, JSON.stringify(kb, null, 2), 'utf8');

	const byKind = chunks.reduce<Record<string, number>>((acc, c) => {
		acc[c.kind] = (acc[c.kind] ?? 0) + 1;
		return acc;
	}, {});

	console.log(`KB built -> ${path.relative(ROOT, OUT)}`);
	console.log(`  pages:  ${pages.length}`);
	console.log(`  chunks: ${chunks.length}`, byKind);
	console.log(`  figures: ${pages.reduce((n, p) => n + p.figureSlugs.length, 0)}`);
	if (skipped.length) console.warn(`  skipped (unparseable): ${skipped.join(', ')}`);

	return kb;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	build().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
