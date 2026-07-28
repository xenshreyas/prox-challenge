/**
 * Offline hybrid retrieval over the OmniPro 220 knowledge base.
 *
 * Pure TypeScript, zero dependencies, zero network. The index is built once,
 * lazily, on first use (a few milliseconds for ~1k chunks) so the server can
 * boot instantly and still answer the first request with full recall.
 *
 * Scoring = BM25 over tokenized chunk text, then a stack of domain-aware
 * re-rankers:
 *   - welding synonym / alias expansion (DCEP <-> reverse polarity, MIG <-> GMAW, ...)
 *   - exact numeric-token boosting ("200a", "240v", "25%")
 *   - chunk-kind priors conditioned on the shape of the question
 *   - weld-process filtering inferred from the query
 *   - per-page diversity so a single page cannot monopolize the result set
 */

import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
	Chunk,
	DocId,
	FigureMeta,
	KnowledgeBase,
	PageMeta,
	SearchHit,
	WeldProcess,
} from './types.js';

/* ------------------------------------------------------------------ paths */

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Walk up from src/kb (or dist/src/kb) until we find the repo root. */
function findRepoRoot(): string {
	let dir = HERE;
	for (let i = 0; i < 6; i += 1) {
		if (existsSync(path.join(dir, 'kb', 'index.json'))) return dir;
		if (existsSync(path.join(dir, 'package.json')) && existsSync(path.join(dir, 'kb'))) return dir;
		dir = path.dirname(dir);
	}
	return process.cwd();
}

export const REPO_ROOT = findRepoRoot();
export const KB_INDEX_PATH = path.join(REPO_ROOT, 'kb', 'index.json');
export const KB_PAGES_DIR = path.join(REPO_ROOT, 'kb', 'pages');

/* ------------------------------------------------------------ tokenization */

const STOPWORDS = new Set([
	'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'do', 'does', 'doing',
	'for', 'from', 'get', 'give', 'gives', 'had', 'has', 'have', 'how', 'i', 'if', 'in', 'into',
	'is', 'it', 'its', 'me', 'my', 'of', 'on', 'or', 'should', 'so', 'that', 'the', 'their',
	'them', 'then', 'there', 'these', 'they', 'this', 'to', 'was', 'were', 'what', 'when',
	'where', 'which', 'while', 'will', 'with', 'you', 'your', 'about', 'am',
]);

/** Words that must never be dropped even though they look stop-ish. */
const KEEP = new Set(['a', 'v', 'no', 'not', 'off', 'on']);

function stem(word: string): string {
	if (word.length <= 3) return word;
	if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`;
	if (word.endsWith('sses')) return word.slice(0, -2);
	if (word.endsWith('ses') && word.length > 4) return word.slice(0, -2);
	if (word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us')) return word.slice(0, -1);
	if (word.endsWith('ing') && word.length > 5) return word.slice(0, -3);
	if (word.endsWith('ed') && word.length > 4) return word.slice(0, -2);
	return word;
}

const UNIT_ALIASES: Record<string, string> = {
	a: 'a', amp: 'a', amps: 'a', ampere: 'a', amperes: 'a',
	v: 'v', volt: 'v', volts: 'v', vac: 'v', vdc: 'v',
	mm: 'mm', in: 'in', inch: 'in', inches: 'in',
	hz: 'hz', kg: 'kg', lb: 'lb', lbs: 'lb', ipm: 'ipm',
	cfh: 'cfh', psi: 'psi', mpa: 'mpa', kva: 'kva', kw: 'kw',
	min: 'min', minute: 'min', minutes: 'min', sec: 's', second: 's', seconds: 's',
};

/**
 * Tokenize into stemmed word tokens plus normalized numeric tokens.
 *
 * "200 A", "200A" and "200 amps" all yield the token `#200a`; a bare "200"
 * yields `#200`. Fractions like "2-1/2" are preserved verbatim as `#2-1/2`.
 */
export function tokenize(input: string): string[] {
	const text = input.toLowerCase().replace(/[\u2013\u2014]/g, '-');
	const out: string[] = [];

	// Numeric tokens first (with optional attached/adjacent unit).
	const numRe = /(\d+(?:-\d+\/\d+|\.\d+|\/\d+)?)\s*(%|[a-z]{1,4})?/g;
	let m: RegExpExecArray | null;
	while ((m = numRe.exec(text)) !== null) {
		const num = m[1];
		out.push(`#${num}`);
		const rawUnit = m[2];
		if (rawUnit === '%') {
			out.push(`#${num}%`);
		} else if (rawUnit) {
			const u = UNIT_ALIASES[rawUnit];
			if (u) out.push(`#${num}${u}`);
		}
	}

	for (const raw of text.split(/[^a-z0-9%\/'".-]+/)) {
		const w = raw.replace(/^[-.'"]+|[-.'"]+$/g, '');
		if (!w) continue;
		if (/\d/.test(w)) continue; // handled above
		if (w.includes('-')) {
			for (const part of w.split('-')) {
				if (part.length > 1 && !STOPWORDS.has(part)) out.push(stem(part));
			}
			out.push(stem(w.replace(/-/g, '')));
			continue;
		}
		if (STOPWORDS.has(w) && !KEEP.has(w)) continue;
		if (w.length < 2 && !KEEP.has(w)) continue;
		out.push(stem(w));
	}
	return out;
}

/* -------------------------------------------------------------- synonyms */

/**
 * Bidirectional alias groups. Every member of a group expands to every other
 * member at reduced weight, so "reverse polarity" retrieves DCEP chunks.
 */
const SYNONYM_GROUPS: string[][] = [
	['dcep', 'reverse polarity', 'electrode positive', 'dc electrode positive', 'reversed polarity'],
	['dcen', 'straight polarity', 'electrode negative', 'dc electrode negative'],
	['polarity', 'lead', 'terminal', 'positive', 'negative'],
	['mig', 'gmaw', 'metal inert gas', 'solid wire', 'gas metal arc'],
	['flux cored', 'fcaw', 'gasless', 'flux core', 'fluxcore', 'no gas', 'self shielded', 'innershield'],
	['tig', 'gtaw', 'tungsten', 'tungsten inert gas', 'gas tungsten arc'],
	['stick', 'smaw', 'arc welding', 'electrode', 'shielded metal arc', 'rod'],
	['duty cycle', 'duty', 'rated output', 'overheat', 'thermal overload', 'ten minute'],
	['porosity', 'pores', 'holes in weld', 'gas pocket', 'pinholes'],
	['undercut', 'groove at toe', 'edge melted away'],
	['spatter', 'splatter', 'sparks', 'balls of metal'],
	['burn through', 'burnthrough', 'blowing through', 'melting through', 'hole in metal'],
	['wire feed', 'wire speed', 'ipm', 'wfs', 'feed rate', 'inches per minute', 'wire feed speed'],
	['tension', 'drive roll', 'drive roller', 'feed roll', 'pressure', 'birdnest', 'bird nest'],
	['contact tip', 'tip', 'nozzle', 'diffuser', 'consumable', 'gun'],
	['ground clamp', 'work clamp', 'work lead', 'earth clamp', 'ground cable', 'work cable'],
	['amperage', 'amps', 'current', 'output current', 'ampere'],
	['voltage', 'volts', 'volt', 'arc voltage'],
	['shielding gas', 'gas', 'c25', 'argon', 'co2', 'carbon dioxide', 'regulator', 'flow rate', 'cfh'],
	['thickness', 'gauge', 'ga', 'material thickness', 'sheet'],
	['setting', 'settings', 'chart', 'parameter', 'recommended'],
	['socket', 'connector', 'receptacle', 'port', 'plug', 'panel', 'terminal'],
	['spool gun', 'spoolgun', 'aluminum', 'aluminium', '4043', '5356'],
	['circuit breaker', 'breaker', 'fuse', 'branch circuit', 'plug', 'adapter', 'receptacle'],
	['error', 'fault', 'code', 'troubleshoot', 'troubleshooting', 'problem', 'symptom'],
	['nameplate', 'rating plate', 'name plate', 'data plate', 'rating label', 'specification', 'specifications', 'spec', 'rated'],
	['open circuit voltage', 'ocv', 'no load voltage', 'maximum voltage', 'max ocv'],
	['selection chart', 'selection', 'process selection', 'chart'],
	['maintenance', 'clean', 'cleaning', 'inspect', 'inspection', 'service'],
	['safety', 'warning', 'caution', 'hazard', 'danger', 'ppe'],
	['helmet', 'shade', 'lens', 'auto darkening', 'eye protection'],
];

/** term -> set of expansion terms (already tokenized). */
const SYNONYM_INDEX: Map<string, Set<string>> = (() => {
	const idx = new Map<string, Set<string>>();
	for (const group of SYNONYM_GROUPS) {
		const groupTokens = new Set<string>();
		for (const phrase of group) for (const t of tokenize(phrase)) groupTokens.add(t);
		for (const phrase of group) {
			const own = new Set(tokenize(phrase));
			for (const t of own) {
				let set = idx.get(t);
				if (!set) { set = new Set(); idx.set(t, set); }
				for (const g of groupTokens) if (!own.has(g)) set.add(g);
			}
		}
	}
	return idx;
})();

/* --------------------------------------------------------------- process */

const PROCESS_CUES: Record<Exclude<WeldProcess, 'general'>, RegExp> = {
	mig: /\b(mig|gmaw|solid wire|metal inert gas|spool gun|spoolgun)\b/i,
	'flux-cored': /\b(flux[- ]?core[d]?|fcaw|gasless|self[- ]?shield)/i,
	tig: /\b(tig|gtaw|tungsten|lift arc|lift[- ]?start)\b/i,
	stick: /\b(stick|smaw|electrode holder|7018|6011|6013|stinger)\b/i,
};

export function detectProcesses(query: string): WeldProcess[] {
	const found: WeldProcess[] = [];
	for (const [proc, re] of Object.entries(PROCESS_CUES) as [WeldProcess, RegExp][]) {
		if (re.test(query)) found.push(proc);
	}
	return found;
}

/* ------------------------------------------------------------ query shape */

const VISUAL_RE = /\b(show|diagram|figure|picture|image|photo|illustrat|which socket|where is|point to|look like|label|callout|panel|see)\b/i;
const NUMERIC_RE = /\b(how (many|much|long|thick)|what (amp|voltage|current|setting|speed|rate|size|thickness)|rating|rated|range|spec|specification|duty cycle|chart|table|setting|amp|volt|ipm|cfh|\d)\b/i;
const FACTUAL_RE = /\b(what is|what's|which|does|is the|are the|can i|do i|how do i|when should|why)\b/i;
const PROCEDURE_RE = /\b(how do i|how to|steps?|procedure|install|replace|change|set up|setup|adjust|thread|load|assembl)\b/i;

interface QueryShape {
	visual: boolean;
	numeric: boolean;
	factual: boolean;
	procedural: boolean;
	processes: WeldProcess[];
	terms: string[];
	/** expansion terms (lower weight) */
	expansions: string[];
	numericTerms: string[];
}

function analyzeQuery(query: string): QueryShape {
	const terms = tokenize(query);
	const own = new Set(terms);
	const expansions = new Set<string>();
	for (const t of terms) {
		const syn = SYNONYM_INDEX.get(t);
		if (syn) for (const s of syn) if (!own.has(s)) expansions.add(s);
	}
	return {
		visual: VISUAL_RE.test(query),
		numeric: NUMERIC_RE.test(query),
		factual: FACTUAL_RE.test(query),
		procedural: PROCEDURE_RE.test(query),
		processes: detectProcesses(query),
		terms,
		expansions: [...expansions],
		numericTerms: terms.filter((t) => t.startsWith('#')),
	};
}

/* ---------------------------------------------------------------- indexing */

interface IndexedChunk {
	chunk: Chunk;
	tf: Map<string, number>;
	len: number;
	/** tokens from heading/section/topics/figure hooks — higher precision */
	fieldTf: Map<string, number>;
}

interface KBIndex {
	kb: KnowledgeBase;
	docs: IndexedChunk[];
	df: Map<string, number>;
	avgLen: number;
	N: number;
	pageByKey: Map<string, PageMeta>;
	figureByKey: Map<string, FigureMeta>;
}

let CACHE: KBIndex | null = null;

function chunkFieldText(c: Chunk): string {
	const parts: string[] = [c.section ?? '', c.heading ?? '', (c.topics ?? []).join(' ')];
	if (c.figure) {
		parts.push(c.figure.caption ?? '', c.figure.type ?? '', c.figure.slug ?? '');
		parts.push(...(c.figure.answersQuestionsLike ?? []));
	}
	return parts.join(' ');
}

function buildIndex(kb: KnowledgeBase): KBIndex {
	const docs: IndexedChunk[] = [];
	const df = new Map<string, number>();
	let totalLen = 0;

	for (const chunk of kb.chunks) {
		const bodyTokens = tokenize(chunk.text ?? '');
		const fieldTokens = tokenize(chunkFieldText(chunk));
		const tf = new Map<string, number>();
		for (const t of bodyTokens) tf.set(t, (tf.get(t) ?? 0) + 1);
		const fieldTf = new Map<string, number>();
		for (const t of fieldTokens) fieldTf.set(t, (fieldTf.get(t) ?? 0) + 1);
		for (const t of new Set([...tf.keys(), ...fieldTf.keys()])) {
			df.set(t, (df.get(t) ?? 0) + 1);
		}
		const len = bodyTokens.length + fieldTokens.length;
		totalLen += len;
		docs.push({ chunk, tf, len, fieldTf });
	}

	const pageByKey = new Map<string, PageMeta>();
	for (const p of kb.pages ?? []) pageByKey.set(`${p.doc}#${p.page}`, p);

	const figureByKey = new Map<string, FigureMeta>();
	for (const c of kb.chunks) {
		if (c.figure) figureByKey.set(`${c.doc}#${c.page}#${c.figure.slug}`, c.figure);
	}

	return {
		kb,
		docs,
		df,
		avgLen: docs.length ? totalLen / docs.length : 1,
		N: docs.length,
		pageByKey,
		figureByKey,
	};
}

/** Load (and memoize) the knowledge base + retrieval index. */
export function loadKB(opts: { force?: boolean; indexPath?: string } = {}): KnowledgeBase {
	if (CACHE && !opts.force) return CACHE.kb;
	const p = opts.indexPath ?? KB_INDEX_PATH;
	const kb = JSON.parse(readFileSync(p, 'utf8')) as KnowledgeBase;
	CACHE = buildIndex(kb);
	return kb;
}

function getIndex(): KBIndex {
	if (!CACHE) loadKB();
	return CACHE!;
}

/** Drop the cached index (used by the KB build step / tests). */
export function invalidateKB(): void {
	CACHE = null;
}

/* ---------------------------------------------------------------- scoring */

const K1 = 1.4;
const B = 0.72;
const EXPANSION_WEIGHT = 0.45;
const FIELD_WEIGHT = 1.9;

function idf(df: number, N: number): number {
	return Math.log(1 + (N - df + 0.5) / (df + 0.5));
}

function bm25Term(
	term: string,
	weight: number,
	d: IndexedChunk,
	index: KBIndex,
	avgLen: number,
): number {
	const dfv = index.df.get(term);
	if (!dfv) return 0;
	const raw = (d.tf.get(term) ?? 0) + FIELD_WEIGHT * (d.fieldTf.get(term) ?? 0);
	if (raw === 0) return 0;
	const norm = (raw * (K1 + 1)) / (raw + K1 * (1 - B + (B * d.len) / avgLen));
	return weight * idf(dfv, index.N) * norm;
}

const KIND_BASE: Record<Chunk['kind'], number> = {
	table: 1.0,
	fact: 1.0,
	prose: 1.0,
	figure: 1.0,
};

function kindPrior(kind: Chunk['kind'], q: QueryShape): number {
	let mult = KIND_BASE[kind];
	if (q.numeric) {
		if (kind === 'table') mult *= 2.1;
		if (kind === 'fact') mult *= 1.1;
		if (kind === 'figure') mult *= 0.85;
	}
	if (q.visual) {
		if (kind === 'figure') mult *= 1.5;
		if (kind === 'table') mult *= 0.95;
	}
	if (q.factual && !q.numeric && !q.visual) {
		if (kind === 'fact') mult *= 1.2;
	}
	if (q.procedural) {
		if (kind === 'prose') mult *= 1.15;
		if (kind === 'figure') mult *= 1.05;
	}
	return mult;
}

export interface SearchOptions {
	limit?: number;
	/** Max hits allowed from any single page (diversity). Default 3. */
	perPageLimit?: number;
	doc?: DocId;
	page?: number;
	kinds?: Chunk['kind'][];
	process?: WeldProcess;
	/** Disable synonym expansion (debugging). */
	noExpand?: boolean;
}

export function search(query: string, opts: SearchOptions = {}): SearchHit[] {
	const index = getIndex();
	const limit = opts.limit ?? 10;
	const perPageLimit = opts.perPageLimit ?? Math.max(2, Math.ceil(limit / 4));
	const q = analyzeQuery(query);
	const wanted = opts.process ? [opts.process] : q.processes;

	type Scored = { d: IndexedChunk; score: number; matched: string[] };
	const scored: Scored[] = [];

	for (const d of index.docs) {
		const c = d.chunk;
		if (opts.doc && c.doc !== opts.doc) continue;
		if (opts.page !== undefined && c.page !== opts.page) continue;
		if (opts.kinds && !opts.kinds.includes(c.kind)) continue;

		let score = 0;
		const matched: string[] = [];

		for (const t of q.terms) {
			const s = bm25Term(t, 1, d, index, index.avgLen);
			if (s > 0) { score += s; matched.push(t); }
		}
		if (!opts.noExpand) {
			for (const t of q.expansions) {
				const s = bm25Term(t, EXPANSION_WEIGHT, d, index, index.avgLen);
				if (s > 0) { score += s; matched.push(t); }
			}
		}
		if (score <= 0) continue;

		// --- numeric exact-value boosting -----------------------------------
		if (q.numericTerms.length) {
			let unitHits = 0;
			let bareHits = 0;
			for (const nt of q.numericTerms) {
				const present = (d.tf.get(nt) ?? 0) + (d.fieldTf.get(nt) ?? 0) > 0;
				if (!present) continue;
				if (/[a-z%]$/.test(nt)) unitHits += 1; else bareHits += 1;
			}
			if (unitHits) score *= 1 + 0.55 * Math.min(unitHits, 4);
			if (bareHits) score *= 1 + 0.12 * Math.min(bareHits, 4);
		}

		// --- chunk-kind priors ----------------------------------------------
		score *= kindPrior(c.kind, q);

		// --- process filter / preference -------------------------------------
		if (wanted.length) {
			const procs = c.processes ?? [];
			const hit = procs.some((p) => wanted.includes(p));
			const general = procs.length === 0 || procs.includes('general');
			if (hit) score *= 1.45;
			else if (general) score *= 1.0;
			else score *= 0.45; // explicitly a different process
		}

		// --- figure hook boost for visual questions ---------------------------
		if (q.visual && c.figure) {
			const hooks = tokenize((c.figure.answersQuestionsLike ?? []).join(' '));
			const hookSet = new Set(hooks);
			const overlap = q.terms.filter((t) => hookSet.has(t)).length;
			if (overlap) score *= 1 + 0.12 * Math.min(overlap, 5);
		}

		// --- mild coverage bonus: fraction of distinct query terms matched ----
		const distinct = new Set(matched.filter((t) => q.terms.includes(t))).size;
		if (q.terms.length) score *= 1 + 0.35 * (distinct / q.terms.length);

		scored.push({ d, score, matched: [...new Set(matched)] });
	}

	scored.sort((a, b) => b.score - a.score);

	// --- per-page diversity -------------------------------------------------
	const perPage = new Map<string, number>();
	const primary: Scored[] = [];
	const overflow: Scored[] = [];
	for (const s of scored) {
		const key = `${s.d.chunk.doc}#${s.d.chunk.page}`;
		const n = perPage.get(key) ?? 0;
		if (n < perPageLimit) {
			perPage.set(key, n + 1);
			primary.push(s);
		} else {
			overflow.push(s);
		}
		if (primary.length >= limit * 3) break;
	}

	const final = [...primary, ...overflow].slice(0, limit);
	return final.map<SearchHit>((s) => ({
		chunk: s.d.chunk,
		score: Number(s.score.toFixed(4)),
		matchedTerms: s.matched.slice(0, 16),
	}));
}

/* ---------------------------------------------------------------- helpers */

export interface PageResult {
	meta: PageMeta | null;
	imagePath: string | null;
	chunks: Chunk[];
}

/** Page metadata + its chunks + the path to the 150 DPI raster. */
export function getPage(doc: DocId | string, page: number): PageResult {
	const index = getIndex();
	const meta = index.pageByKey.get(`${doc}#${page}`) ?? null;
	const chunks = index.kb.chunks.filter((c) => c.doc === doc && c.page === page);
	const file = path.join(KB_PAGES_DIR, `${doc}-${String(page).padStart(2, '0')}.png`);
	return { meta, imagePath: existsSync(file) ? file : null, chunks };
}

export interface FigureResult {
	figure: FigureMeta;
	chunk: Chunk;
	/** The page raster containing this figure (figures are not cropped out). */
	imagePath: string | null;
}

export function getFigure(doc: DocId | string, page: number, slug: string): FigureResult | null {
	const index = getIndex();
	const chunk = index.kb.chunks.find(
		(c) => c.doc === doc && c.page === page && c.figure?.slug === slug,
	);
	if (!chunk?.figure) return null;
	const file = path.join(KB_PAGES_DIR, `${doc}-${String(page).padStart(2, '0')}.png`);
	return { figure: chunk.figure, chunk, imagePath: existsSync(file) ? file : null };
}

/** All figures on a page (handy when the model asks "what's on page N"). */
export function listFigures(doc?: DocId | string): FigureResult[] {
	const index = getIndex();
	return index.kb.chunks
		.filter((c) => c.figure && (!doc || c.doc === doc))
		.map((c) => {
			const file = path.join(KB_PAGES_DIR, `${c.doc}-${String(c.page).padStart(2, '0')}.png`);
			return { figure: c.figure!, chunk: c, imagePath: existsSync(file) ? file : null };
		});
}
