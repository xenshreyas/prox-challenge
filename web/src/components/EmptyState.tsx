import { BoltIcon } from './icons';
import styles from './EmptyState.module.css';

const STARTERS: { q: string; tag: string; hint: string }[] = [
  {
    tag: 'Specs',
    q: "What's the duty cycle for MIG at 200 A on 240 V, and how long can I actually weld?",
    hint: 'Reads the nameplate tables and builds a calculator',
  },
  {
    tag: 'Setup',
    q: 'Walk me through loading a 0.030" flux-cored wire spool and setting the tensioner.',
    hint: 'Step-by-step with the interior diagram',
  },
  {
    tag: 'Controls',
    q: 'Show me the front panel and explain what each knob and button does.',
    hint: 'Pulls the labelled callout figure',
  },
  {
    tag: 'Troubleshoot',
    q: "My MIG bead is porous and spattering. What settings or gas issues should I check?",
    hint: 'Cross-references the troubleshooting table',
  },
  {
    tag: 'Safety',
    q: 'What PPE and ventilation does the manual require before I strike an arc?',
    hint: 'Safety chapter, cited by page',
  },
  {
    tag: 'Parts',
    q: 'Which consumables and contact tips fit this machine, and what are the part numbers?',
    hint: 'Parts list lookup',
  },
];

export function EmptyState({ onPick, mock }: { onPick: (q: string) => void; mock: boolean }) {
  return (
    <div className={styles.wrap}>
      <div className={styles.hero}>
        <div className={styles.mark} aria-hidden>
          <BoltIcon />
        </div>
        <h1 className={styles.title}>
          Vulcan <span>OmniPro 220</span>
        </h1>
        <p className={styles.sub}>
          A multimodal agent over the multiprocess welder's owner's manual. It reads the
          text <em>and</em> the diagrams, shows you the page it used, and builds
          interactive tools when a table isn't enough.
        </p>
        <div className={styles.badges}>
          <span>48-page manual indexed</span>
          <span>Page-level citations</span>
          <span>Live artifacts</span>
          {mock && <span className={styles.mockBadge}>Mock transcript</span>}
        </div>
      </div>

      <div className={styles.gridLabel}>Try one of these</div>
      <div className={styles.grid}>
        {STARTERS.map((s) => (
          <button key={s.q} className={styles.card} onClick={() => onPick(s.q)}>
            <span className={styles.tag}>{s.tag}</span>
            <span className={styles.q}>{s.q}</span>
            <span className={styles.hint}>{s.hint}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
