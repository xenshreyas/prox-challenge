import type { Message } from '../types';
import { Markdown } from '../lib/markdown';
import { FigureCard } from './FigureCard';
import { CitationRow } from './CitationChip';
import { ToolIcon, AlertIcon, BoltIcon, SparkIcon } from './icons';
import styles from './MessageView.module.css';

function ToolTrace({ tools }: { tools: Message['tools'] }) {
  if (!tools.length) return null;
  return (
    <details className={styles.tools}>
      <summary>
        <ToolIcon />
        <span>
          {tools.length} tool {tools.length === 1 ? 'call' : 'calls'}
        </span>
        <em>{tools.map((t) => t.name).join(' · ')}</em>
      </summary>
      <ol className={styles.toolList}>
        {tools.map((t, i) => (
          <li key={i}>
            <code className={styles.toolName}>{t.name}</code>
            <pre className={styles.toolInput}>
              {typeof t.input === 'string' ? t.input : JSON.stringify(t.input, null, 2)}
            </pre>
          </li>
        ))}
      </ol>
    </details>
  );
}

export function MessageView({
  message,
  onOpenArtifact,
}: {
  message: Message;
  onOpenArtifact: (id: string) => void;
}) {
  if (message.role === 'user') {
    return (
      <article className={styles.userRow}>
        <div className={styles.userBubble}>{message.text}</div>
      </article>
    );
  }

  const empty = !message.text && !message.figures.length && !message.tools.length;

  return (
    <article className={styles.assistantRow}>
      <div className={styles.avatar} aria-hidden>
        <BoltIcon />
      </div>
      <div className={styles.body}>
        <ToolTrace tools={message.tools} />

        {empty && message.streaming && (
          <div className={styles.thinking}>
            <span /> <span /> <span />
            <em>Reading the manual…</em>
          </div>
        )}

        {message.text && (
          <div className={styles.prose}>
            <Markdown source={message.text} />
            {message.streaming && <span className={styles.caret} aria-hidden />}
          </div>
        )}

        {message.figures.length > 0 && (
          <div className={styles.figures}>
            {message.figures.map((f, i) => (
              <FigureCard key={`${f.slug}-${f.page}-${i}`} figure={f} />
            ))}
          </div>
        )}

        {message.artifacts.length > 0 && (
          <div className={styles.artifactRefs}>
            {message.artifacts.map((a) => (
              <button
                key={a.id}
                className={styles.artifactRef}
                onClick={() => onOpenArtifact(a.id)}
              >
                <SparkIcon />
                <span className={styles.artName}>{a.title}</span>
                <span className={styles.artOpen}>Open →</span>
              </button>
            ))}
          </div>
        )}

        <CitationRow citations={message.citations} />

        {message.error && (
          <div className={styles.error} role="alert">
            <AlertIcon />
            <div>
              <strong>Something went wrong</strong>
              <p>{message.error}</p>
            </div>
          </div>
        )}
      </div>
    </article>
  );
}
