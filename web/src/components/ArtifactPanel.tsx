import { useEffect, useMemo, useState } from 'react';
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

export function ArtifactPanel({ artifacts, activeId, onSelect, onClose }: Props) {
  const active = artifacts.find((a) => a.id === activeId) ?? artifacts[0];
  const [view, setView] = useState<'preview' | 'code'>('preview');
  const [copied, setCopied] = useState(false);
  const [nonce, setNonce] = useState(0);

  const srcDoc = useMemo(
    () => (active ? buildArtifactSrcDoc(active) : ''),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [active?.id, active?.code, nonce],
  );

  useEffect(() => {
    setView('preview');
  }, [active?.id]);

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
          <button className={styles.iconBtn} onClick={() => setNonce((n) => n + 1)} title="Reload artifact" aria-label="Reload artifact">
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
          <iframe
            key={`${active.id}:${nonce}`}
            className={styles.frame}
            title={active.title}
            srcDoc={srcDoc}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            loading="lazy"
          />
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
