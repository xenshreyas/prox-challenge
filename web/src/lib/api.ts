import type { ConnectionState, StreamEvent } from '../types';
import { parseSSE, toStreamEvent } from './sse';
import { mockStream } from './mock';

export const MOCK = import.meta.env.VITE_MOCK === '1';

export interface ChatRequest {
  message: string;
  sessionId?: string;
}

/** Streams typed events for one turn. Throws only on transport failure. */
export async function* streamChat(
  req: ChatRequest,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  if (MOCK) {
    yield* mockStream(req.message, signal);
    return;
  }

  let res: Response;
  try {
    res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(req),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) return;
    yield {
      type: 'error',
      code: 'NETWORK',
      message:
        'Could not reach the agent server on :8787. Start it with `npm run dev:server`, or run the UI in mock mode with `VITE_MOCK=1 npm run dev:web`.',
    };
    return;
  }

  if (!res.ok || !res.body) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.error) detail = String(body.error);
      else if (body?.message) detail = String(body.message);
    } catch {
      /* non-JSON error body */
    }
    yield {
      type: 'error',
      code: res.status === 401 || res.status === 403 ? 'AUTH' : `HTTP_${res.status}`,
      message: detail,
    };
    return;
  }

  for await (const frame of parseSSE(res.body, signal)) {
    const ev = toStreamEvent(frame.event, frame.data);
    if (ev) yield ev;
  }
}

/** Probes backend liveness + API-key configuration for the status pill. */
export async function checkHealth(signal?: AbortSignal): Promise<ConnectionState> {
  if (MOCK) return { status: 'ok', mock: true, model: 'mock transcript' };
  try {
    const res = await fetch('/api/health', { signal });
    if (!res.ok) {
      return { status: 'down', detail: `Server responded ${res.status}` };
    }
    const body = (await res.json()) as {
      ok?: boolean;
      hasApiKey?: boolean;
      model?: string;
      error?: string;
    };
    if (body.hasApiKey === false) {
      return {
        status: 'no-key',
        detail:
          'ANTHROPIC_API_KEY is not set on the server. Copy .env.example to .env and add your key, then restart `npm run dev:server`.',
      };
    }
    return { status: 'ok', mock: false, model: body.model };
  } catch {
    return {
      status: 'down',
      detail:
        'No response from http://localhost:8787. Start the agent server with `npm run dev:server`.',
    };
  }
}

export function pageImageUrl(doc: string, page: number): string {
  return `/api/page-image/${encodeURIComponent(doc)}/${page}`;
}
