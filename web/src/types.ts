export type Role = 'user' | 'assistant';

export interface Figure {
  doc: string;
  page: number;
  slug: string;
  caption: string | null;
  imageUrl: string;
  description?: string;
}

export interface Artifact {
  id: string;
  title: string;
  /** e.g. text/html, application/vnd.react+jsx */
  mimeType: string;
  code: string;
}

export interface Citation {
  doc: string;
  page: number;
  section?: string;
}

export interface ToolCall {
  name: string;
  input: unknown;
  /** wall-clock ms when observed, used for ordering / relative timing */
  at: number;
}

export interface Message {
  id: string;
  role: Role;
  text: string;
  figures: Figure[];
  artifacts: Artifact[];
  citations: Citation[];
  tools: ToolCall[];
  /** streaming lifecycle */
  streaming: boolean;
  error?: string;
  createdAt: number;
}

/** Discriminated union of everything the /api/chat SSE stream can emit. */
export type StreamEvent =
  | { type: 'token'; text: string }
  | { type: 'tool'; name: string; input: unknown }
  | { type: 'figure'; figure: Figure }
  | { type: 'artifact'; artifact: Artifact }
  | { type: 'citation'; citation: Citation }
  | { type: 'done'; sessionId: string }
  | { type: 'error'; message: string; code?: string };

export type ConnectionState =
  | { status: 'unknown' }
  | { status: 'ok'; mock: boolean; model?: string }
  | { status: 'down'; detail: string }
  | { status: 'no-key'; detail: string };
