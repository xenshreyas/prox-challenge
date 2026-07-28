import { useEffect, useRef, useState } from 'react';
import { SendIcon, StopIcon } from './icons';
import styles from './Composer.module.css';

interface Props {
  onSend: (text: string) => void;
  onStop: () => void;
  busy: boolean;
  disabled?: boolean;
  seed?: string;
}

export function Composer({ onSend, onStop, busy, disabled, seed }: Props) {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (seed) {
      setValue(seed);
      ref.current?.focus();
    }
  }, [seed]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  const submit = () => {
    const t = value.trim();
    if (!t || busy || disabled) return;
    onSend(t);
    setValue('');
  };

  return (
    <div className={styles.wrap}>
      <div className={styles.shell}>
        <textarea
          ref={ref}
          className={styles.input}
          value={value}
          rows={1}
          disabled={disabled}
          placeholder={
            disabled
              ? 'Agent unavailable — see the banner above'
              : 'Ask about the OmniPro 220 — settings, duty cycle, parts, troubleshooting…'
          }
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        {busy ? (
          <button className={styles.stop} onClick={onStop} title="Stop generating">
            <StopIcon />
            <span>Stop</span>
          </button>
        ) : (
          <button
            className={styles.send}
            onClick={submit}
            disabled={!value.trim() || disabled}
            title="Send (Enter)"
            aria-label="Send message"
          >
            <SendIcon />
          </button>
        )}
      </div>
      <p className={styles.hint}>
        <kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line ·
        answers are grounded in the OmniPro 220 owner's manual
      </p>
    </div>
  );
}
