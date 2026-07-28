/**
 * HTTP transport: serves the built frontend, streams agent responses over SSE,
 * and serves manual page images.
 *
 * SSE rather than WebSockets because the traffic is strictly one-way (server →
 * browser) for the duration of a turn, and SSE survives proxies and reconnects
 * without extra machinery. Each `AgentEvent` becomes a named SSE event so the
 * client can switch on `event:` instead of sniffing payload shapes.
 */

import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';

import 'dotenv/config';
import express, { type Request, type Response } from 'express';

import { ask, warmUp } from '../agent/agent.js';
import { loadKB, KB_PAGES_DIR, REPO_ROOT, resolvePageImage } from '../kb/search.js';

const PORT = Number(process.env.PORT ?? 8787);

const app = express();
app.use(express.json({ limit: '12mb' })); // headroom for user-uploaded photos

/** Health + configuration status, so the UI can explain a missing key up front. */
app.get('/api/health', (_req, res) => {
	let kbStats: { pages: number; chunks: number; figures: number } | null = null;
	try {
		const kb = loadKB();
		kbStats = {
			pages: kb.pages.length,
			chunks: kb.chunks.length,
			figures: kb.chunks.filter((c) => c.kind === 'figure').length,
		};
	} catch {
		kbStats = null;
	}
	const usingProxy = Boolean(process.env.ANTHROPIC_BASE_URL);
	res.json({
		ok: true,
		configured: Boolean(process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY),
		usingProxy,
		kb: kbStats,
	});
});

/** Serves a manual page raster. Path params are validated, never interpolated raw. */
app.get('/api/page-image/:doc/:page', (req, res) => {
	const doc = String(req.params.doc);
	const page = Number(req.params.page);
	if (!/^[a-z-]+$/.test(doc) || !Number.isInteger(page) || page < 1 || page > 999) {
		res.status(400).json({ error: 'Bad page reference' });
		return;
	}
	const file = resolvePageImage(doc, page);
	if (!file || !file.startsWith(KB_PAGES_DIR)) {
		res.status(404).json({ error: 'Page image not found' });
		return;
	}
	res.type('image/png');
	res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
	createReadStream(file).pipe(res);
});

/** Chat endpoint. Streams `AgentEvent`s as named SSE events. */
app.post('/api/chat', async (req: Request, res: Response) => {
	const { question, sessionId, voltage, image } = req.body ?? {};
	if (typeof question !== 'string' || !question.trim()) {
		res.status(400).json({ error: 'question is required' });
		return;
	}

	res.setHeader('Content-Type', 'text/event-stream');
	res.setHeader('Cache-Control', 'no-cache, no-transform');
	res.setHeader('Connection', 'keep-alive');
	res.setHeader('X-Accel-Buffering', 'no'); // defeat nginx buffering
	res.flushHeaders();

	const send = (event: string, data: unknown) => {
		res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	};

	// Abort the agent if the browser goes away mid-turn, so we stop paying for
	// tokens nobody will read.
	const ac = new AbortController();
	req.on('close', () => ac.abort());

	// Comment frames keep intermediaries from timing out during long tool turns.
	const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15000);

	try {
		for await (const event of ask({
			question,
			sessionId: typeof sessionId === 'string' ? sessionId : null,
			voltage: voltage === 120 || voltage === 240 ? voltage : null,
			image: image ?? null,
			signal: ac.signal,
		})) {
			const { type, ...payload } = event;
			send(type, payload);
		}
	} catch (err) {
		send('error', { message: err instanceof Error ? err.message : String(err) });
		send('done', { sessionId: null });
	} finally {
		clearInterval(keepAlive);
		res.end();
	}
});

// Raw manual page assets (used by the frontend for lightbox/zoom).
app.use('/kb/pages', express.static(KB_PAGES_DIR, { maxAge: '1y', immutable: true }));

// Production: serve the built SPA. In dev, Vite serves it on 5173 and proxies here.
const CLIENT_DIST = path.join(REPO_ROOT, 'dist', 'web');
if (existsSync(CLIENT_DIST)) {
	app.use(express.static(CLIENT_DIST));
	app.get('*', (_req, res) => res.sendFile(path.join(CLIENT_DIST, 'index.html')));
}

app.listen(PORT, () => {
	const configured = Boolean(process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY);
	console.log(`\n  Vulcan OmniPro 220 agent  →  http://localhost:${PORT}`);
	try {
		const kb = loadKB();
		console.log(
			`  Knowledge base: ${kb.pages.length} pages, ${kb.chunks.length} chunks, ` +
				`${kb.chunks.filter((c) => c.kind === 'figure').length} figures`,
		);
	} catch {
		console.warn(`  ⚠ No knowledge base at kb/index.json — run: npm run kb:build`);
	}
	if (process.env.ANTHROPIC_BASE_URL) {
		console.log(`  Model endpoint: ${process.env.ANTHROPIC_BASE_URL} (proxy)`);
	}
	if (!configured) {
		console.warn(
			`  ⚠ No API key set. Copy .env.example to .env and add ANTHROPIC_API_KEY.\n` +
				`    (Repo root: ${REPO_ROOT})`,
		);
	}
	void warmUp();
});
