/**
 * Zero-dependency markdown -> React renderer.
 *
 * Deliberately small and safe: we never build raw HTML strings, so there is no
 * dangerouslySetInnerHTML anywhere in the app and no XSS surface from model
 * output. Supports the subset the agent actually emits: headings, paragraphs,
 * bold/italic/inline-code/links, fenced code blocks, unordered + ordered lists,
 * blockquotes, horizontal rules, and GitHub-style tables.
 */
import type { ReactNode } from 'react';
import { Fragment, createElement } from 'react';

type Inline = ReactNode;

const INLINE_RE =
  /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\n]+\*)|(\[[^\]]+\]\([^)\s]+\))|(\bhttps?:\/\/[^\s<>()]+)/g;

function renderInline(src: string, keyBase: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  INLINE_RE.lastIndex = 0;
  while ((match = INLINE_RE.exec(src)) !== null) {
    if (match.index > last) out.push(src.slice(last, match.index));
    const tok = match[0];
    const key = `${keyBase}-i${i++}`;
    if (tok.startsWith('`')) {
      out.push(
        createElement('code', { key, className: 'md-code-inline' }, tok.slice(1, -1)),
      );
    } else if (tok.startsWith('**') || tok.startsWith('__')) {
      out.push(createElement('strong', { key }, tok.slice(2, -2)));
    } else if (tok.startsWith('*')) {
      out.push(createElement('em', { key }, tok.slice(1, -1)));
    } else if (tok.startsWith('[')) {
      const close = tok.indexOf('](');
      const label = tok.slice(1, close);
      const href = tok.slice(close + 2, -1);
      out.push(
        createElement(
          'a',
          { key, href, target: '_blank', rel: 'noreferrer noopener' },
          label,
        ),
      );
    } else {
      out.push(
        createElement(
          'a',
          { key, href: tok, target: '_blank', rel: 'noreferrer noopener' },
          tok,
        ),
      );
    }
    last = match.index + tok.length;
  }
  if (last < src.length) out.push(src.slice(last));
  return out.length ? out : [src];
}

function isTableDivider(line: string): boolean {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

export function renderMarkdown(source: string): ReactNode[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let k = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // fenced code block (tolerates an unterminated fence while streaming)
    const fence = /^\s*```(\S*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] ?? '';
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) body.push(lines[i++]!);
      i++; // consume closing fence if present
      blocks.push(
        createElement(
          'pre',
          { key: `b${k++}`, className: 'md-pre', 'data-lang': lang || undefined },
          createElement('code', null, body.join('\n')),
        ),
      );
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    // horizontal rule
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push(createElement('hr', { key: `b${k++}`, className: 'md-hr' }));
      i++;
      continue;
    }

    // heading
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(heading[1]!.length, 6);
      blocks.push(
        createElement(
          `h${level}`,
          { key: `b${k++}`, className: `md-h md-h${level}` },
          ...renderInline(heading[2]!, `b${k}`),
        ),
      );
      i++;
      continue;
    }

    // table
    if (line.includes('|') && i + 1 < lines.length && isTableDivider(lines[i + 1]!)) {
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim()) {
        rows.push(splitRow(lines[i]!));
        i++;
      }
      const key = `b${k++}`;
      blocks.push(
        createElement(
          'div',
          { key, className: 'md-table-wrap' },
          createElement(
            'table',
            { className: 'md-table' },
            createElement(
              'thead',
              null,
              createElement(
                'tr',
                null,
                ...header.map((c, ci) =>
                  createElement('th', { key: ci }, ...renderInline(c, `${key}-h${ci}`)),
                ),
              ),
            ),
            createElement(
              'tbody',
              null,
              ...rows.map((r, ri) =>
                createElement(
                  'tr',
                  { key: ri },
                  ...r.map((c, ci) =>
                    createElement(
                      'td',
                      { key: ci },
                      ...renderInline(c, `${key}-${ri}-${ci}`),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      continue;
    }

    // blockquote
    if (/^\s*>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i]!)) {
        body.push(lines[i]!.replace(/^\s*>\s?/, ''));
        i++;
      }
      const key = `b${k++}`;
      blocks.push(
        createElement(
          'blockquote',
          { key, className: 'md-quote' },
          ...renderMarkdown(body.join('\n')),
        ),
      );
      continue;
    }

    // lists
    const bullet = /^(\s*)([-*+])\s+(.*)$/.exec(line);
    const ordered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
    if (bullet || ordered) {
      const isOrdered = Boolean(ordered);
      const items: string[] = [];
      while (i < lines.length) {
        const m = isOrdered
          ? /^(\s*)(\d+)[.)]\s+(.*)$/.exec(lines[i]!)
          : /^(\s*)([-*+])\s+(.*)$/.exec(lines[i]!);
        if (m) {
          items.push(m[3]!);
          i++;
        } else if (/^\s{2,}\S/.test(lines[i] ?? '') && items.length) {
          items[items.length - 1] += ` ${lines[i]!.trim()}`;
          i++;
        } else break;
      }
      const key = `b${k++}`;
      blocks.push(
        createElement(
          isOrdered ? 'ol' : 'ul',
          { key, className: 'md-list' },
          ...items.map((it, ii) =>
            createElement('li', { key: ii }, ...renderInline(it, `${key}-${ii}`)),
          ),
        ),
      );
      continue;
    }

    // paragraph (greedy until blank line / new block starter)
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !/^\s*(#{1,6}\s|```|>|[-*+]\s|\d+[.)]\s)/.test(lines[i]!) &&
      !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i]!)
    ) {
      para.push(lines[i]!);
      i++;
    }
    if (para.length) {
      const key = `b${k++}`;
      blocks.push(
        createElement(
          'p',
          { key, className: 'md-p' },
          ...renderInline(para.join(' '), key),
        ),
      );
    } else {
      i++;
    }
  }

  return blocks;
}

export function Markdown({ source }: { source: string }) {
  return createElement(Fragment, null, ...renderMarkdown(source));
}
