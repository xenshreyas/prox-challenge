import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useChat } from './hooks/useChat';
import { MOCK } from './lib/api';
import { MessageView } from './components/MessageView';
import { Composer } from './components/Composer';
import { EmptyState } from './components/EmptyState';
import { ArtifactPanel } from './components/ArtifactPanel';
import { ConnectionBanner, StatusPill } from './components/ConnectionBanner';
import { BoltIcon, SparkIcon, TrashIcon } from './components/icons';
import styles from './App.module.css';

export default function App() {
  const {
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
  } = useChat();

  const [seed, setSeed] = useState<string | undefined>();
  const [panelOpen, setPanelOpen] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // stick to bottom only when the user hasn't scrolled away
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }, []);

  useLayoutEffect(() => {
    if (!pinned.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => {
    if (artifacts.length) setPanelOpen(true);
  }, [artifacts.length]);

  const blocked = connection.status === 'down' || connection.status === 'no-key';
  const showPanel = artifacts.length > 0 && panelOpen;

  return (
    <div className={`${styles.app} ${showPanel ? styles.split : ''}`}>
      <header className={styles.topbar}>
        <div className={styles.brand}>
          <span className={styles.logo} aria-hidden>
            <BoltIcon />
          </span>
          <div className={styles.brandText}>
            <strong>OmniPro 220</strong>
            <span>Manual Agent</span>
          </div>
        </div>

        <div className={styles.topRight}>
          {MOCK && <span className={styles.mockTag}>MOCK</span>}
          <StatusPill state={connection} />
          {artifacts.length > 0 && (
            <button
              className={panelOpen ? styles.ghostOn : styles.ghost}
              onClick={() => setPanelOpen((v) => !v)}
              title="Toggle artifact panel"
            >
              <SparkIcon />
              <span className={styles.hideSm}>Artifacts</span>
              <span className={styles.badge}>{artifacts.length}</span>
            </button>
          )}
          {messages.length > 0 && (
            <button className={styles.ghost} onClick={reset} title="New conversation">
              <TrashIcon />
              <span className={styles.hideSm}>New chat</span>
            </button>
          )}
        </div>
      </header>

      <main className={styles.main}>
        <section className={styles.chatCol}>
          <div className={styles.scroll} ref={scrollRef} onScroll={onScroll}>
            <div className={styles.thread}>
              <ConnectionBanner state={connection} onRetry={retryHealth} />
              {messages.length === 0 ? (
                <EmptyState mock={MOCK} onPick={(q) => (blocked ? setSeed(q) : void send(q))} />
              ) : (
                messages.map((m) => (
                  <MessageView
                    key={m.id}
                    message={m}
                    onOpenArtifact={(id) => {
                      setActiveArtifactId(id);
                      setPanelOpen(true);
                    }}
                  />
                ))
              )}
            </div>
          </div>

          <Composer
            onSend={(t) => void send(t)}
            onStop={stop}
            busy={busy}
            disabled={blocked}
            seed={seed}
          />
        </section>

        {showPanel && (
          <ArtifactPanel
            artifacts={artifacts}
            activeId={activeArtifactId}
            onSelect={setActiveArtifactId}
            onClose={() => setPanelOpen(false)}
          />
        )}
      </main>
    </div>
  );
}
