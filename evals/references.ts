export interface SourceRef {
	doc: string;
	page: number;
}

export interface GoldenReferences {
	page_refs: number[];
	source_refs?: SourceRef[];
}

export function hasReferences(references: GoldenReferences): boolean {
	return Boolean(references.source_refs?.length || references.page_refs?.length);
}

/**
 * Source-qualified references take precedence over legacy page-only references.
 * Page numbers repeat across the owner manual, quick-start guide, and selection
 * chart, so a document-qualified golden source must never match by page alone.
 */
export function matchesReference(
	candidate: SourceRef,
	references: GoldenReferences,
): boolean {
	if (references.source_refs?.length) {
		return references.source_refs.some(
		(reference) => reference.doc === candidate.doc && reference.page === candidate.page,
		);
	}
	return references.page_refs.includes(candidate.page);
}

export function referenceLabels(references: GoldenReferences): string[] {
	if (references.source_refs?.length) {
		return references.source_refs.map((reference) => `${reference.doc}#${reference.page}`);
	}
	return references.page_refs.map(String);
}
