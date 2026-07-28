import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const webRoot = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const BACKEND = process.env.BACKEND_ORIGIN ?? 'http://localhost:8787';
const MOCK = process.env.VITE_MOCK === '1';

/**
 * In mock mode there is no backend, so serve the real manual page PNGs from the
 * repo's kb/ directory. These are the actual extracted manual pages — not
 * fabricated data — so the multimodal UI can be demoed without a server.
 */
const mockKbStatic = (): Plugin => ({
  name: 'mock-kb-static',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const url = req.url ?? '';
      // /api/page-image/:doc/:page  ->  kb/pages/<doc>-<NN>.png
      const m = /^\/api\/page-image\/([^/?]+)\/(\d+)/.exec(url);
      const rel = m
        ? `kb/pages/${decodeURIComponent(m[1]!)}-${String(m[2]).padStart(2, '0')}.png`
        : url.startsWith('/kb/')
          ? decodeURIComponent(url.split('?')[0]!).slice(1)
          : null;
      if (!rel) return next();

      const file = path.join(repoRoot, rel);
      if (!file.startsWith(path.join(repoRoot, 'kb')) || !fs.existsSync(file)) {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      fs.createReadStream(file).pipe(res);
    });
  },
});

export default defineConfig({
  root: webRoot,
  plugins: [react(), ...(MOCK ? [mockKbStatic()] : [])],
  server: {
    port: 5173,
    strictPort: true,
    proxy: MOCK
      ? undefined
      : {
          '/api': { target: BACKEND, changeOrigin: true },
          '/kb': { target: BACKEND, changeOrigin: true },
        },
  },
  preview: { port: 5174 },
  build: {
    outDir: `${repoRoot}dist/web`,
    emptyOutDir: true,
    sourcemap: true,
  },
});
