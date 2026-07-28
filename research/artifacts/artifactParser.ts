export interface Artifact {
	identifier: string;
	type: ArtifactMime;
	title?: string;
	language?: string;
	content: string;
	/** false while the closing tag has not arrived yet (streaming) */
	complete: boolean;
}

export type ArtifactMime =
	| 'application/vnd.ant.react'
	| 'application/vnd.ant.code'
	| 'application/vnd.ant.mermaid'
	| 'text/html'
	| 'text/markdown'
	| 'image/svg+xml'
	| 'text/plain'
	| 'application/json'
	| (string & {});

/** Renderable in the sandboxed iframe runtime. Everything else -> code view. */
export const RENDERABLE: ArtifactMime[] = [
	'application/vnd.ant.react',
	'text/html',
	'image/svg+xml',
];

const OPEN = /<antArtifact\s+([^>]*?)>/;
const CLOSE = '</antArtifact>';
const OPEN_TAG_NAME = '<antArtifact';

function parseAttrs(s: string): Record<string, string> {
	const o: Record<string, string> = {};
	for (const m of s.matchAll(/([\w-]+)\s*=\s*"([^"]*)"/g)) o[m[1]] = m[2];
	return o;
}

/**
 * Parse a (possibly incomplete) assistant stream buffer into prose + artifacts.
 * Safe to call on every token: a half-received `<antArtifa` tail is withheld
 * from `text` so the raw protocol never flashes in the chat transcript.
 */
export function parseStream(buf: string): { text: string; artifacts: Artifact[] } {
	const artifacts: Artifact[] = [];
	let text = '';
	let i = 0;

	while (i < buf.length) {
		const rest = buf.slice(i);
		const m = rest.match(OPEN);

		if (!m || m.index === undefined) {
			// No complete opening tag. Withhold a trailing partial one.
			const lt = rest.lastIndexOf('<');
			if (lt !== -1 && OPEN_TAG_NAME.startsWith(rest.slice(lt, lt + OPEN_TAG_NAME.length))) {
				text += rest.slice(0, lt);
			} else {
				text += rest;
			}
			break;
		}

		text += rest.slice(0, m.index);
		const a = parseAttrs(m[1]);
		const bodyStart = m.index + m[0].length;
		const end = rest.indexOf(CLOSE, bodyStart);
		const complete = end !== -1;
		const raw = complete ? rest.slice(bodyStart, end) : rest.slice(bodyStart);

		artifacts.push({
			identifier: a.identifier ?? `artifact-${artifacts.length}`,
			type: (a.type as ArtifactMime) ?? 'text/plain',
			title: a.title,
			language: a.language,
			content: raw.replace(/^\n/, ''),
			complete,
		});

		if (!complete) break;
		i += end + CLOSE.length;
	}

	return { text, artifacts };
}
