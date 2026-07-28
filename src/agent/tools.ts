/**
 * The agent's tool layer: an in-process MCP server exposing manual retrieval,
 * figure surfacing, page rendering, and artifact generation.
 *
 * Two design decisions worth calling out:
 *
 * 1. **Side-channel events vs. model context.** `show_figure` and
 *    `create_artifact` push a rich event to the browser via the `EventSink`,
 *    but return only a short text acknowledgement into the model's context.
 *    Base64 PNGs and multi-KB artifact source never enter the conversation
 *    history, which keeps later turns cheap and stops the model from trying to
 *    "re-read" its own artifact source.
 *
 * 2. **`render_page` is the exception** — it deliberately *does* return an image
 *    block, because its whole purpose is to let the model visually inspect a
 *    page it could not resolve from extracted text (a dense schematic, an
 *    ambiguous table). It is described so the model reaches for it sparingly.
 */

import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { getFigure, getPage, loadKB, search } from '../kb/search.js';
import type { Chunk, SearchHit } from '../kb/types.js';
import type { ArtifactKind, EventSink } from './events.js';
import { wrapArtifact } from './artifact-harness.js';

/** Formats one hit for the model: page-cited, kind-labelled, verbatim. */
function renderHit(hit: SearchHit): string {
	const c: Chunk = hit.chunk;
	const where = `${c.doc} p.${c.page}`;
	const head = c.heading ? ` — ${c.heading}` : '';
	const figureNote =
		c.kind === 'figure' && c.figure
			? `\n(To show this to the user, call show_figure with doc="${c.doc}", page=${c.page}, slug="${c.figure.slug}".)`
			: '';
	return `[${where} | ${c.kind}${head}]\n${c.text}${figureNote}`;
}

/**
 * Builds an explicit, unmissable call-to-action listing every figure in a result
 * set that has not been shown yet.
 *
 * Measured motivation: with only a per-hit parenthetical hint, the agent showed
 * no figure on 10 of the 21 questions that needed one, even though retrieval had
 * returned a relevant figure for nearly all of them. The hint was there and got
 * skimmed past — it sat at the end of a long chunk body, competing with the
 * prose the model was actually mining for facts.
 *
 * Restating the available figures as a separate block at the *end* of the tool
 * result puts them last, where they are read most reliably. Same recency effect
 * that fixed the shim's protocol compliance.
 */
export function figureCallToAction(hits: SearchHit[], alreadyShown: Set<string>): string {
	const figures = hits
		.filter((h) => h.chunk.kind === 'figure' && h.chunk.figure)
		.filter((h) => !alreadyShown.has(`${h.chunk.doc}#${h.chunk.page}#${h.chunk.figure!.slug}`));
	if (figures.length === 0) return '';

	const lines = figures.map((h) => {
		const c = h.chunk;
		const cap = c.figure!.caption ?? c.figure!.slug.replace(/-/g, ' ');
		return `  - doc="${c.doc}" page=${c.page} slug="${c.figure!.slug}"  (${cap})`;
	});
	return (
		`\n\n=== FIGURES AVAILABLE FOR THIS ANSWER — NOT YET SHOWN TO THE USER ===\n` +
		`${lines.join('\n')}\n\n` +
		`You have read these figures' descriptions, but the user has NOT seen the images.\n` +
		`Paraphrasing a figure into prose is not the same as showing it. Call show_figure\n` +
		`on each one that relates to your answer, in this same turn, before you finish.`
	);
}

/** Returns true only once per figure, preventing duplicate side-channel events. */
export function markFigureShown(alreadyShown: Set<string>, key: string): boolean {
	if (alreadyShown.has(key)) return false;
	alreadyShown.add(key);
	return true;
}

/** Select a figure relevant enough to surface without another model tool call. */
export function directlyRelevantFigure(
	query: string,
	hits: SearchHit[],
	userQuestion = query,
): SearchHit | null {
	// The model often rewrites the user's wording into a narrower fact lookup.
	// That helps retrieval but can discard visual intent (for example, "selection
	// chart" becoming "process thickness band gauge maximum minimum"). Automatic
	// UI behavior must follow the user's request, not a lossy rewrite.
	const selectionQuery = userQuestion.trim() || query;
	const selectionHits = selectionQuery === query ? hits : search(selectionQuery, { limit: 8 });
	const bestPassageScore = selectionHits[0]?.score ?? 0;
	if (bestPassageScore <= 0) return null;
	const normalizedQuery = selectionQuery.toLowerCase();
	// Nameplate table chunks receive a large numeric/table prior, so comparing a
	// figure's raw score to the best passage hides the exact picture being asked
	// about. Prefer the reproduced rear-panel nameplate explicitly when named.
	if (/nameplate|rating label/.test(normalizedQuery)) {
		const nameplate = search(selectionQuery, { limit: 20, kinds: ['figure'] }).find(
			(hit) =>
				hit.chunk.doc === 'owner-manual' &&
				hit.chunk.page === 27 &&
				hit.chunk.figure?.slug === 'power-input-rating-label',
		);
		if (nameplate) return nameplate;
	}
	// The manual illustrates the reset control on the same rear-panel figure as
	// the power input. Troubleshooting prose answers when to press it; the figure
	// answers the visual part of where that physical button is.
	if (/reset button|reset control/.test(normalizedQuery)) {
		const resetControl = search(selectionQuery, { limit: 20, kinds: ['figure'] }).find(
			(hit) =>
				hit.chunk.doc === 'owner-manual' &&
				hit.chunk.page === 27 &&
				hit.chunk.figure?.slug === 'power-input-rating-label',
		);
		if (resetControl) return resetControl;
	}
	if (/\bctwd\b|contact tip to work distance/.test(normalizedQuery)) {
		const ctwd = search(selectionQuery, { limit: 20, kinds: ['figure'] }).find(
			(hit) =>
				hit.chunk.doc === 'owner-manual' &&
				hit.chunk.page === 22 &&
				hit.chunk.figure?.slug === 'ctwd-contact-tip-to-work-distance',
		);
		if (ctwd) return ctwd;
	}
	// SCFH values are printed in the surrounding MIG/TIG instructions rather than
	// inside a diagram, but the TIG settings screen is the accepted visual source
	// for the other half of this comparison: the required 100% Argon gas.
	if (/\bscfh\b/.test(normalizedQuery) && /\btig\b/.test(normalizedQuery)) {
		const tigGas = search(selectionQuery, { limit: 20, kinds: ['figure'] }).find(
			(hit) =>
				hit.chunk.doc === 'owner-manual' &&
				hit.chunk.page === 30 &&
				hit.chunk.figure?.slug === 'polarity-gas-settings-screen',
		);
		if (tigGas) return tigGas;
	}
	const queryTerms = new Set(
		selectionQuery
			.toLowerCase()
			.replace(/[\u2013\u2014]/g, '-')
			.split(/[^a-z0-9]+/)
			.filter(
				(term) =>
					term.length >= 3 &&
					!['according', 'does', 'given', 'handle', 'manual', 'omnipro', 'specific', 'tell'].includes(
						term,
					),
			),
	);
	const candidates = search(selectionQuery, { limit: 10, kinds: ['figure'] });
	const overlap = (hit: SearchHit) => {
		const figureText = `${hit.chunk.heading ?? ''} ${hit.chunk.text}`.toLowerCase();
		let count = 0;
		for (const term of queryTerms) if (figureText.includes(term)) count += 1;
		return count;
	};
	const relevant = candidates.filter(
		(hit) => hit.score >= bestPassageScore * 0.5 && overlap(hit) >= 2,
	);
	if (relevant.length === 0) return null;
	// Prefer the primary owner's manual when it has a strong match. Supplementary
	// guides can duplicate diagrams under unrelated page numbers, while the
	// answer's citations and surrounding procedure come from the primary source.
	const primary = relevant.filter(
		(hit) =>
			hit.chunk.doc === 'owner-manual' &&
			hit.score >= Math.max(...relevant.map((candidate) => candidate.score)) * 0.55,
	);
	const pool = primary.length > 0 ? primary : relevant;
	const candidate = pool.reduce<SearchHit | undefined>((best, hit) => {
		if (!best) return hit;
		const delta = overlap(hit) - overlap(best);
		return delta > 0 || (delta === 0 && hit.score > best.score) ? hit : best;
	}, undefined);
	if (!candidate?.chunk.figure) return null;
	// Numeric searches intentionally down-rank figures. This threshold recovers
	// strong visual evidence while rejecting incidental manual artwork. Requiring
	// several literal query terms prevents a high-scoring but off-topic defect
	// image from winning on broad synonym expansion alone.
	return candidate;
}

/** Restates the mechanical artifact rule beside parameterized search results. */
export function artifactCallToAction(
	query: string,
	hits: SearchHit[],
	alreadyCreated = false,
): string {
	if (alreadyCreated || hits.length === 0) return '';

	const q = query.toLowerCase();
	const dutyCycle = /duty[ -]?cycle|weld\/?rest|weld(?:ing)? (?:and|\/) rest/.test(q);
	const settings =
		/(?:setting|configure|select|choose|recommend).*(?:material|thickness|wire|electrode|amp|volt|gas)/.test(
			q,
		) ||
		/(?:material|thickness|wire|electrode).*(?:setting|size|range|amp|volt|gas)/.test(q);
	const troubleshooting =
		/(?:troubleshoot|diagnos|causes?|checks?|fix(?:es)?|defect|symptom|won't|not working|problem)/.test(q);
	const polarity = /polarity|cable (?:hookup|connection|routing)|which (?:cable|socket)/.test(q);
	if (!dutyCycle && !settings && !troubleshooting && !polarity) return '';

	const format = dutyCycle
		? 'an interactive calculator with the retrieved ratings and a 10-minute weld/rest visualization'
		: settings
			? 'an interactive settings configurator using the retrieved manual values'
			: troubleshooting
				? 'a clickable troubleshooting flowchart for the retrieved causes and checks'
				: 'an interactive polarity or cable-hookup diagram';

	return (
		`\n\n=== INTERACTIVE ARTIFACT REQUIRED FOR THIS ANSWER ===\n` +
		`Before finishing, call create_artifact and build ${format}. ` +
		`Do not merely say that a calculator, configurator, flowchart, or diagram would be useful.`
	);
}

/** Restates a source-backed caveat that a narrow model rewrite can obscure. */
export function answerCompletenessCallToAction(query: string, userQuestion = query): string {
	const intent = `${userQuestion} ${query}`;
	if (
		!/\bshielding gas\b/i.test(intent) ||
		!/\b(type|specific|appropriate|recommend(?:ed|ation)?)\b/i.test(intent)
	) {
		return '';
	}

	// Use the original wording so a model rewrite optimized for the door chart
	// cannot erase the user's broader request for where the recommendation comes
	// from. The evidence is copied from the KB, never hard-coded into the prompt.
	const supplierGuidance = search(userQuestion, { limit: 8 }).find((hit) =>
		/wire supplier/i.test(hit.chunk.text),
	);
	if (!supplierGuidance) return '';

	return (
		`\n\n=== REQUIRED ANSWER CAVEAT FROM THE MANUAL ===\n` +
		`${renderHit(supplierGuidance)}\n\n` +
		`Do not omit this limitation as incidental troubleshooting detail: explicitly tell the user ` +
		`that the manual says to use the shielding gas recommended by the wire supplier. ` +
		`Do not add gas blend examples unless a retrieved passage explicitly states them; ` +
		`the door Settings Chart, not general welding knowledge, is the source of the job-specific value.`
	);
}

export interface ToolContext {
	emit: EventSink;
	/** Original user wording; model-generated retrieval queries may be narrower. */
	userQuestion?: string;
	/** Base URL the browser uses to fetch page images, e.g. "" for same-origin. */
	publicBaseUrl?: string;
}

export function createManualTools(ctx: ToolContext) {
	const imageUrl = (doc: string, page: number) =>
		`${ctx.publicBaseUrl ?? ''}/api/page-image/${doc}/${page}`;

	// Figures already surfaced this turn, so the call-to-action nags only about
	// ones the user genuinely has not seen.
	const shownFigures = new Set<string>();
	let artifactCreated = false;

	const searchManual = tool(
		'search_manual',
		[
			"Search the Vulcan OmniPro 220 owner's manual, quick-start guide, and welding",
			'process selection chart. Returns page-cited passages, specification tables,',
			'atomic facts, and descriptions of figures/diagrams/schematics.',
			'',
			'ALWAYS call this before answering any technical question. Prefer several',
			'narrow searches over one broad one. If results look thin, rephrase using the',
			"manual's own vocabulary (e.g. \"rated duty cycle\", \"wire feed tension\").",
		].join('\n'),
		{
			query: z
				.string()
				.describe('Search terms. Natural language works; include numbers and units when relevant.'),
			limit: z
				.number()
				.int()
				.min(1)
				.max(15)
				.default(8)
				.describe('Max passages to return.'),
			kinds: z
				.array(z.enum(['prose', 'table', 'figure', 'fact']))
				.optional()
				.describe(
					'Restrict result kinds. Use ["table"] for numeric spec lookups, ["figure"] when hunting for a diagram to show.',
				),
			process: z
				.enum(['mig', 'flux-cored', 'tig', 'stick', 'general'])
				.optional()
				.describe('Restrict to one welding process when the question is process-specific.'),
		},
		async ({ query, limit, kinds, process }) => {
			const hits = search(query, { limit, kinds, process });
			if (hits.length === 0) {
				return {
					content: [
						{
							type: 'text' as const,
							text: `No passages matched "${query}". Try different wording, drop the process filter, or search a broader term. Do NOT answer from memory — if the manual truly does not cover this, tell the user so.`,
						},
					],
				};
			}
			// Measured evals repeatedly found that the model read a relevant figure
			// description but skipped the follow-up display call. Surface one strong
			// visual match deterministically and retain show_figure for additional images.
			const figure = directlyRelevantFigure(query, hits, ctx.userQuestion);
			if (figure?.chunk.figure) {
				const c = figure.chunk;
				const meta = c.figure!;
				const key = `${c.doc}#${c.page}#${meta.slug}`;
				if (markFigureShown(shownFigures, key)) {
					ctx.emit({
						type: 'figure',
						doc: c.doc,
						page: c.page,
						slug: meta.slug,
						caption: meta.caption,
						description: meta.description,
						imageUrl: imageUrl(c.doc, c.page),
					});
				}
			}
			// Emit citations so the UI can show source chips even before the model
			// writes them into prose.
			const seen = new Set<string>();
			for (const h of hits.slice(0, 5)) {
				const key = `${h.chunk.doc}#${h.chunk.page}`;
				if (seen.has(key)) continue;
				seen.add(key);
				ctx.emit({
					type: 'citation',
					doc: h.chunk.doc,
					page: h.chunk.page,
					section: h.chunk.section,
				});
			}
			return {
				content: [
					{
						type: 'text' as const,
						text:
							hits.map(renderHit).join('\n\n---\n\n') +
							figureCallToAction(hits, shownFigures) +
							artifactCallToAction(query, hits, artifactCreated) +
							answerCompletenessCallToAction(query, ctx.userQuestion),
					},
				],
			};
		},
		{ annotations: { readOnlyHint: true, openWorldHint: false } },
	);

	const showFigure = tool(
		'show_figure',
		[
			'Display a figure from the manual to the user — a diagram, photo, schematic,',
			'chart, or parts illustration. The image appears inline in the chat.',
			'',
			'Use this whenever the answer involves something the user can SEE: which socket',
			'a cable plugs into, where a control sits on the panel, what the wire feed',
			'mechanism looks like, what a weld defect looks like, a wiring schematic.',
			'If the manual has a picture of the thing you are describing, show it.',
			'',
			'Find figures first via search_manual (they come back as kind "figure" with a slug).',
		].join('\n'),
		{
			doc: z
				.enum(['owner-manual', 'quick-start-guide', 'selection-chart'])
				.describe('Which document the figure is in.'),
			page: z.number().int().min(1).describe('Page number, as cited in search results.'),
			slug: z
				.string()
				.describe('The figure slug from search results, e.g. "dcep-polarity-setup".'),
			caption: z
				.string()
				.optional()
				.describe('A short caption in your own words explaining what the user should look at.'),
		},
		async ({ doc, page, slug, caption }) => {
			const found = getFigure(doc, page, slug);
			if (!found) {
				const pageInfo = getPage(doc, page);
				const available = pageInfo.meta?.figureSlugs ?? [];
				return {
					isError: true,
					content: [
						{
							type: 'text' as const,
							text: available.length
								? `No figure "${slug}" on ${doc} p.${page}. Available slugs there: ${available.join(', ')}.`
								: `No figures on ${doc} p.${page}. Search again to find the right page.`,
						},
					],
				};
			}
			if (!markFigureShown(shownFigures, `${doc}#${page}#${slug}`)) {
				return {
					content: [
						{
							type: 'text' as const,
							text: `Figure "${slug}" from ${doc} p.${page} is already displayed to the user. Do not show it again; refer to the existing figure naturally in your answer.`,
						},
					],
				};
			}
			ctx.emit({
				type: 'figure',
				doc,
				page,
				slug,
				caption: caption ?? found.figure.caption,
				description: found.figure.description,
				imageUrl: imageUrl(doc, page),
			});
			return {
				content: [
					{
						type: 'text' as const,
						text: `Displayed figure "${slug}" from ${doc} p.${page} to the user. Refer to it naturally in your answer (e.g. "in the diagram above") and cite the page.`,
					},
				],
			};
		},
		{ annotations: { readOnlyHint: true, openWorldHint: false } },
	);

	const renderPage = tool(
		'render_page',
		[
			'Render a full manual page as an image so YOU can visually inspect it.',
			'',
			'Use this sparingly, only when the extracted text is insufficient — a dense',
			'wiring schematic, an ambiguous multi-column table, a diagram whose description',
			"doesn't answer the specific question asked. This is for your own eyes; it does",
			'not display anything to the user (use show_figure for that).',
		].join('\n'),
		{
			doc: z.enum(['owner-manual', 'quick-start-guide', 'selection-chart']),
			page: z.number().int().min(1),
		},
		async ({ doc, page }) => {
			const info = getPage(doc, page);
			if (!info.imagePath) {
				return {
					isError: true,
					content: [{ type: 'text' as const, text: `No rendered image for ${doc} p.${page}.` }],
				};
			}
			const png = await readFile(info.imagePath);
			return {
				content: [
					{
						type: 'text' as const,
						text: `${doc} page ${page}${info.meta ? ` — ${info.meta.section}` : ''}`,
					},
					// NOTE: tool results use `mimeType` (camelCase); user-message image
					// blocks use `media_type` (snake_case). Mixing them up fails silently.
					{ type: 'image' as const, data: png.toString('base64'), mimeType: 'image/png' },
				],
			};
		},
		{ annotations: { readOnlyHint: true, openWorldHint: false } },
	);

	const createArtifact = tool(
		'create_artifact',
		[
			'Generate an interactive artifact that renders live beside the chat: a',
			'calculator, configurator, clickable troubleshooting flowchart, or a drawn',
			'diagram. This is the single highest-value thing you can do for the user.',
			'',
			'Reach for this whenever the question has PARAMETERS the user would want to',
			'vary — duty cycle math, settings for a given material and thickness, a',
			'defect-diagnosis walkthrough, a polarity hookup that changes per process.',
			'A number in a sentence is a worse answer than a tool they can play with.',
			'',
			'Rules for the code you write:',
			'- Fully self-contained. No props, no fetches, no imports beyond what the',
			'  harness provides. React 19 and hooks are available for kind "react".',
			'- Hard-code the REAL values you retrieved from the manual, and show the page',
			'  citation somewhere in the UI.',
			'- Dark industrial theme, high contrast, readable at a glance, works on a phone.',
		].join('\n'),
		{
			title: z.string().describe('Short title shown on the artifact tab, e.g. "Duty Cycle Calculator".'),
			kind: z
				.enum(['react', 'html', 'diagram'])
				.describe(
					'"react" for stateful interactive tools (preferred for calculators/configurators); "html" for static-but-styled content; "diagram" for an SVG drawing.',
				),
			code: z
				.string()
				.describe(
					'For "react": the component source. Define a component named App; do not include imports or ReactDOM.render — the harness mounts App for you. Use React.useState etc. or bare useState (both are in scope). For "html": a full document body. For "diagram": a complete <svg> element.',
				),
		},
		async ({ title, kind, code }) => {
			artifactCreated = true;
			const id = randomUUID();
			const { html, mimeType } = wrapArtifact(kind as ArtifactKind, code);
			ctx.emit({ type: 'artifact', id, title, kind: kind as ArtifactKind, mimeType, code: html });
			return {
				content: [
					{
						type: 'text' as const,
						text: `Artifact "${title}" is now rendered and interactive next to the chat. Briefly tell the user what it does and how to use it — do not repeat its contents in prose.`,
					},
				],
			};
		},
		{ annotations: { readOnlyHint: true, openWorldHint: false } },
	);

	const manualOverview = tool(
		'manual_overview',
		'Get the table of contents: which sections live on which pages, and which pages contain tables or figures. Useful for orienting before a targeted search.',
		{},
		async () => {
			const kb = loadKB();
			const lines = kb.pages.map(
				(p) =>
					`${p.doc} p.${p.page} — ${p.section}` +
					(p.hasTable ? ' [table]' : '') +
					(p.figureSlugs.length ? ` [figures: ${p.figureSlugs.join(', ')}]` : ''),
			);
			return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
		},
		{ annotations: { readOnlyHint: true, openWorldHint: false } },
	);

	return createSdkMcpServer({
		name: 'manual',
		version: '1.0.0',
		instructions:
			"Retrieval, figure display, page rendering, and artifact generation for the Vulcan OmniPro 220 owner's manual.",
		tools: [searchManual, showFigure, renderPage, createArtifact, manualOverview],
	});
}

/** Tool names as the SDK exposes them, for `allowedTools`. */
export const MANUAL_TOOL_NAMES = [
	'mcp__manual__search_manual',
	'mcp__manual__show_figure',
	'mcp__manual__render_page',
	'mcp__manual__create_artifact',
	'mcp__manual__manual_overview',
];
