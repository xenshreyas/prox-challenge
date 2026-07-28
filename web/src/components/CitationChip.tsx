import { useState } from 'react';
import type { Citation } from '../types';
import { pageImageUrl } from '../lib/api';
import { Lightbox } from './Lightbox';
import { BookIcon } from './icons';
import styles from './CitationChip.module.css';

export function CitationChip({ citation }: { citation: Citation }) {
  const [open, setOpen] = useState(false);
  const src = pageImageUrl(citation.doc, citation.page);
  const label = citation.section
    ? `${citation.section} · p.${citation.page}`
    : `p.${citation.page}`;

  return (
    <>
      <button
        className={styles.chip}
        onClick={() => setOpen(true)}
        title={`View ${citation.doc} page ${citation.page}${citation.section ? ` — ${citation.section}` : ''}`}
      >
        <BookIcon />
        <span>{label}</span>
      </button>
      {open && (
        <Lightbox
          src={src}
          alt={`${citation.doc} page ${citation.page}`}
          caption={citation.section ?? `Page ${citation.page}`}
          meta={`${citation.doc.replace(/-/g, ' ')} · page ${citation.page}`}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

export function CitationRow({ citations }: { citations: Citation[] }) {
  if (!citations.length) return null;
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>Sources</span>
      <div className={styles.chips}>
        {citations.map((c, i) => (
          <CitationChip key={`${c.doc}-${c.page}-${i}`} citation={c} />
        ))}
      </div>
    </div>
  );
}
