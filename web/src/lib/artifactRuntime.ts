import type { Artifact } from '../types';

/**
 * Builds the `srcdoc` for the artifact iframe.
 *
 * The iframe runs with sandbox="allow-scripts" ONLY — no allow-same-origin —
 * so artifact code is in an opaque origin: it cannot touch our DOM, cookies,
 * localStorage, or make same-origin requests back into the app. React,
 * ReactDOM and Babel-standalone come from a CDN so LLM-authored artifacts need
 * no build step; JSX is transpiled in the browser at load time.
 */

const CDN = {
  react: 'https://unpkg.com/react@18/umd/react.production.min.js',
  reactDom: 'https://unpkg.com/react-dom@18/umd/react-dom.production.min.js',
  babel: 'https://unpkg.com/@babel/standalone@7/babel.min.js',
};

const BASE_CSS = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #0d1117; }
  body {
    font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    color: #e6edf3; padding: 20px; line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }
  a { color: #ff8a3d; }
  button { font-family: inherit; }
  input, select, textarea { font-family: inherit; color: inherit; }
  pre, code { font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, monospace; }
  #root { max-width: 900px; margin: 0 auto; }
  .artifact-error {
    font-family: 'JetBrains Mono', monospace; font-size: 12.5px; line-height: 1.6;
    color: #ffa198; background: rgba(248,81,73,.09);
    border: 1px solid rgba(248,81,73,.4); border-radius: 10px; padding: 14px 16px;
    white-space: pre-wrap;
  }
`;

const ERROR_TRAP = `
  function showError(label, err) {
    var box = document.createElement('pre');
    box.className = 'artifact-error';
    var msg = (err && (err.stack || err.message)) || String(err);
    if (msg.length > 1200) msg = msg.slice(0, 1200) + '\\n…';
    box.textContent = label + '\\n\\n' + msg;
    document.body.appendChild(box);
    // Mirror to the host so ArtifactPanel can show its inline failure state
    // instead of just a red box buried inside the frame.
    try { parent.postMessage({ source: 'artifact', type: 'error', message: label + ': ' + msg }, '*'); } catch (e) {}
  }
  function reportReady() { try { parent.postMessage({ source: 'artifact', type: 'ready' }, '*'); } catch (e) {} }
  window.addEventListener('error', function (e) { showError('Runtime error', e.error || e.message); });
  window.addEventListener('unhandledrejection', function (e) { showError('Unhandled promise rejection', e.reason); });
  // Keep the host iframe sized to the content.
  (function () {
    function report() {
      var h = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight,
                       document.body.offsetHeight, document.documentElement.offsetHeight);
      try { parent.postMessage({ source: 'artifact', type: 'resize', height: h }, '*'); } catch (e) {}
    }
    window.addEventListener('load', report);
    if (typeof ResizeObserver !== 'undefined') {
      window.addEventListener('DOMContentLoaded', function () { new ResizeObserver(report).observe(document.body); });
    }
    setInterval(report, 700);
  })();
`;

/** A complete document — already wrapped by the server-side artifact harness. */
function isFullDocument(code: string): boolean {
  return /^\s*(<!doctype\s+html|<html[\s>])/i.test(code);
}

function isReactArtifact(a: Artifact): boolean {
  // Checked first, and deliberately ahead of the mimeType test: the server-side
  // harness emits an already-wrapped standalone document while still labelling
  // it application/vnd.ant.react. Re-wrapping that as component source would
  // hand Babel a `<!doctype html>` and blow up every server artifact.
  if (isFullDocument(a.code)) return false;
  if (/react|jsx|tsx|javascript/i.test(a.mimeType)) return true;
  return /(export\s+default|function\s+\w+\s*\(|=>\s*\()/.test(a.code);
}

/** Strip ESM imports (React et al. are provided as globals) and normalise the default export. */
function prepareReactSource(code: string): string {
  let src = code
    // drop all import statements; React/ReactDOM/hooks are injected as globals
    .replace(/^\s*import\s+[^;]*?from\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^\s*import\s+['"][^'"]+['"];?\s*$/gm, '');

  // `export default function Foo` / `export default class Foo` -> keep the name
  src = src.replace(/export\s+default\s+(function|class)\s+/g, '$1 ');
  // `export default Foo;` -> assignment to the well-known slot
  src = src.replace(/export\s+default\s+/g, '__ARTIFACT_DEFAULT__ = ');
  // strip remaining named exports
  src = src.replace(/^\s*export\s+(?=(const|let|var|function|class)\s)/gm, '');

  return src;
}

function escapeForScript(s: string): string {
  // Prevent an inline </script> in artifact code from terminating our tag.
  return s.replace(/<\/script/gi, '<\\/script');
}

export function buildArtifactSrcDoc(artifact: Artifact): string {
  if (!isReactArtifact(artifact)) {
    const code = artifact.code;
    // Already a complete document. If it came from our server-side harness it
    // has its own theme, error trap and resize reporter — leave it alone.
    if (/id=["']artifact-error["']/.test(code)) return code;
    // Full HTML document from somewhere else: inject our base CSS + error trap.
    if (/<html[\s>]/i.test(code)) {
      const inject = `<style>${BASE_CSS}</style><script>${ERROR_TRAP}<\/script>`;
      if (/<head[\s>]/i.test(code)) {
        return code.replace(/<head([^>]*)>/i, `<head$1>${inject}`);
      }
      return code.replace(/<html([^>]*)>/i, `<html$1><head>${inject}</head>`);
    }
    // HTML fragment.
    return `<!doctype html><html><head><meta charset="utf-8">
<style>${BASE_CSS}</style><script>${ERROR_TRAP}<\/script></head>
<body>${code}</body></html>`;
  }

  const source = escapeForScript(prepareReactSource(artifact.code));

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>${BASE_CSS}</style>
<script>${ERROR_TRAP}<\/script>
<script src="${CDN.react}" crossorigin><\/script>
<script src="${CDN.reactDom}" crossorigin><\/script>
<script src="${CDN.babel}" crossorigin><\/script>
</head>
<body>
<div id="root"></div>
<script type="text/babel" data-presets="react">
(function () {
  if (!window.React || !window.ReactDOM) {
    showError('Artifact runtime unavailable', new Error('React could not be loaded from the CDN. Check your network connection.'));
    return;
  }
  var React = window.React;
  var ReactDOM = window.ReactDOM;
  var useState = React.useState, useEffect = React.useEffect, useMemo = React.useMemo,
      useCallback = React.useCallback, useRef = React.useRef, useReducer = React.useReducer,
      useLayoutEffect = React.useLayoutEffect, useContext = React.useContext,
      Fragment = React.Fragment, createElement = React.createElement, memo = React.memo;
  var __ARTIFACT_DEFAULT__ = null;

  // --- begin artifact source (function scope, so declarations are hoisted here) ---
${source}
  // --- end artifact source ---

  var Component = __ARTIFACT_DEFAULT__;
  if (typeof Component !== 'function') {
    // Fall back to the first PascalCase component declared in scope.
    var names = ${JSON.stringify(guessComponentNames(artifact.code))};
    for (var i = 0; i < names.length; i++) {
      try {
        var candidate = eval(names[i]);
        if (typeof candidate === 'function') { Component = candidate; break; }
      } catch (e) { /* not in scope */ }
    }
  }
  if (typeof Component !== 'function') {
    showError('No component found', new Error('The artifact did not export a default React component.'));
    return;
  }

  try {
    var root = ReactDOM.createRoot(document.getElementById('root'));
    root.render(React.createElement(Component));
    reportReady();
  } catch (err) {
    showError('Render failed', err);
  }
})();
<\/script>
</body>
</html>`;
}

function guessComponentNames(code: string): string[] {
  const names = new Set<string>();
  const re = /(?:function|const|let|var|class)\s+([A-Z][A-Za-z0-9_]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) names.add(m[1]!);
  return [...names];
}

export function artifactLabel(mimeType: string): string {
  if (/react|jsx/i.test(mimeType)) return 'REACT';
  if (/html/i.test(mimeType)) return 'HTML';
  if (/svg/i.test(mimeType)) return 'SVG';
  return mimeType.split('/').pop()?.toUpperCase() ?? 'CODE';
}
