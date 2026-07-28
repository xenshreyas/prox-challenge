import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CloseIcon, ExternalIcon } from './icons';
import styles from './Lightbox.module.css';

interface Props {
  src: string;
  alt: string;
  caption: string;
  meta: string;
  onClose: () => void;
}

const STEPS = [1, 1.5, 2, 3, 4];

export function Lightbox({ src, alt, caption, meta, onClose }: Props) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === '+' || e.key === '=') setZoom((z) => Math.min(z * 1.4, 6));
      if (e.key === '-') setZoom((z) => Math.max(z / 1.4, 1));
      if (e.key === '0') {
        setZoom(1);
        setPan({ x: 0, y: 0 });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const cycleZoom = useCallback(() => {
    setZoom((z) => {
      const next = STEPS.find((s) => s > z + 0.01) ?? STEPS[0]!;
      if (next === 1) setPan({ x: 0, y: 0 });
      return next;
    });
  }, []);

  const onWheel = (e: React.WheelEvent) => {
    const next = Math.min(Math.max(zoom * (e.deltaY < 0 ? 1.12 : 0.89), 1), 6);
    setZoom(next);
    if (next === 1) setPan({ x: 0, y: 0 });
  };

  return createPortal(
    <div
      className={styles.backdrop}
      role="dialog"
      aria-modal="true"
      aria-label={caption}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className={styles.bar}>
        <div className={styles.info}>
          <strong>{caption}</strong>
          <span>{meta}</span>
        </div>
        <div className={styles.controls}>
          <button className={styles.btn} onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}>
            Reset
          </button>
          <span className={styles.zoomLevel}>{Math.round(zoom * 100)}%</span>
          <a className={styles.btn} href={src} target="_blank" rel="noreferrer noopener" title="Open original">
            <ExternalIcon />
          </a>
          <button ref={closeRef} className={styles.btn} onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>
      </div>

      <div
        className={styles.stage}
        onWheel={onWheel}
        onMouseDown={(e) => {
          if (zoom <= 1) return;
          drag.current = { x: e.clientX, y: e.clientY, ox: pan.x, oy: pan.y };
        }}
        onMouseMove={(e) => {
          if (!drag.current) return;
          setPan({
            x: drag.current.ox + (e.clientX - drag.current.x),
            y: drag.current.oy + (e.clientY - drag.current.y),
          });
        }}
        onMouseUp={() => (drag.current = null)}
        onMouseLeave={() => (drag.current = null)}
        style={{ cursor: zoom > 1 ? (drag.current ? 'grabbing' : 'grab') : 'zoom-in' }}
      >
        <img
          className={styles.img}
          src={src}
          alt={alt}
          onClick={cycleZoom}
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
          draggable={false}
        />
      </div>

      <p className={styles.hint}>Click or scroll to zoom · drag to pan · Esc to close</p>
    </div>,
    document.body,
  );
}
