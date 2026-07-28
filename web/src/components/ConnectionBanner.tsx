import type { ConnectionState } from '../types';
import { AlertIcon, RefreshIcon } from './icons';
import styles from './ConnectionBanner.module.css';

export function StatusPill({ state }: { state: ConnectionState }) {
  const map = {
    unknown: { cls: styles.pillIdle, text: 'Connecting…' },
    ok: { cls: styles.pillOk, text: 'Agent online' },
    down: { cls: styles.pillBad, text: 'Server offline' },
    'no-key': { cls: styles.pillWarn, text: 'No API key' },
  } as const;
  const cfg = map[state.status];
  const detail = state.status === 'ok' && state.mock ? 'Mock mode' : cfg.text;
  return (
    <span className={`${styles.pill} ${cfg.cls}`} title={detail}>
      <span className={styles.led} />
      {detail}
    </span>
  );
}

export function ConnectionBanner({
  state,
  onRetry,
}: {
  state: ConnectionState;
  onRetry: () => void;
}) {
  if (state.status === 'ok' || state.status === 'unknown') return null;

  const isKey = state.status === 'no-key';
  return (
    <div className={isKey ? styles.bannerWarn : styles.bannerBad} role="alert">
      <AlertIcon />
      <div className={styles.text}>
        <strong>
          {isKey ? 'Anthropic API key not configured' : 'Cannot reach the agent server'}
        </strong>
        <p>{state.detail}</p>
        <p className={styles.fix}>
          {isKey ? (
            <>
              Add <code>ANTHROPIC_API_KEY=sk-ant-…</code> to <code>.env</code>, then restart{' '}
              <code>npm run dev:server</code>. To explore the UI without a key, run{' '}
              <code>VITE_MOCK=1 npm run dev:web</code>.
            </>
          ) : (
            <>
              Start the backend with <code>npm run dev:server</code> (expected on{' '}
              <code>http://localhost:8787</code>), or demo the UI standalone with{' '}
              <code>VITE_MOCK=1 npm run dev:web</code>.
            </>
          )}
        </p>
      </div>
      <button className={styles.retry} onClick={onRetry}>
        <RefreshIcon /> Retry
      </button>
    </div>
  );
}
