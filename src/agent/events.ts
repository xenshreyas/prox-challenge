/**
 * Event types emitted by the agent and forwarded to the browser over SSE.
 *
 * The frontend renders each of these differently, so they are modelled as a
 * discriminated union rather than shoved into free-text. In particular, figures
 * and artifacts are *structured side-channel events*: the model calls a tool,
 * and the tool emits a rich event to the UI while returning only a short
 * acknowledgement into the model's context. That split matters — it keeps
 * base64 image data and long artifact source out of the conversation history.
 */

export interface FigureEvent {
	type: 'figure';
	doc: string;
	page: number;
	slug: string | null;
	caption: string | null;
	description: string | null;
	/** URL the browser can load, served by the static page-image route. */
	imageUrl: string;
}

export type ArtifactKind = 'html' | 'react' | 'diagram';

export interface ArtifactEvent {
	type: 'artifact';
	id: string;
	title: string;
	kind: ArtifactKind;
	/** Rendering hint for the host; 'diagram' artifacts are still HTML/SVG. */
	mimeType: 'text/html' | 'application/vnd.ant.react' | 'image/svg+xml';
	code: string;
}

export interface CitationEvent {
	type: 'citation';
	doc: string;
	page: number;
	section: string;
}

export interface TokenEvent {
	type: 'token';
	text: string;
}

export interface ToolEvent {
	type: 'tool';
	name: string;
	input: unknown;
}

export interface ErrorEvent {
	type: 'error';
	message: string;
	/** True when the failure is a missing/invalid API key, so the UI can guide setup. */
	isConfigError?: boolean;
}

export interface DoneEvent {
	type: 'done';
	sessionId: string | null;
	costUsd?: number;
	durationMs?: number;
}

export type AgentEvent =
	| TokenEvent
	| ToolEvent
	| FigureEvent
	| ArtifactEvent
	| CitationEvent
	| ErrorEvent
	| DoneEvent;

/** Sink the tool layer uses to push side-channel events to the transport. */
export type EventSink = (event: AgentEvent) => void;
