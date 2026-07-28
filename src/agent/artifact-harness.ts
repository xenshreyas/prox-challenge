/**
 * Wraps model-authored artifact source into a standalone HTML document that runs
 * inside a sandboxed iframe with no build step.
 *
 * Why a harness at all: asking the model to emit a complete, correct HTML
 * document with CDN script tags, a Babel transform, and a React root every single
 * time is a reliable source of broken artifacts. Instead the model writes only
 * the interesting part — a component, a body, or an SVG — and we supply the
 * boilerplate, the theme, and the error handling deterministically.
 *
 * Security: the host renders this via `srcdoc` in an iframe with
 * `sandbox="allow-scripts"` and no `allow-same-origin`. Omitting
 * `allow-same-origin` is the important bit — it forces an opaque origin, so
 * artifact code cannot touch the host's DOM, cookies, or localStorage even
 * though it can execute JS. Combined with generated (untrusted) code, that is
 * the same posture Claude's own artifact sandbox takes.
 */

import type { ArtifactKind } from './events.js';

const REACT_CDN = 'https://esm.sh/react@19.0.0';
// `?external=react` stops esm.sh bundling a second copy of React into react-dom.
// Two React instances in one document is the classic "Invalid hook call" cause.
const REACT_DOM_CDN = 'https://esm.sh/react-dom@19.0.0/client?external=react';
const BABEL_CDN = 'https://unpkg.com/@babel/standalone@7.26.4/babel.min.js';

/**
 * Shared visual baseline. Artifacts are told to use a dark industrial theme; the
 * harness makes that the default so even a lazily-styled artifact looks correct
 * and matches the host chrome.
 */
const BASE_CSS = `
:root {
  color-scheme: dark;
  --bg: #0f1216;
  --panel: #171b21;
  --panel-2: #1e242c;
  --line: #2b333d;
  --text: #e6edf3;
  --muted: #9aa7b4;
  --accent: #ff8a3d;
  --accent-2: #ffb066;
  --ok: #3fb950;
  --warn: #d29922;
  --danger: #f85149;
  --radius: 10px;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); }
body {
  font: 15px/1.55 ui-sans-serif, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  padding: 18px;
  -webkit-font-smoothing: antialiased;
}
h1, h2, h3 { line-height: 1.25; margin: 0 0 .5em; font-weight: 650; letter-spacing: -0.01em; }
h1 { font-size: 1.35rem; } h2 { font-size: 1.1rem; } h3 { font-size: .98rem; }
p { margin: 0 0 .8em; }
a { color: var(--accent-2); }
button, .btn {
  font: inherit; font-weight: 600; color: #12161b;
  background: var(--accent); border: 0; border-radius: var(--radius);
  padding: 9px 14px; cursor: pointer; transition: filter .12s ease;
}
button:hover, .btn:hover { filter: brightness(1.08); }
button:disabled { opacity: .5; cursor: not-allowed; }
button.secondary {
  background: var(--panel-2); color: var(--text); border: 1px solid var(--line);
}
input, select, textarea {
  font: inherit; color: var(--text); background: var(--panel-2);
  border: 1px solid var(--line); border-radius: var(--radius); padding: 9px 11px; width: 100%;
}
input[type="range"] { padding: 0; background: transparent; border: 0; accent-color: var(--accent); }
label { display: block; font-size: .82rem; color: var(--muted); margin-bottom: 5px;
  text-transform: uppercase; letter-spacing: .06em; font-weight: 600; }
.card { background: var(--panel); border: 1px solid var(--line);
  border-radius: 14px; padding: 16px; margin-bottom: 14px; }
.row { display: flex; gap: 12px; flex-wrap: wrap; }
.row > * { flex: 1 1 160px; min-width: 0; }
.grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }
table { width: 100%; border-collapse: collapse; font-size: .92rem; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); }
th { color: var(--muted); font-size: .78rem; text-transform: uppercase; letter-spacing: .06em; }
.metric { font-variant-numeric: tabular-nums; font-size: 2rem; font-weight: 700; color: var(--accent-2); }
.muted { color: var(--muted); }
.cite { color: var(--muted); font-size: .8rem; }
.badge { display: inline-block; padding: 3px 9px; border-radius: 999px;
  font-size: .75rem; font-weight: 700; background: var(--panel-2); border: 1px solid var(--line); }
.badge.ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 45%, transparent); }
.badge.warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 45%, transparent); }
.badge.danger { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 45%, transparent); }
svg { max-width: 100%; height: auto; }
#artifact-error {
  display: none; white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12.5px; color: var(--danger); background: rgba(248,81,73,.08);
  border: 1px solid rgba(248,81,73,.35); border-radius: var(--radius); padding: 12px; margin-top: 12px;
}
@media (max-width: 480px) { body { padding: 12px; } .metric { font-size: 1.6rem; } }
`;

/**
 * Reports runtime failures inside the artifact instead of rendering a blank
 * white box, and forwards them to the host so the UI can offer a retry.
 */
const ERROR_TRAP = `
window.__artifactFailed = false;
window.__artifactReady = false;
function __showErr(label, err) {
  window.__artifactFailed = true;
  // Babel syntax errors carry a code frame in .message; that is far more useful
  // than the minified CDN stack, so prefer it and cap the length either way.
  var msg;
  if (err && typeof err.message === 'string' && err.message.indexOf('\\n') !== -1) msg = err.message;
  else if (err && (err.stack || err.message)) msg = err.stack || err.message;
  else msg = String(err);
  if (msg.length > 1200) msg = msg.slice(0, 1200) + '\\n…';
  var el = document.getElementById('artifact-error');
  if (el) { el.style.display = 'block'; el.textContent = label + ': ' + msg; }
  try { parent.postMessage({ source: 'artifact', type: 'error', message: label + ': ' + msg }, '*'); } catch (_) {}
}
function __ready() {
  window.__artifactReady = true;
  try { parent.postMessage({ source: 'artifact', type: 'ready' }, '*'); } catch (_) {}
}
window.addEventListener('error', function (e) { __showErr('Runtime error', e.error || e.message); });
window.addEventListener('unhandledrejection', function (e) { __showErr('Unhandled rejection', e.reason); });
`;

/** Tells the host how tall the artifact actually is, so the iframe can size itself. */
const RESIZE_REPORTER = `
(function () {
  function report() {
    var h = Math.max(
      document.body.scrollHeight, document.documentElement.scrollHeight,
      document.body.offsetHeight, document.documentElement.offsetHeight
    );
    try { parent.postMessage({ source: 'artifact', type: 'resize', height: h }, '*'); } catch (_) {}
  }
  window.addEventListener('load', function () {
    report();
    // Static (html/diagram) artifacts have no mount step of their own, so load
    // is the moment they are "ready".
    if (!window.__artifactReady && !document.getElementById('root')) __ready();
  });
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(report).observe(document.body);
  setInterval(report, 700);
})();
`;

/**
 * localStorage / sessionStorage throw a SecurityError in an opaque origin
 * (which is exactly what `sandbox="allow-scripts"` without `allow-same-origin`
 * gives us). Model-authored artifacts reach for them constantly to "remember"
 * settings, and the resulting throw would blank the panel. Swap in an in-memory
 * implementation so the artifact just works and nothing persists.
 */
const STORAGE_SHIM = `
(function () {
  function mem() {
    var m = Object.create(null);
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(m, String(k)) ? m[String(k)] : null; },
      setItem: function (k, v) { m[String(k)] = String(v); },
      removeItem: function (k) { delete m[String(k)]; },
      clear: function () { m = Object.create(null); },
      key: function (i) { return Object.keys(m)[i] !== undefined ? Object.keys(m)[i] : null; },
      get length() { return Object.keys(m).length; },
    };
  }
  ['localStorage', 'sessionStorage'].forEach(function (name) {
    var ok = false;
    try { var s = window[name]; s.setItem('__probe__', '1'); s.removeItem('__probe__'); ok = true; } catch (_) { ok = false; }
    if (!ok) { try { Object.defineProperty(window, name, { value: mem(), configurable: true }); } catch (_) {} }
  });
})();
`;

/**
 * Compiles and mounts the artifact source at runtime.
 *
 * Everything is defensive on purpose — this is the code path that decides
 * whether a slightly-wrong model output shows a readable message or a blank
 * white box:
 *  - Babel is tried with the plain react preset first, then again with the
 *    TypeScript preset, because models emit `useState<number>(0)` into what is
 *    nominally a .jsx artifact and the react preset alone cannot parse it.
 *  - The mounted component is looked up by name with `App` preferred but any
 *    PascalCase declaration accepted.
 *  - Render-time throws are caught by an error boundary so a broken component
 *    prints its stack instead of unmounting the tree silently.
 */
const REACT_BOOT = `
(function () {
  function boot() {
    var React = window.React;
    var src = window.__ARTIFACT_SRC || '';
    var names = window.__ARTIFACT_NAMES || [];

    if (!window.Babel) { __showErr('Artifact runtime unavailable', new Error('The JSX compiler failed to load.')); return; }

    var compiled = null, firstErr = null;
    // Order matters. \`useState<number>(0)\` is not a syntax ERROR to the react
    // preset — it parses as a chain of comparisons — so the react attempt
    // "succeeds" and emits code referencing a bare identifier \`number\`, which
    // then throws "number is not defined" at render time. Trying react first and
    // breaking on success therefore never reaches the TypeScript fallback for
    // exactly the input that needs it. So sniff for TS-only syntax and put the
    // TypeScript preset first when we see it.
    var looksTypeScript =
      /\\b(useState|useRef|useMemo|useCallback|useReducer)\\s*<[^<>()]+>\\s*\\(/.test(src) ||
      /:\\s*(string|number|boolean|any|unknown|void|null|undefined)\\b/.test(src) ||
      /\\b(interface|type)\\s+[A-Z][A-Za-z0-9_]*\\s*[={]/.test(src) ||
      /\\bas\\s+(const|string|number|boolean)\\b/.test(src);

    var attempts = looksTypeScript
      ? [
          { presets: ['react', ['typescript', { isTSX: true, allExtensions: true }]], filename: 'artifact.tsx' },
          { presets: ['react'], filename: 'artifact.jsx' }
        ]
      : [
          { presets: ['react'], filename: 'artifact.jsx' },
          { presets: ['react', ['typescript', { isTSX: true, allExtensions: true }]], filename: 'artifact.tsx' }
        ];
    for (var i = 0; i < attempts.length; i++) {
      try { compiled = window.Babel.transform(src, attempts[i]).code; break; }
      catch (e) { if (!firstErr) firstErr = e; }
    }
    if (compiled === null) { __showErr('Could not compile the artifact', firstErr); return; }

    var Component = null;
    try {
      var lookup = names.map(function (n) { return 'typeof ' + n + ' === "function" ? ' + n + ' : '; }).join('');
      var factory = new Function('React',
        'var useState=React.useState,useEffect=React.useEffect,useMemo=React.useMemo,' +
        'useRef=React.useRef,useCallback=React.useCallback,useReducer=React.useReducer,' +
        'useLayoutEffect=React.useLayoutEffect,useContext=React.useContext,' +
        'Fragment=React.Fragment,createElement=React.createElement,memo=React.memo;\\n' +
        compiled + '\\nreturn (' + lookup + 'null);');
      Component = factory(React);
    } catch (e) { __showErr('Artifact failed to initialise', e); return; }

    if (typeof Component !== 'function') {
      __showErr('No component to render', new Error(
        'The artifact did not define a React component. Looked for: ' + (names.join(', ') || '(none found)') + '.'));
      return;
    }

    // Class component written without JSX so it needs no compile step itself.
    function Boundary(props) { React.Component.call(this, props); this.state = { err: null }; }
    Boundary.prototype = Object.create(React.Component.prototype);
    Boundary.prototype.constructor = Boundary;
    Boundary.getDerivedStateFromError = function (err) { return { err: err }; };
    Boundary.prototype.componentDidCatch = function (err) { __showErr('Artifact crashed while rendering', err); };
    Boundary.prototype.render = function () {
      return this.state.err ? null : React.createElement(Component, null);
    };

    try {
      window.createRoot(document.getElementById('root')).render(React.createElement(Boundary));
      __ready();
    } catch (e) { __showErr('Artifact failed to mount', e); }
  }
  if (window.React) boot(); else window.addEventListener('react-ready', boot);
})();
`;

/** JSON, escaped so it cannot terminate the enclosing <script> or break out via U+2028/9. */
function jsonForScript(value: unknown): string {
	return JSON.stringify(value)
		.replace(/</g, '\\u003c')
		.replace(/>/g, '\\u003e')
		.replace(/\u2028/g, '\\u2028')
		.replace(/\u2029/g, '\\u2029');
}

/** A script that does nothing but surface a harness-level failure in the error box. */
function failScript(message: string): string {
	return `<script>__showErr('Artifact could not be rendered', new Error(${jsonForScript(message)}));</script>`;
}

function shell(bodyHtml: string, scripts: string): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Artifact</title>
<style>${BASE_CSS}</style>
</head>
<body>
${bodyHtml}
<div id="artifact-error"></div>
<script>${STORAGE_SHIM}${ERROR_TRAP}</script>
${scripts}
<script>${RESIZE_REPORTER}</script>
</body>
</html>`;
}

/**
 * Removes markdown fences the model wraps code in out of habit.
 *
 * Handles the two shapes that actually show up: a fenced block that *is* the
 * whole payload (```jsx ... ```), and prose-plus-fence where the code is one
 * block inside a longer string. Backtick counts of 3+ and any info string are
 * accepted, and an unterminated opening fence is tolerated.
 */
function stripFence(code: string): string {
	const out = code.trim();
	// Whole payload is a single fenced block.
	const whole = /^(`{3,})[^\n]*\n([\s\S]*?)\n?\1\s*$/.exec(out);
	if (whole) return (whole[2] ?? '').trim();
	// Fenced block embedded in prose — take the first one.
	const embedded = /(`{3,})[a-z0-9+-]*\s*\n([\s\S]*?)\n\1/i.exec(out);
	if (embedded) return (embedded[2] ?? '').trim();
	// Unterminated opening fence.
	const open = /^`{3,}[a-z0-9+-]*\s*\n([\s\S]*)$/i.exec(out);
	if (open) return (open[1] ?? '').replace(/`{3,}\s*$/, '').trim();
	return out;
}

/**
 * Strips things the model adds out of habit that would break the harness:
 * markdown fences, import statements (the harness provides React), and any
 * self-mounting `createRoot(...).render(...)` call.
 *
 * Note we deliberately do NOT strip TypeScript annotations here — Babel is
 * asked to parse TS as a fallback instead, which is far more reliable than
 * regexing types out of source.
 */
function cleanReactSource(code: string): string {
	let out = stripFence(code);
	// Multi-line imports: `import {\n a,\n b\n} from 'x';`
	out = out.replace(/^[ 	]*import\s+[\s\S]*?from\s*['"][^'"]*['"]\s*;?[ 	]*$/gm, '');
	// Single-line / side-effect / bare imports.
	out = out.replace(/^[ 	]*import\s+[^\n;]*;?[ 	]*$/gm, '');
	out = out.replace(/^[ 	]*(?:const|let|var)\s*\{[^}]*\}\s*=\s*require\([^)]*\)\s*;?[ 	]*$/gm, '');
	out = out.replace(/^\s*(?:const|let|var)\s*\{[^}]*\}\s*=\s*React\s*;?\s*$/gm, '');
	// Self-mounting: ReactDOM.render / createRoot(...).render(...)
	out = out.replace(
		/^[ 	]*(?:const\s+\w+\s*=\s*)?(?:ReactDOM|ReactDOMClient|createRoot|root)\b[\s\S]*?\.render\s*\([\s\S]*?\)\s*;?[ 	]*$/gm,
		'',
	);
	out = out.replace(/^[ 	]*(?:const|let|var)\s+\w+\s*=\s*(?:ReactDOM\.)?createRoot\s*\([^)]*\)\s*;?[ 	]*$/gm, '');
	// `export default function App()` -> `function App()`; `export default App;` -> `App;`
	out = out.replace(/^[ 	]*export\s+default\s+/gm, '');
	out = out.replace(/^[ 	]*export\s+(?=(?:const|let|var|function|class|async)\b)/gm, '');
	out = out.replace(/^[ 	]*export\s*\{[^}]*\}\s*;?[ 	]*$/gm, '');
	return out.trim();
}

/**
 * Best-effort list of component identifiers declared in the source, most likely
 * first. Models routinely name the component after the thing it does
 * (`DutyCycleCalculator`) instead of `App`, so the harness mounts whatever it
 * can find rather than failing.
 */
export function guessComponentNames(code: string): string[] {
	const names: string[] = [];
	const push = (n: string | undefined) => {
		if (n && !names.includes(n)) names.push(n);
	};
	// A bare trailing `Foo;` (what `export default Foo;` collapses to) is the
	// strongest signal of intent.
	push(/(?:^|\n)[ 	]*([A-Z][A-Za-z0-9_]*)\s*;?\s*$/.exec(code)?.[1]);
	push('App');
	const decl = /(?:^|\n)[ 	]*(?:function|class|const|let|var)\s+([A-Z][A-Za-z0-9_]*)/g;
	let m: RegExpExecArray | null;
	while ((m = decl.exec(code)) !== null) push(m[1]);
	return names;
}

export interface WrappedArtifact {
	html: string;
	mimeType: 'text/html' | 'application/vnd.ant.react' | 'image/svg+xml';
}

/**
 * Turns model-authored artifact source into a runnable standalone document.
 *
 * @param kind  'react' — component source defining `App`
 *              'html'  — body markup (may include its own <style>/<script>)
 *              'diagram' — a complete <svg> element
 */
export function wrapArtifact(kind: ArtifactKind, code: string): WrappedArtifact {
	if (kind === 'react') {
		const src = cleanReactSource(code);
		const names = guessComponentNames(src);

		if (!src) {
			return {
				html: shell('<div id="root"></div>', failScript('The artifact source was empty.')),
				mimeType: 'application/vnd.ant.react',
			};
		}

		// The source is passed to the page as *data*, not as inline script text.
		// That matters: a syntax error in model output then surfaces as a
		// catchable Babel exception we can print, instead of killing the whole
		// inline <script> and leaving a blank white box.
		const scripts = `
<script type="importmap">
{"imports": {"react": "${REACT_CDN}", "react-dom/client": "${REACT_DOM_CDN}"}}
</script>
<script src="${BABEL_CDN}" onerror="__showErr('Artifact runtime unavailable', new Error('Could not load the JSX compiler from the CDN.'))"></script>
<script type="module">
  import React from "react";
  import { createRoot } from "react-dom/client";
  window.React = React;
  window.createRoot = createRoot;
  window.dispatchEvent(new Event("react-ready"));
</script>
<script>
window.__ARTIFACT_SRC = ${jsonForScript(src)};
window.__ARTIFACT_NAMES = ${jsonForScript(names)};
${REACT_BOOT}
</script>`;
		return { html: shell('<div id="root"></div>', scripts), mimeType: 'application/vnd.ant.react' };
	}

	if (kind === 'diagram') {
		const svg = stripFence(code);
		if (!svg) return { html: shell('', failScript('The diagram source was empty.')), mimeType: 'image/svg+xml' };
		if (!/<svg[\s>]/i.test(svg)) {
			return {
				html: shell(
					`<div class="card" style="text-align:center">${svg}</div>`,
					failScript('The diagram source did not contain an <svg> element.'),
				),
				mimeType: 'image/svg+xml',
			};
		}
		return {
			html: shell(`<div class="card" style="text-align:center">${svg}</div>`, ''),
			mimeType: 'image/svg+xml',
		};
	}

	const body = stripFence(code);
	if (!body) return { html: shell('', failScript('The artifact source was empty.')), mimeType: 'text/html' };
	return { html: shell(body, ''), mimeType: 'text/html' };
}
