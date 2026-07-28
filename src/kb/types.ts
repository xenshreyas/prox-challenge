/**
 * Shared knowledge-base types.
 *
 * The KB is a set of typed chunks derived from vision-extraction of every manual
 * page. Chunk granularity is deliberately mixed: prose sections give context,
 * tables answer numeric lookups verbatim, figures make image-only content
 * searchable, and facts give the retriever short high-precision targets.
 */

export type DocId = 'owner-manual' | 'quick-start-guide' | 'selection-chart';

export type ChunkKind = 'prose' | 'table' | 'figure' | 'fact';

export type WeldProcess = 'mig' | 'flux-cored' | 'tig' | 'stick' | 'general';

export interface PageMeta {
	page: number;
	doc: DocId;
	section: string;
	topics: string[];
	processes: WeldProcess[];
	hasTable: boolean;
	hasFigure: boolean;
	figureSlugs: string[];
	keyFacts: string[];
}

export interface FigureMeta {
	/** Stable slug, unique within a page, e.g. "dcep-polarity-setup". */
	slug: string;
	caption: string | null;
	type: string;
	description: string;
	/** Natural-language questions this figure answers; strong retrieval hooks. */
	answersQuestionsLike: string[];
}

export interface Chunk {
	id: string;
	kind: ChunkKind;
	doc: DocId;
	page: number;
	section: string;
	/** Heading or figure slug this chunk sits under, when applicable. */
	heading: string | null;
	/** The retrievable text body. For figures this is caption + description + seed questions. */
	text: string;
	topics: string[];
	processes: WeldProcess[];
	/** Present only on kind === 'figure'. */
	figure?: FigureMeta;
}

export interface KnowledgeBase {
	builtAt: string;
	chunks: Chunk[];
	pages: PageMeta[];
	/** doc -> total page count */
	docPageCounts: Record<string, number>;
}

/** A scored retrieval hit returned to the agent. */
export interface SearchHit {
	chunk: Chunk;
	score: number;
	/** Which query terms matched, for debuggability in eval traces. */
	matchedTerms: string[];
}
