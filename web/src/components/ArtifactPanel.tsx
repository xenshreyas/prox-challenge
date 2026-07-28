import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Artifact } from '../types';
import { artifactLabel, buildArtifactSrcDoc } from '../lib/artifactRuntime';
import { CopyIcon, CheckIcon, CodeIcon, ExternalIcon, PlayIcon, RefreshIcon, CloseIcon } from './icons';
import styles from './ArtifactPanel.module.css';

interface Props {
  artifacts: Artifact[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose?: () => void;
}

/** Messages the artifact harness posts out of the sandboxed iframe. */
type HarnessMessage =
  | { source: 'artifact'; type: 'resize'; height: number }
  | { source: 'artifact'; type: 'error'; message: string }
  | { source: 'artifact'; type: 'ready' };

function isHarnessMessage(d: unknown): d is HarnessMessage {
  return !!d && typeof d === 'object' && (d as { source?: unknown }).source === 'artifact';
}

export function ArtifactPanel({ artifacts, activeId, onSelect, onClose }: Props) {
  const active = artifacts.find((a) => a.id === activeId) ?? artifacts[0];
  const [view, setView] = useState<'preview' | 'code'>('preview');
  const [copied, setCopied] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  const srcDoc = useMemo(
    () => (active ? buildArtifactSrcDoc(active) : ''),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [active?.id, active?.code, nonce],
  );

  const reload = useCallback(() => {
    setError(null);
    setHeight(null);
    setNonce((n) => n + 1);
  }, []);

  // Reset per-artifact state whenever the selection or the reload nonce changes.
  useEffect(() => {
    setView('preview');
    setError(null);
    setHeight(null);
  }, [active?.id]);

  // The iframe is cross-origin (opaque), so postMessage is the only channel.
  // Accept only messages whose source is this artifact's contentWindow, so a
  // stale frame or an unrelated embed cannot drive this panel's state.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (frameRef.current && e.source !== frameRef.current.contentWindow) return;
      const d: unknown = e.data;
      if (!isHarnessMessage(d)) return;
      if (d.type === 'resize' && Number.isFinite(d.height)) {
        setHeight(Math.min(Math.max(d.height, 120), 20000));
      } else if (d.type === 'error') {
        setError((prev) => prev ?? String(d.message));
      } else if (d.type === 'ready') {
        setError(null);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [active?.id, nonce]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  if (!active) return null;

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(active.code);
      setCopied(true);
    } catch {
      /* clipboard blocked */
    }
  };

  const openInNewTab = () => {
    const blob = new Blob([srcDoc], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener,noreferrer');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  return (
    <aside className={styles.panel} aria-label="Generated artifacts">
      <header className={styles.header}>
        <div className={styles.headTitle}>
          <span className={styles.dot} aria-hidden />
          <span>Artifacts</span>
          <span className={styles.count}>{artifacts.length}</span>
        </div>
        <div className={styles.headActions}>
          <div className={styles.segmented} role="tablist" aria-label="Artifact view">
            <button
              role="tab"
              aria-selected={view === 'preview'}
              className={view === 'preview' ? styles.segOn : styles.seg}
              onClick={() => setView('preview')}
            >
              <PlayIcon /> Preview
            </button>
            <button
              role="tab"
              aria-selected={view === 'code'}
              className={view === 'code' ? styles.segOn : styles.seg}
              onClick={() => setView('code')}
            >
              <CodeIcon /> Code
            </button>
          </div>
          {onClose && (
            <button className={styles.iconBtn} onClick={onClose} title="Hide panel" aria-label="Hide artifact panel">
              <CloseIcon />
            </button>
          )}
        </div>
      </header>

      {artifacts.length > 1 && (
        <nav className={styles.tabs} role="tablist" aria-label="Artifact list">
          {artifacts.map((a) => (
            <button
              key={a.id}
              role="tab"
              aria-selected={a.id === active.id}
              className={a.id === active.id ? styles.tabOn : styles.tab}
              onClick={() => onSelect(a.id)}
              title={a.title}
            >
              <span className={styles.tabKind}>{artifactLabel(a.mimeType)}</span>
              <span className={styles.tabName}>{a.title}</span>
            </button>
          ))}
        </nav>
      )}

      <div className={styles.subhead}>
        <div className={styles.meta}>
          <strong>{active.title}</strong>
          <code>{active.mimeType}</code>
        </div>
        <div className={styles.tools}>
          <button className={styles.iconBtn} onClick={reload} title="Reload artifact" aria-label="Reload artifact">
            <RefreshIcon />
          </button>
          <button className={styles.iconBtn} onClick={copyCode} title="Copy source" aria-label="Copy artifact source">
            {copied ? <CheckIcon /> : <CopyIcon />}
          </button>
          <button className={styles.iconBtn} onClick={openInNewTab} title="Open in new tab" aria-label="Open artifact in a new tab">
            <ExternalIcon />
          </button>
        </div>
      </div>

      <div className={styles.stage}>
        {view === 'preview' ? (
          <div className={styles.scroller}>
            {error && (
              <div className={styles.errorBar} role="alert">
                <div className={styles.errorHead}>
                  <span className={styles.errorDot} aria-hidden />
                  <strong>This artifact didn’t render cleanly</strong>
                </div>
                <pre className={styles.errorBody}>{error}</pre>
                <div className={styles.errorActions}>
                  <button className={styles.errorBtn} onClick={reload}>
                    <RefreshIcon /> Try again
                  </button>
                  <button className={styles.errorBtn} onClick={() => setView('code')}>
                    <CodeIcon /> View source
                  </button>
                  <button className={styles.errorBtn} onClick={copyCode}>
                    {copied ? <CheckIcon /> : <CopyIcon />} Copy source
                  </button>
                </div>
              </div>
            )}
            <iframe
              ref={frameRef}
              key={`${active.id}:${nonce}`}
              className={styles.frame}
              /* Sized from the harness's postMessage resize events; falls back to
                 filling the stage until the first measurement arrives. */
              style={height ? { height: `${height}px` } : undefined}
              title={active.title}
              srcDoc={srcDoc}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
            />
          </div>
        ) : (
          <pre className={styles.code}>
            <code>{active.code}</code>
          </pre>
        )}
      </div>

      <footer className={styles.foot}>
        <span className={styles.shield} />
        Sandboxed — <code>allow-scripts</code> only, opaque origin, no access to this page.
      </footer>
    </aside>
  );
}
