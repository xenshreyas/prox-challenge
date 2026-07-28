import { useEffect, useState } from 'react';
import type { Figure } from '../types';
import { pageImageUrl } from '../lib/api';
import { Lightbox } from './Lightbox';
import { ZoomIcon, AlertIcon } from './icons';
import styles from './FigureCard.module.css';

export function FigureCard({ figure }: { figure: Figure }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [src, setSrc] = useState(figure.imageUrl || pageImageUrl(figure.doc, figure.page));

  useEffect(() => {
    setState('loading');
    setSrc(figure.imageUrl || pageImageUrl(figure.doc, figure.page));
  }, [figure.imageUrl, figure.doc, figure.page]);

  const fallback = pageImageUrl(figure.doc, figure.page);
  const label = figure.caption || figure.slug.replace(/-/g, ' ') || `Page ${figure.page}`;

  return (
    <figure className={styles.card}>
      <button
        className={styles.thumb}
        onClick={() => state === 'ready' && setOpen(true)}
        aria-label={`Zoom figure: ${label}`}
        disabled={state !== 'ready'}
      >
        {state === 'error' ? (
          <div className={styles.broken}>
            <AlertIcon />
            <span>Page image unavailable</span>
            <code>
              {figure.doc} · p.{figure.page}
            </code>
          </div>
        ) : (
          <>
            {state === 'loading' && <div className={styles.skeleton} aria-hidden />}
            <img
              className={styles.img}
              src={src}
              alt={figure.description || label}
              loading="lazy"
              decoding="async"
              onLoad={() => setState('ready')}
              onError={() => {
                if (src !== fallback) {
                  setSrc(fallback);
                } else {
                  setState('error');
                }
              }}
              style={{ opacity: state === 'ready' ? 1 : 0 }}
            />
            {state === 'ready' && (
              <span className={styles.zoomHint}>
                <ZoomIcon /> Zoom
              </span>
            )}
          </>
        )}
      </button>

      <figcaption className={styles.caption}>
        <div className={styles.capText}>{label}</div>
        <a
          className={styles.pageChip}
          href={fallback}
          target="_blank"
          rel="noreferrer noopener"
          title={`Open ${figure.doc} page ${figure.page}`}
        >
          {figure.doc.replace(/-/g, ' ')} · p.{figure.page}
        </a>
      </figcaption>

      {figure.description && (
        <details className={styles.details}>
          <summary>Figure description</summary>
          <p>{figure.description}</p>
        </details>
      )}

      {open && (
        <Lightbox
          src={src}
          alt={figure.description || label}
          caption={label}
          meta={`${figure.doc.replace(/-/g, ' ')} · page ${figure.page}`}
          onClose={() => setOpen(false)}
        />
      )}
    </figure>
  );
}
