/**
 * copilot-proxy.ts
 *
 * A minimal, local Anthropic Messages API (`POST /v1/messages`) compatible shim
 * that is backed by the GitHub Copilot CLI (`copilot -p ...`).
 *
 * Purpose: let `@anthropic-ai/claude-agent-sdk` run on a machine that has no
 * ANTHROPIC_API_KEY but IS authenticated to GitHub Copilot. The SDK honours
 * ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN, so pointing it at this process
 * keeps the SDK as the genuine foundation while executing on Copilot credits.
 *
 * SECURITY: this file never reads, prints, or forwards any credential. It only
 * shells out to the `copilot` binary and lets that binary manage its own auth.
 *
 * Run directly:  npx tsx src/shim/copilot-proxy.ts
 */

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import type { Request, Response } from 'express';

// ---------------------------------------------------------------------------
// Types (structurally compatible with the Anthropic Messages API subset we use)
// ---------------------------------------------------------------------------

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: unknown;
}

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id?: string; content?: unknown; is_error?: boolean }
  | { type: string; [k: string]: unknown };

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

interface MessagesRequest {
  model?: string;
  system?: string | Array<{ type: string; text?: string }>;
  messages?: AnthropicMessage[];
  tools?: AnthropicTool[];
  stream?: boolean;
  max_tokens?: number;
}

// ---------------------------------------------------------------------------
// Copilot CLI invocation
// ---------------------------------------------------------------------------

/** Footer lines the CLI appends after the answer; everything from the first of
 *  these (in the trailing block) onwards must be stripped. */
const FOOTER_PREFIXES = ['Changes', 'AI Credits', 'Tokens', 'Resume'];

export function stripCopilotFooter(raw: string): string {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  // Walk backwards over the trailing footer/blank region.
  let cut = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? '';
    const t = line.trim();
    if (t === '') continue;
    if (FOOTER_PREFIXES.some((p) => t.startsWith(p))) {
      cut = i;
      continue;
    }
    break;
  }
  return lines.slice(0, cut).join('\n').trim();
}

const COPILOT_TIMEOUT_MS = Number(process.env.COPILOT_TIMEOUT_MS ?? 180_000);

export function runCopilot(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Run in a scratch dir so the Copilot agent cannot touch the real repo.
    const cwd = mkdtempSync(join(tmpdir(), 'copilot-shim-'));
    const child = spawn('copilot', ['-p', prompt, '--allow-all', '--no-color'], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`copilot CLI timed out after ${COPILOT_TIMEOUT_MS}ms`));
    }, COPILOT_TIMEOUT_MS);

    child.stdout.on('data', (d: Buffer) => {
      out += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString('utf8');
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = stripCopilotFooter(out);
      if (code !== 0 && text === '') {
        reject(new Error(`copilot exited ${code}: ${err.slice(0, 500)}`));
        return;
      }
      resolve(text);
    });
  });
}

// ---------------------------------------------------------------------------
// Prompt serialisation: Anthropic request -> one flat text prompt
// ---------------------------------------------------------------------------

function systemToText(system: MessagesRequest['system']): string {
  if (!system) return '';
  if (typeof system === 'string') return system;
  return system.map((b) => b.text ?? '').filter(Boolean).join('\n\n');
}

function blockToText(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return String((block as { text?: string }).text ?? '');
    case 'tool_use': {
      const b = block as { name: string; input: unknown };
      return `[assistant called tool ${b.name} with input ${safeJson(b.input)}]`;
    }
    case 'tool_result': {
      const b = block as { content?: unknown; is_error?: boolean };
      const body =
        typeof b.content === 'string' ? b.content : safeJson(b.content);
      return `[tool result${b.is_error ? ' (error)' : ''}: ${body}]`;
    }
    default:
      return `[${block.type} block]`;
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function contentToText(content: AnthropicMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(blockToText).filter(Boolean).join('\n');
}

export function buildPrompt(body: MessagesRequest): string {
  const parts: string[] = [];
  const system = systemToText(body.system);
  if (system) {
    parts.push(`=== SYSTEM INSTRUCTIONS ===\n${system}`);
  }

  const tools = body.tools ?? [];
  if (tools.length > 0) {
    const spec = tools
      .map(
        (t) =>
          `- ${t.name}: ${t.description ?? '(no description)'}\n  input_schema: ${safeJson(
            t.input_schema ?? {},
          )}`,
      )
      .join('\n');
    parts.push(
      `=== AVAILABLE TOOLS ===\n${spec}\n\n` +
        `=== RESPONSE PROTOCOL ===\n` +
        `If you want to call one or more of the tools above, reply with ONLY a JSON object, no prose, no markdown fences, exactly of this shape:\n` +
        `{"tool_calls":[{"name":"<tool name>","input":{ ...arguments matching that tool's input_schema... }}]}\n` +
        `Otherwise, reply with plain prose answering the user. Never mix prose and the JSON object.`,
    );
  } else {
    parts.push(
      `=== RESPONSE PROTOCOL ===\nReply with plain prose answering the user. Do not use any tools. Do not create, read or modify any files.`,
    );
  }

  const convo = (body.messages ?? [])
    .map((m) => `${m.role.toUpperCase()}: ${contentToText(m.content)}`)
    .filter((s) => s.trim().length > 0)
    .join('\n\n');
  parts.push(`=== CONVERSATION ===\n${convo}\n\n=== YOUR REPLY ===`);

  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Response parsing: Copilot prose -> Anthropic content blocks
// ---------------------------------------------------------------------------

interface ParsedToolCall {
  name: string;
  input: Record<string, unknown>;
}

/** Extract candidate JSON objects: raw, or inside ```json fences, or the first
 *  balanced {...} region containing "tool_calls". */
function jsonCandidates(text: string): string[] {
  const out: string[] = [];
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) out.push(trimmed);

  const fence = /```(?:json)?\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) {
    const inner = (m[1] ?? '').trim();
    if (inner) out.push(inner);
  }

  const idx = text.indexOf('"tool_calls"');
  if (idx !== -1) {
    // scan left for the opening brace, then match balanced braces
    let start = text.lastIndexOf('{', idx);
    while (start !== -1) {
      let depth = 0;
      let inStr = false;
      let esc = false;
      for (let i = start; i < text.length; i++) {
        const c = text[i]!;
        if (inStr) {
          if (esc) esc = false;
          else if (c === '\\') esc = true;
          else if (c === '"') inStr = false;
          continue;
        }
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}') {
          depth--;
          if (depth === 0) {
            out.push(text.slice(start, i + 1));
            return out;
          }
        }
      }
      start = text.lastIndexOf('{', start - 1);
    }
  }
  return out;
}

export function parseToolCalls(text: string): ParsedToolCall[] | null {
  for (const cand of jsonCandidates(text)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(cand);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const calls = (parsed as { tool_calls?: unknown }).tool_calls;
    if (!Array.isArray(calls) || calls.length === 0) continue;
    const valid: ParsedToolCall[] = [];
    for (const c of calls) {
      if (!c || typeof c !== 'object') continue;
      const name = (c as { name?: unknown }).name;
      if (typeof name !== 'string' || !name) continue;
      const rawInput = (c as { input?: unknown }).input;
      const input =
        rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
          ? (rawInput as Record<string, unknown>)
          : {};
      valid.push({ name, input });
    }
    if (valid.length > 0) return valid;
  }
  return null;
}

function estimateTokens(s: string): number {
  return Math.max(1, Math.ceil(s.length / 4));
}

interface BuiltMessage {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: ContentBlock[];
  stop_reason: 'end_turn' | 'tool_use';
  stop_sequence: null;
  usage: { input_tokens: number; output_tokens: number };
}

export function buildAnthropicMessage(
  model: string,
  promptText: string,
  copilotText: string,
  toolsAvailable: boolean,
): BuiltMessage {
  const calls = toolsAvailable ? parseToolCalls(copilotText) : null;
  let content: ContentBlock[];
  let stop_reason: 'end_turn' | 'tool_use';

  if (calls && calls.length > 0) {
    content = calls.map((c) => ({
      type: 'tool_use' as const,
      id: `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      name: c.name,
      input: c.input,
    }));
    stop_reason = 'tool_use';
  } else {
    content = [{ type: 'text', text: copilotText || '(empty response)' }];
    stop_reason = 'end_turn';
  }

  return {
    id: `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason,
    stop_sequence: null,
    usage: {
      input_tokens: estimateTokens(promptText),
      output_tokens: estimateTokens(copilotText),
    },
  };
}

// ---------------------------------------------------------------------------
// SSE streaming
// ---------------------------------------------------------------------------

function sse(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function streamMessage(res: Response, msg: BuiltMessage): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-store',
    Connection: 'keep-alive',
  });

  sse(res, 'message_start', {
    type: 'message_start',
    message: {
      id: msg.id,
      type: 'message',
      role: 'assistant',
      model: msg.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: msg.usage.input_tokens, output_tokens: 0 },
    },
  });
  sse(res, 'ping', { type: 'ping' });

  msg.content.forEach((block, index) => {
    if (block.type === 'text') {
      sse(res, 'content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' },
      });
      const full = String((block as { text: string }).text);
      // chunk the text so consumers see realistic deltas
      const CHUNK = 400;
      for (let i = 0; i < full.length; i += CHUNK) {
        sse(res, 'content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text: full.slice(i, i + CHUNK) },
        });
      }
    } else if (block.type === 'tool_use') {
      const b = block as { id: string; name: string; input: Record<string, unknown> };
      sse(res, 'content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} },
      });
      sse(res, 'content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) },
      });
    }
    sse(res, 'content_block_stop', { type: 'content_block_stop', index });
  });

  sse(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: msg.stop_reason, stop_sequence: null },
    usage: { output_tokens: msg.usage.output_tokens },
  });
  sse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const KNOWN_MODELS = [
  'claude-sonnet-4-5-20250929',
  'claude-opus-4-1-20250805',
  'claude-3-5-haiku-20241022',
];

export function createCopilotProxyApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '32mb' }));

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ ok: true, backend: 'github-copilot-cli' });
  });

  app.get('/v1/models', (_req: Request, res: Response) => {
    res.json({
      data: KNOWN_MODELS.map((id) => ({
        type: 'model',
        id,
        display_name: id,
        created_at: '2025-01-01T00:00:00Z',
      })),
      has_more: false,
      first_id: KNOWN_MODELS[0],
      last_id: KNOWN_MODELS[KNOWN_MODELS.length - 1],
    });
  });

  app.post('/v1/messages', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as MessagesRequest;
    const model = body.model ?? 'claude-sonnet-4-5-20250929';
    const toolsAvailable = Array.isArray(body.tools) && body.tools.length > 0;
    const prompt = buildPrompt(body);

    // eslint-disable-next-line no-console
    console.error(
      `[shim] /v1/messages model=${model} msgs=${body.messages?.length ?? 0} tools=${
        body.tools?.length ?? 0
      } stream=${Boolean(body.stream)}`,
    );

    let copilotText: string;
    try {
      copilotText = await runCopilot(prompt);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[shim] copilot failed: ${message}`);
      if (!res.headersSent) {
        res.status(500).json({
          type: 'error',
          error: { type: 'api_error', message: `copilot backend failure: ${message}` },
        });
      }
      return;
    }

    const msg = buildAnthropicMessage(model, prompt, copilotText, toolsAvailable);
    if (body.stream) streamMessage(res, msg);
    else res.json(msg);
  });

  // Anything else the SDK might probe.
  app.use((req: Request, res: Response) => {
    res.status(404).json({
      type: 'error',
      error: { type: 'not_found_error', message: `unsupported endpoint ${req.method} ${req.path}` },
    });
  });

  return app;
}

export function startCopilotProxy(port: number): Promise<{ port: number; close: () => Promise<void> }> {
  const app = createCopilotProxyApp();
  return new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const actual = typeof addr === 'object' && addr ? addr.port : port;
      console.error(`[shim] copilot-backed Anthropic proxy listening on http://127.0.0.1:${actual}`);
      resolve({
        port: actual,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
    server.on('error', reject);
  });
}

// Direct-run entrypoint: npx tsx src/shim/copilot-proxy.ts
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const port = Number(process.env.PORT ?? 8787);
  startCopilotProxy(port).catch((e) => {
    console.error('[shim] failed to start:', e);
    process.exit(1);
  });
}
