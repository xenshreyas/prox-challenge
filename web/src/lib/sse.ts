import type { StreamEvent } from '../types';

/**
 * Minimal SSE parser over fetch(). We can't use EventSource because /api/chat
 * is a POST with a JSON body. Handles multi-line `data:` payloads, `event:`
 * names, comment/heartbeat lines, and CRLF.
 */
export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const onAbort = () => void reader.cancel().catch(() => {});
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');

      let split: number;
      while ((split = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        let event = 'message';
        const data: string[] = [];
        for (const line of raw.split('\n')) {
          if (!line || line.startsWith(':')) continue;
          const colon = line.indexOf(':');
          const field = colon === -1 ? line : line.slice(0, colon);
          const val = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
          if (field === 'event') event = val;
          else if (field === 'data') data.push(val);
        }
        if (data.length || event !== 'message') {
          yield { event, data: data.join('\n') };
        }
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock?.();
  }
}

/** Map a raw SSE frame onto our typed event union. Unknown events are dropped. */
export function toStreamEvent(event: string, data: string): StreamEvent | null {
  let payload: any = {};
  if (data) {
    try {
      payload = JSON.parse(data);
    } catch {
      // token frames are the only ones we tolerate as plain text
      if (event === 'token') return { type: 'token', text: data };
      return null;
    }
  }

  switch (event) {
    case 'token':
      return typeof payload.text === 'string'
        ? { type: 'token', text: payload.text }
        : null;
    case 'tool':
      return { type: 'tool', name: String(payload.name ?? 'tool'), input: payload.input };
    case 'figure':
      if (!payload.imageUrl && !payload.page) return null;
      return {
        type: 'figure',
        figure: {
          doc: String(payload.doc ?? 'owner-manual'),
          page: Number(payload.page ?? 0),
          slug: String(payload.slug ?? ''),
          caption: payload.caption ?? null,
          imageUrl: String(
            payload.imageUrl ?? `/api/page-image/${payload.doc}/${payload.page}`,
          ),
          description: payload.description ?? undefined,
        },
      };
    case 'artifact':
      if (typeof payload.code !== 'string') return null;
      return {
        type: 'artifact',
        artifact: {
          id: String(payload.id ?? `artifact-${Date.now()}`),
          title: String(payload.title ?? 'Untitled artifact'),
          mimeType: String(payload.mimeType ?? 'text/html'),
          code: payload.code,
        },
      };
    case 'citation':
      return {
        type: 'citation',
        citation: {
          doc: String(payload.doc ?? 'owner-manual'),
          page: Number(payload.page ?? 0),
          section: payload.section ?? undefined,
        },
      };
    case 'done':
      return { type: 'done', sessionId: String(payload.sessionId ?? '') };
    case 'error':
      return {
        type: 'error',
        message: String(payload.message ?? 'Unknown server error'),
        code: payload.code ? String(payload.code) : undefined,
      };
    default:
      return null;
  }
}
