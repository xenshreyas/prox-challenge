/**
 * Parses one vision-extracted page markdown file into typed chunks.
 *
 * The extractor emits a predictable shape per page:
 *   - markdown prose and GitHub tables
 *   - zero or more `### FIGURE: <slug>` blocks with Caption/Type/Description/
 *     "Answers questions like" fields
 *   - a trailing ```yaml block carrying page metadata + atomic key_facts
 *
 * We deliberately hand-roll a tolerant parser rather than pulling a YAML dep:
 * the metadata block is a fixed, machine-generated subset (scalars, flow lists,
 * and block lists of quoted strings), and being tolerant of extractor drift
 * matters more here than general YAML conformance.
 */

import type {
	Chunk,
	DocId,
	FigureMeta,
	PageMeta,
	WeldProcess,
} from './types.js';

const VALID_PROCESSES: WeldProcess[] = [
	'mig',
	'flux-cored',
	'tig',
	'stick',
	'general',
];

export interface ParsedPage {
	meta: PageMeta;
	chunks: Chunk[];
}

/** Strips surrounding quotes and trims. */
function unquote(raw: string): string {
	const s = raw.trim();
	if (
		(s.startsWith('"') && s.endsWith('"') && s.length > 1) ||
		(s.startsWith("'") && s.endsWith("'") && s.length > 1)
	) {
		return s.slice(1, -1);
	}
	return s;
}

/** Parses a YAML flow list like `[a, b, c]`. */
function parseFlowList(raw: string): string[] {
	const inner = raw.trim().replace(/^\[/, '').replace(/\]$/, '');
	if (!inner.trim()) return [];
	return inner
		.split(',')
		.map((s) => unquote(s))
		.filter(Boolean);
}

/**
 * Minimal YAML reader for the extractor's trailing metadata block. Handles
 * `key: scalar`, `key: [flow, list]`, and `key:` followed by `  - item` lines.
 */
function parseMetaBlock(yaml: string): Record<string, string | string[]> {
	const out: Record<string, string | string[]> = {};
	const lines = yaml.split('\n');
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		i += 1;
		if (!line.trim() || line.trim().startsWith('#')) continue;
		const m = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
		if (!m) continue;
		const key = m[1];
		const rest = m[2].trim();
		if (rest.startsWith('[')) {
			out[key] = parseFlowList(rest);
			continue;
		}
		if (rest) {
			out[key] = unquote(rest);
			continue;
		}
		// Block list: consume following `- item` lines at deeper indentation.
		const items: string[] = [];
		while (i < lines.length) {
			const next = lines[i];
			if (!next.trim()) {
				i += 1;
				continue;
			}
			const item = /^\s+-\s+(.*)$/.exec(next);
			if (!item) break;
			items.push(unquote(item[1]));
			i += 1;
		}
		out[key] = items;
	}
	return out;
}

function asList(v: string | string[] | undefined): string[] {
	if (!v) return [];
	return Array.isArray(v) ? v : [v];
}

/**
 * Normalize a page `topics` entry to a canonical slug.
 *
 * The extracted page metadata is inconsistent about separators: page 16 emits
 * `duty-cycle`, page 19 emits `duty_cycle`, and other pages emit `duty cycle`.
 * Those are the same topic but tokenized differently, so metadata-field matching
 * silently missed. Collapse every separator to a single hyphen and lowercase.
 */
export function normalizeTopicSlug(raw: string): string {
	return raw
		.toLowerCase()
		.trim()
		.replace(/[\s_]+/g, '-')
		.replace(/[^a-z0-9%/-]+/g, '-')
		.replace(/-{2,}/g, '-')
		.replace(/^-+|-+$/g, '');
}

function normalizeProcesses(raw: string[]): WeldProcess[] {
	const seen = new Set<WeldProcess>();
	for (const r of raw) {
		const k = r.toLowerCase().trim().replace(/\s+/g, '-');
		const hit = VALID_PROCESSES.find((p) => p === k);
		if (hit) seen.add(hit);
		else if (k.includes('flux')) seen.add('flux-cored');
	}
	if (seen.size === 0) seen.add('general');
	return [...seen];
}

/** Splits figure blocks out of the body, returning figures and the remaining prose. */
function extractFigures(body: string): {
	figures: FigureMeta[];
	prose: string;
} {
	const figures: FigureMeta[] = [];
	const proseParts: string[] = [];
	// Split on the FIGURE heading, keeping the leading prose as part 0.
	const parts = body.split(/^###\s+FIGURE:\s*/m);
	proseParts.push(parts[0]);

	for (const part of parts.slice(1)) {
		const nl = part.indexOf('\n');
		const slug = (nl === -1 ? part : part.slice(0, nl)).trim();
		const rest = nl === -1 ? '' : part.slice(nl + 1);

		// A figure block ends at the next `###`/`##`/`#` heading or `---` rule.
		const endIdx = rest.search(/^(#{1,3}\s|---\s*$)/m);
		const blockRaw = endIdx === -1 ? rest : rest.slice(0, endIdx);
		if (endIdx !== -1) proseParts.push(rest.slice(endIdx));

		const field = (name: string): string => {
			const re = new RegExp(
				`^\\*\\*${name}:\\*\\*\\s*([\\s\\S]*?)(?=^\\*\\*[A-Z]|$)`,
				'm'
			);
			const mm = re.exec(blockRaw);
			return mm ? mm[1].trim() : '';
		};

		const captionRaw = field('Caption');
		const questionsRaw = field('Answers questions like');
		const answersQuestionsLike = questionsRaw
			.split('\n')
			.map((l) => l.replace(/^\s*[-*]\s*/, '').trim())
			.filter((l) => l.length > 0);

		figures.push({
			slug: slug || `figure-${figures.length + 1}`,
			caption:
				!captionRaw || /^none$/i.test(captionRaw) ? null : captionRaw,
			type: field('Type') || 'unknown',
			description: field('Description'),
			answersQuestionsLike,
		});
	}

	return { figures, prose: proseParts.join('\n') };
}

/** Splits prose into markdown tables and non-table prose sections. */
function splitTables(prose: string): { tables: string[]; text: string } {
	const tables: string[] = [];
	const kept: string[] = [];
	const lines = prose.split('\n');
	let i = 0;
	while (i < lines.length) {
		// A markdown table = a `|` row followed by a `|---|` separator row.
		const isRow = (s: string | undefined) => !!s && /^\s*\|.*\|\s*$/.test(s);
		const isSep = (s: string | undefined) =>
			!!s && /^\s*\|[\s:|-]+\|\s*$/.test(s);
		if (isRow(lines[i]) && isSep(lines[i + 1])) {
			const start = i;
			i += 2;
			while (i < lines.length && isRow(lines[i])) i += 1;
			tables.push(lines.slice(start, i).join('\n'));
			continue;
		}
		kept.push(lines[i]);
		i += 1;
	}
	return { tables, text: kept.join('\n') };
}

/**
 * Finds the nearest preceding structural label for context.
 *
 * Extracted pages use both markdown headings and standalone bold input-section
 * labels. The latter matter for adjacent tables such as the 240 V and 120 V
 * nameplate blocks: dropping them makes the tables indistinguishable to
 * retrieval even though their values differ. Other bold callouts (for example
 * "IMPORTANT!") are deliberately ignored because they are not table context.
 */
function nearestHeading(text: string, upto: number): string | null {
	const before = text.slice(0, upto);
	const labels = [...before.matchAll(/^(?:#{1,4}\s+(.+)|\s*\*\*(.+?)\*\*\s*)$/gm)].filter(
		(m) => m[1] !== undefined || /\bsection\b|\b(?:120|240)\s*vac?\b/i.test(m[2] ?? ''),
	);
	if (labels.length === 0) return null;
	const latest = labels[labels.length - 1];
	return (latest[1] ?? latest[2]).trim();
}

/** Breaks long prose into paragraph-grouped chunks of roughly `target` chars. */
function chunkProse(text: string, target = 1200): { heading: string | null; body: string }[] {
	const blocks = text
		.split(/\n{2,}/)
		.map((b) => b.trim())
		.filter((b) => b.length > 0);
	const out: { heading: string | null; body: string }[] = [];
	let buf: string[] = [];
	let bufHeading: string | null = null;
	let cursor = 0;

	for (const block of blocks) {
		const at = text.indexOf(block, cursor);
		cursor = at === -1 ? cursor : at + block.length;
		if (/^#{1,4}\s/.test(block)) {
			// Headings start a new chunk boundary.
			if (buf.join('\n\n').trim().length > 0) {
				out.push({ heading: bufHeading, body: buf.join('\n\n') });
				buf = [];
			}
			bufHeading = block.replace(/^#{1,4}\s+/, '').trim();
			continue;
		}
		if (bufHeading === null) bufHeading = nearestHeading(text, at === -1 ? 0 : at);
		buf.push(block);
		if (buf.join('\n\n').length >= target) {
			out.push({ heading: bufHeading, body: buf.join('\n\n') });
			buf = [];
		}
	}
	if (buf.join('\n\n').trim().length > 0) {
		out.push({ heading: bufHeading, body: buf.join('\n\n') });
	}
	return out;
}

/**
 * Parses one extracted page file.
 *
 * @param stem  file stem, e.g. "owner-manual-14"
 * @param raw   full markdown contents
 */
export function parsePage(stem: string, raw: string): ParsedPage | null {
	// Pull the trailing ```yaml metadata block.
	const yamlMatch = /```yaml\s*\n([\s\S]*?)```/g;
	let lastYaml: RegExpExecArray | null = null;
	let m: RegExpExecArray | null;
	while ((m = yamlMatch.exec(raw)) !== null) lastYaml = m;

	const body = lastYaml ? raw.slice(0, lastYaml.index) : raw;
	const metaRaw = lastYaml ? parseMetaBlock(lastYaml[1]) : {};

	const stemDoc = stem.replace(/-\d+$/, '') as DocId;
	const stemPage = Number.parseInt(stem.match(/-(\d+)$/)?.[1] ?? '0', 10);

	const doc = (typeof metaRaw.doc === 'string' ? metaRaw.doc : stemDoc) as DocId;
	const pageNum = Number.parseInt(String(metaRaw.page ?? stemPage), 10);
	const page = Number.isFinite(pageNum) && pageNum > 0 ? pageNum : stemPage;
	if (!page) return null;

	const section =
		(typeof metaRaw.section === 'string' && metaRaw.section) || 'Unknown';
	const topics = asList(metaRaw.topics).map(normalizeTopicSlug).filter(Boolean);
	const processes = normalizeProcesses(asList(metaRaw.processes));
	const keyFacts = asList(metaRaw.key_facts);

	const { figures, prose } = extractFigures(body);
	const { tables, text } = splitTables(prose);

	const meta: PageMeta = {
		page,
		doc,
		section,
		topics,
		processes,
		hasTable: tables.length > 0,
		hasFigure: figures.length > 0,
		figureSlugs: figures.map((f) => f.slug),
		keyFacts,
	};

	const chunks: Chunk[] = [];
	const base = { doc, page, section, topics, processes };
	const idFor = (kind: string, n: number) => `${doc}#p${page}:${kind}:${n}`;

	chunkProse(text).forEach((p, i) => {
		if (p.body.replace(/\s/g, '').length < 40) return;
		chunks.push({
			...base,
			id: idFor('prose', i),
			kind: 'prose',
			heading: p.heading,
			text: p.body,
		});
	});

	tables.forEach((t, i) => {
		chunks.push({
			...base,
			id: idFor('table', i),
			kind: 'table',
			heading: nearestHeading(prose, prose.indexOf(t)),
			text: t,
		});
	});

	figures.forEach((f, i) => {
		// Figure text folds caption, description and the seed questions together so
		// that a user's natural phrasing can match the figure directly.
		const parts = [
			f.caption ? `Caption: ${f.caption}` : null,
			`Figure type: ${f.type}`,
			f.description,
			f.answersQuestionsLike.length
				? `Answers questions like: ${f.answersQuestionsLike.join(' ')}`
				: null,
		].filter(Boolean);
		chunks.push({
			...base,
			id: idFor('figure', i),
			kind: 'figure',
			heading: f.slug,
			text: parts.join('\n'),
			figure: f,
		});
	});

	keyFacts.forEach((fact, i) => {
		if (fact.replace(/\s/g, '').length < 10) return;
		chunks.push({
			...base,
			id: idFor('fact', i),
			kind: 'fact',
			heading: null,
			text: fact,
		});
	});

	return { meta, chunks };
}
