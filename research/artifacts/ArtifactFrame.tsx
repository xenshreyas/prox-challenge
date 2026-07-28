import { useEffect, useRef, useState, useCallback } from 'react';
import type { Artifact } from '../utils/artifactParser';

const RUNTIME_SRC = '/artifact-runtime.html';

export interface ConsoleEntry {
	level: string;
	args: unknown[];
}

interface Props {
	artifact: Artifact;
	/** Debounce ms for re-rendering while the artifact is still streaming. */
	streamDebounceMs?: number;
	onConsole?: (e: ConsoleEntry) => void;
	onError?: (e: { message: string; stack?: string }) => void;
	className?: string;
}

/**
 * Renders an artifact inside a same-origin-blocked sandboxed iframe.
 *
 * Security model:
 *  - sandbox="allow-scripts" WITHOUT allow-same-origin => the frame gets an
 *    opaque origin, so it cannot touch host cookies, localStorage or the DOM.
 *  - The runtime doc is served from /artifact-runtime.html and NEVER contains
 *    model output; code is delivered afterwards via postMessage. This means the
 *    model's text never lands in an HTML parsing context on our side.
 *  - Add CSP headers on /artifact-runtime.html (see docs) to pin the CDNs.
 */
export default function ArtifactFrame({
	artifact,
	streamDebounceMs = 400,
	onConsole,
	onError,
	className,
}: Props) {
	const ref = useRef<HTMLIFrameElement>(null);
	const [mounted, setMounted] = useState(false);
	const [height, setHeight] = useState(480);

	const send = useCallback((code: string) => {
		ref.current?.contentWindow?.postMessage(
			{
				source: 'host',
				type: 'render',
				identifier: artifact.identifier,
				mimeType: artifact.type,
				code,
			},
			'*', // opaque-origin frames can only be targeted with '*'
		);
	}, [artifact.identifier, artifact.type]);

	// Listen for messages from the frame.
	useEffect(() => {
		const onMsg = (e: MessageEvent) => {
			if (e.source !== ref.current?.contentWindow) return; // identity check
			const d = e.data;
			if (!d || d.source !== 'artifact') return;
			switch (d.type) {
				case 'mounted':
					setMounted(true);
					break;
				case 'resize':
					if (typeof d.height === 'number') setHeight(Math.min(Math.max(d.height, 120), 2000));
					break;
				case 'console':
					onConsole?.({ level: d.level, args: d.args });
					break;
				case 'error':
					onError?.({ message: d.message, stack: d.stack });
					break;
			}
		};
		window.addEventListener('message', onMsg);
		return () => window.removeEventListener('message', onMsg);
	}, [onConsole, onError]);

	// Push code once mounted; debounce while streaming so we don't compile
	// every token (and don't compile syntactically-incomplete code eagerly).
	useEffect(() => {
		if (!mounted) return;
		if (artifact.complete) {
			send(artifact.content);
			return;
		}
		const t = setTimeout(() => send(artifact.content), streamDebounceMs);
		return () => clearTimeout(t);
	}, [mounted, artifact.content, artifact.complete, send, streamDebounceMs]);

	// Remount the frame when identity changes so old state is fully discarded.
	const frameKey = artifact.identifier + ':' + artifact.type;

	return (
		<iframe
			key={frameKey}
			ref={ref}
			src={RUNTIME_SRC}
			title={artifact.title ?? artifact.identifier}
			sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"
			referrerPolicy="no-referrer"
			allow=""
			className={className}
			style={{ width: '100%', height, border: 0, display: 'block', background: '#fff' }}
		/>
	);
}
