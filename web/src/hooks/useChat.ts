import { useCallback, useEffect, useRef, useState } from 'react';
import type { Artifact, ConnectionState, Message } from '../types';
import { checkHealth, streamChat } from '../lib/api';

let seq = 0;
const nextId = (p: string) => `${p}-${Date.now().toString(36)}-${seq++}`;

function blankAssistant(): Message {
  return {
    id: nextId('a'),
    role: 'assistant',
    text: '',
    figures: [],
    artifacts: [],
    citations: [],
    tools: [],
    streaming: true,
    createdAt: Date.now(),
  };
}

export function useChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const [connection, setConnection] = useState<ConnectionState>({ status: 'unknown' });
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [activeArtifactId, setActiveArtifactId] = useState<string | null>(null);
  const sessionId = useRef<string | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    void checkHealth(ctl.signal).then(setConnection);
    return () => ctl.abort();
  }, []);

  const retryHealth = useCallback(() => {
    setConnection({ status: 'unknown' });
    void checkHealth().then(setConnection);
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
    setMessages((prev) =>
      prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
    );
  }, []);

  const send = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || busy) return;

      const ctl = new AbortController();
      abortRef.current = ctl;
      setBusy(true);

      const user: Message = {
        id: nextId('u'),
        role: 'user',
        text,
        figures: [],
        artifacts: [],
        citations: [],
        tools: [],
        streaming: false,
        createdAt: Date.now(),
      };
      const assistant = blankAssistant();
      setMessages((prev) => [...prev, user, assistant]);

      const patch = (fn: (m: Message) => Message) =>
        setMessages((prev) => prev.map((m) => (m.id === assistant.id ? fn(m) : m)));

      try {
        for await (const ev of streamChat(
          { message: text, sessionId: sessionId.current },
          ctl.signal,
        )) {
          switch (ev.type) {
            case 'token':
              patch((m) => ({ ...m, text: m.text + ev.text }));
              break;
            case 'tool':
              patch((m) => ({
                ...m,
                tools: [...m.tools, { name: ev.name, input: ev.input, at: Date.now() }],
              }));
              break;
            case 'figure':
              patch((m) =>
                m.figures.some(
                  (f) => f.slug === ev.figure.slug && f.page === ev.figure.page,
                )
                  ? m
                  : { ...m, figures: [...m.figures, ev.figure] },
              );
              break;
            case 'artifact': {
              const a = ev.artifact;
              patch((m) => ({
                ...m,
                artifacts: m.artifacts.some((x) => x.id === a.id)
                  ? m.artifacts.map((x) => (x.id === a.id ? a : x))
                  : [...m.artifacts, a],
              }));
              setArtifacts((prev) =>
                prev.some((x) => x.id === a.id)
                  ? prev.map((x) => (x.id === a.id ? a : x))
                  : [...prev, a],
              );
              setActiveArtifactId(a.id);
              break;
            }
            case 'citation':
              patch((m) =>
                m.citations.some(
                  (c) => c.page === ev.citation.page && c.doc === ev.citation.doc,
                )
                  ? m
                  : { ...m, citations: [...m.citations, ev.citation] },
              );
              break;
            case 'done':
              if (ev.sessionId) sessionId.current = ev.sessionId;
              patch((m) => ({ ...m, streaming: false }));
              break;
            case 'error':
              patch((m) => ({ ...m, streaming: false, error: ev.message }));
              if (ev.code === 'NETWORK') {
                setConnection({ status: 'down', detail: ev.message });
              } else if (ev.code === 'AUTH') {
                setConnection({ status: 'no-key', detail: ev.message });
              }
              break;
          }
        }
        patch((m) => ({ ...m, streaming: false }));
      } catch (err) {
        if (!ctl.signal.aborted) {
          patch((m) => ({
            ...m,
            streaming: false,
            error: err instanceof Error ? err.message : String(err),
          }));
        } else {
          patch((m) => ({ ...m, streaming: false }));
        }
      } finally {
        if (abortRef.current === ctl) abortRef.current = null;
        setBusy(false);
      }
    },
    [busy],
  );

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    sessionId.current = undefined;
    setMessages([]);
    setArtifacts([]);
    setActiveArtifactId(null);
    setBusy(false);
  }, []);

  return {
    messages,
    busy,
    connection,
    artifacts,
    activeArtifactId,
    setActiveArtifactId,
    send,
    stop,
    reset,
    retryHealth,
  };
}
