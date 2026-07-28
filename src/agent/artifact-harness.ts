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
function __showErr(label, err) {
  var el = document.getElementById('artifact-error');
  var msg = (err && (err.stack || err.message)) || String(err);
  if (el) { el.style.display = 'block'; el.textContent = label + ': ' + msg; }
  try { parent.postMessage({ source: 'artifact', type: 'error', message: msg }, '*'); } catch (_) {}
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
  window.addEventListener('load', report);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(report).observe(document.body);
  setInterval(report, 700);
})();
`;

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
<script>${ERROR_TRAP}</script>
${scripts}
<script>${RESIZE_REPORTER}</script>
</body>
</html>`;
}

/**
 * Strips things the model adds out of habit that would break the harness:
 * markdown fences, import statements (the harness provides React), and any
 * self-mounting `createRoot(...).render(...)` call.
 */
function cleanReactSource(code: string): string {
	let out = code.trim();
	out = out.replace(/^```(?:jsx?|tsx?|javascript|react)?\s*\n/i, '').replace(/\n```\s*$/i, '');
	out = out.replace(/^\s*import\s+[^\n;]*?;?\s*$/gm, '');
	out = out.replace(/^\s*(?:const|let|var)\s*\{[^}]*\}\s*=\s*React\s*;?\s*$/gm, '');
	out = out.replace(
		/^\s*(?:ReactDOM|createRoot)[\s\S]*?\.render\s*\([\s\S]*?\)\s*;?\s*$/gm,
		'',
	);
	out = out.replace(/^\s*export\s+default\s+/gm, '');
	out = out.replace(/^\s*export\s+/gm, '');
	return out.trim();
}

function stripFence(code: string): string {
	return code
		.trim()
		.replace(/^```[a-z]*\s*\n/i, '')
		.replace(/\n```\s*$/i, '')
		.trim();
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
		// Hooks are pre-destructured into scope so the model can write either
		// `useState(...)` or `React.useState(...)` without it mattering.
		const scripts = `
<script type="importmap">
{"imports": {"react": "${REACT_CDN}", "react-dom/client": "${REACT_DOM_CDN}"}}
</script>
<script src="${BABEL_CDN}"></script>
<script type="module">
  import React from "react";
  import { createRoot } from "react-dom/client";
  window.React = React;
  window.createRoot = createRoot;
  window.dispatchEvent(new Event("react-ready"));
</script>
<script type="text/babel" data-presets="react">
  const boot = () => {
    try {
      const React = window.React;
      const { useState, useEffect, useMemo, useRef, useCallback, useReducer } = React;
      ${src}
      if (typeof App === "undefined") throw new Error("Artifact did not define a component named App.");
      window.createRoot(document.getElementById("root")).render(React.createElement(App));
    } catch (err) { __showErr("Artifact error", err); }
  };
  if (window.React) boot(); else window.addEventListener("react-ready", boot);
</script>`;
		return { html: shell('<div id="root"></div>', scripts), mimeType: 'application/vnd.ant.react' };
	}

	if (kind === 'diagram') {
		const svg = stripFence(code);
		return {
			html: shell(`<div class="card" style="text-align:center">${svg}</div>`, ''),
			mimeType: 'image/svg+xml',
		};
	}

	return { html: shell(stripFence(code), ''), mimeType: 'text/html' };
}
