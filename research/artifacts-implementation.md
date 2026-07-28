# Reverse-Engineering Claude Artifacts — Implementation Guide

Verified implementation notes for emitting LLM-authored interactive HTML/React
"artifacts" and rendering them safely in a chat UI. Everything below was tested
locally (Chromium, React 19, Tailwind 4) before being written down.

## Sources

- Reid Barber, *Reverse engineering Claude Artifacts* — https://www.reidbarber.com/blog/reverse-engineering-claude-artifacts
- Leaked artifacts system prompt (`<artifacts_info>`) via @elder_plinius, quoted in the article above.
- MDN `iframe` sandbox — https://developer.mozilla.org/en-US/docs/Web/HTML/Element/iframe#sandbox
- MDN `Window.postMessage` — https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage
- Import maps — https://developer.mozilla.org/en-US/docs/Web/HTML/Element/script/type/importmap
- esm.sh (`?external=` dedupe) — https://esm.sh/#docs
- Babel Standalone — https://babeljs.io/docs/babel-standalone
- Tailwind v4 browser build — https://tailwindcss.com/docs/installation/play-cdn (`@tailwindcss/browser@4`)
- react-runner (what Claude actually ships) — https://github.com/nihgwu/react-runner

---

## 1. The artifact protocol

Claude's client asks the model to emit a pseudo-XML tag inline in the normal
message stream:

```xml
<antArtifact
  identifier="us-states-population-table"
  type="application/vnd.ant.react"
  title="US States Population Table with Sorting"
>
  // ... code ...
</antArtifact>
```

Attributes:

| Attr | Meaning |
|---|---|
| `identifier` | Stable slug. **Reused across turns to update an artifact in place** rather than creating a new one. |
| `type` | MIME type telling the client which renderer to use. |
| `title` | Human-readable label for the panel header. |
| `language` | Only for `application/vnd.ant.code`. |

Observed MIME types (`vnd.ant` = vendor-prefixed, "ant" = Anthropic):

| Type | Rendering |
|---|---|
| `application/vnd.ant.react` | Compiled + mounted React component |
| `text/html` | Full single-file page in a nested iframe |
| `image/svg+xml` | Inline SVG |
| `application/vnd.ant.mermaid` | Mermaid diagram |
| `application/vnd.ant.code` | Syntax-highlighted, not executed |
| `text/markdown` | Rendered markdown |
| `text/plain`, `text/csv`, `application/json`, `application/xml`, `application/x-latex`, `text/vnd.graphviz` | Source view (LaTeX/Graphviz previews were behind a `preview_feature_uses_latex` flag) |

### Why pseudo-XML and not fenced code blocks

XML tags are what Anthropic recommends in prompts, models are heavily trained on
them, and — critically — attributes let you carry structured metadata
(`identifier` for update-in-place) that a ``` fence can't. Keep this format even
with non-Claude models; it works fine with GPT/Llama given a system prompt.

### System prompt (condensed, from the leak)

The real prompt is long; the load-bearing parts to replicate:

```
<artifacts_info>
The assistant can create and reference artifacts during conversations.
Artifacts are for substantial, self-contained content that users might modify
or reuse, displayed in a separate UI window.

# Good artifacts are...
- Substantial content (>15 lines)
- Content the user is likely to modify, iterate on, or take ownership of
- Self-contained and understandable without conversation context

# Don't use artifacts for...
- Simple, short, or purely explanatory content
- One-off questions

# Usage notes
- One artifact per message unless specifically requested
- Prefer inline content when possible
- Never mention the word "artifact" or the tag to the user
</artifacts_info>
```

Add your own runtime contract (this part is client-specific and you MUST state it
or the model will emit code your runtime can't execute):

```
For type="application/vnd.ant.react":
- Write a single file with a DEFAULT EXPORT of the React component.
- Use Tailwind utility classes only. No arbitrary values (no `h-[42px]`), no
  custom tailwind.config.
- Available imports: react (incl. hooks), lucide-react, recharts,
  three, d3, papaparse, lodash. Any other bare import will be resolved from
  esm.sh at runtime and may fail.
- No localStorage/sessionStorage (unavailable in the sandbox) — use useState.
- No network calls to arbitrary origins; fetch is CSP-restricted.
```

---

## 2. Streaming partial artifacts

The tag arrives token-by-token. Two rules:

1. **Never let a partial `<antArtif` tail leak into the chat transcript.** Withhold
   any trailing prefix of the opening tag from prose output.
2. **Debounce compilation while `complete === false`.** Half-written JSX won't
   parse; compiling every token burns CPU and floods the error channel. Show a
   streaming code view, then swap to the live render on close-tag.

`frontend/client/utils/artifactParser.ts` implements this. Verified: feeding the
parser every prefix `buf.slice(0, i)` of a full message for all `i` produced
**zero** frames where raw protocol leaked into `text`, and mid-stream returns:

```json
{"text":"Sure!\n","artifacts":[{"identifier":"c","type":"application/vnd.ant.react",
  "title":"Counter","content":"export default ()=>nu","complete":false}]}
```

---

## 3. Sandboxing

Claude serves its renderer from a **separate origin** (`claudeusercontent.com`)
and pushes code in over `postMessage`. Replicate the security properties without
buying a second domain:

```html
<iframe
  src="/artifact-runtime.html"
  sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"
  referrerPolicy="no-referrer"
  allow=""
/>
```

Key points:

- **`allow-scripts` WITHOUT `allow-same-origin`** → the frame gets an *opaque
  origin*. Even though `artifact-runtime.html` is served from your host, the
  document cannot read your cookies, `localStorage`, or reach into
  `parent.document`. Verified: `iframe.contentDocument` from the host returns
  `null` (cross-origin) under this config.
- **Never combine `allow-scripts` + `allow-same-origin`** — that lets the frame
  remove its own sandbox attribute and fully escape.
- **Don't put model output in `srcdoc` of the outer frame.** Load a static
  runtime document and deliver code via `postMessage` afterwards. Model text then
  never enters an HTML parsing context you control, which kills a whole class of
  injection. (`srcdoc` *is* used for the inner `text/html` frame — that one is
  double-nested, already inside an opaque origin.)
- Because the origin is opaque, the host must `postMessage(..., '*')`. That's
  safe here since the payload is the code the user already asked for; do **not**
  send secrets. Verify inbound messages with `e.source === iframe.contentWindow`
  (an origin check is useless — opaque origins report `"null"`).

### CSP

Serve `artifact-runtime.html` with a restrictive header. For Express:

```ts
app.get('/artifact-runtime.html', (_req, res, next) => {
  res.setHeader('Content-Security-Policy', [
    "default-src 'none'",
    // 'unsafe-eval' is REQUIRED: Babel compiles and we import a blob: module.
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https://esm.sh https://cdn.jsdelivr.net https://unpkg.com",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: https://esm.sh",
    "connect-src https://esm.sh https://cdn.jsdelivr.net https://unpkg.com",
    "frame-src blob: data:",         // for the nested text/html srcdoc frame
    "form-action 'none'",
  ].join('; '));
  next();
});
```

For a true origin boundary (recommended in production) host the runtime on a
separate hostname, e.g. `artifacts.quesal.dev`, and keep the sandbox attrs.

---

## 4. Running React + Tailwind with no build step

The runtime document layers four browser-native pieces:

1. **Import map** pins `react` / `react-dom` to fixed esm.sh URLs, so the
   artifact's `import React from 'react'` resolves and — crucially — the *same*
   React instance is shared with every other library (otherwise hooks throw
   "invalid hook call").
2. **Babel Standalone** compiles JSX **and TypeScript** in-browser
   (`presets: [['react',{runtime:'automatic'}], 'typescript']`).
3. **Blob module import**: the compiled ESM output is wrapped in a
   `Blob` → `URL.createObjectURL` → dynamic `import()`. This is what makes
   `export default` work — you get real module semantics instead of eval'ing into
   globals. This is the same job `react-runner` does in Claude's bundle.
4. **Bare-specifier rewriting**: any import not covered by the import map
   (`lucide-react`, `recharts`, …) is rewritten to
   `https://esm.sh/<pkg>?external=react,react-dom`. The `?external=` flag is what
   forces esm.sh to *not* bundle its own React copy and instead defer to the
   import map. Skipping it is the #1 cause of duplicate-React hook errors.
5. **Tailwind v4 browser build** (`@tailwindcss/browser@4`, 282 KB) scans the DOM
   and generates CSS at runtime with a MutationObserver — no config, no PostCSS.

**Verified working end-to-end**: a TSX artifact using `useState`, Tailwind
classes (`text-2xl font-bold text-blue-600`, `bg-blue-600 rounded-lg hover:…`),
and `lucide-react` icons compiled, mounted, and painted correctly inside
`sandbox="allow-scripts"` — host received `mounted` → `resize` → `ready`.

### Offline-ish operation

The CDNs are the only network dependency. To go fully offline, vendor them:

```bash
cd frontend/client/public && mkdir -p artifact-vendor && cd artifact-vendor
curl -L -o tailwind.js  https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4
curl -L -o babel.min.js https://unpkg.com/@babel/standalone@7.26.4/babel.min.js
curl -L -o react.js         "https://esm.sh/react@19.1.0?bundle&target=es2022"
curl -L -o react-dom.js     "https://esm.sh/react-dom@19.1.0/client?bundle&external=react&target=es2022"
curl -L -o lucide-react.js  "https://esm.sh/lucide-react@0.469.0?bundle&external=react&target=es2022"
```

Then point the `<script src>` tags and the import map at `/artifact-vendor/*`,
and change `CDN` in the runtime's `resolveSpec()` to `/artifact-vendor/` with a
whitelist — unknown packages fail loudly instead of hitting the network.
Sizes: Babel is ~3.1 MB (the heavy one), Tailwind ~282 KB.

---

## 5. Message passing

Host → frame:

```ts
{ source: 'host', type: 'render', identifier, mimeType, code }
```

Frame → host:

| type | payload | use |
|---|---|---|
| `mounted` | — | runtime booted; host may now send `render` |
| `ready` | `{ identifier }` | render succeeded |
| `error` | `{ message, stack }` | compile error, runtime error, or React error boundary |
| `console` | `{ level, args }` | forwarded `console.*` (Claude does this too — its HTML renderer has "console capture") |
| `resize` | `{ height }` | `ResizeObserver` on documentElement → host auto-sizes the frame |

The frame also traps `window.onerror` and `unhandledrejection`, and wraps the
component in an error boundary so a crashing artifact renders a red stack trace
instead of a blank panel. Feed `error` messages back into the chat as a
"fix this" affordance — that's the iteration loop that makes artifacts useful.

---

## 6. Files in this repo

| Path | What |
|---|---|
| `frontend/client/public/artifact-runtime.html` | The sandboxed runtime document (import map, Babel, Tailwind, blob-module loader, message bridge). Served as a static asset. |
| `frontend/client/utils/artifactParser.ts` | Streaming `<antArtifact>` parser. |
| `frontend/client/components/ArtifactFrame.tsx` | Host React component: creates the sandboxed iframe, debounced code push, console/error/resize handling. |

Usage:

```tsx
const { text, artifacts } = parseStream(streamBuffer);
return (
  <>
    <Markdown>{text}</Markdown>
    {artifacts.map(a =>
      RENDERABLE.includes(a.type) && a.complete
        ? <ArtifactFrame key={a.identifier} artifact={a}
            onError={e => console.warn('artifact error', e)} />
        : <CodeBlock key={a.identifier} lang={a.language}>{a.content}</CodeBlock>
    )}
  </>
);
```

## 7. Gotchas

- **Duplicate React** → "Invalid hook call". Always `?external=react,react-dom`
  on esm.sh, and never let the import map and a bundled dep disagree on version.
- **Babel + `type="module"`**: don't use `<script type="text/babel">`; it can't do
  `import`. Compile manually and load via blob URL, as done here.
- **Tailwind v4 browser build only scans the document it's loaded in.** For a
  `text/html` artifact rendered in a nested `srcdoc` frame, the model must include
  its own Tailwind `<script>` tag — instruct it to in the system prompt.
- **`allow-downloads`/`allow-popups`** are optional; drop them for stricter policy.
- **Remount on identity change**: keying the iframe by `identifier + type` throws
  away stale module state. Live-updating an existing artifact just re-sends
  `render` to the same frame, and `createRoot` is reused so React reconciles.
- Storage APIs (`localStorage`) **throw** in an opaque origin. Tell the model.
