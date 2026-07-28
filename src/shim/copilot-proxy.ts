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
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
  // The SDK occasionally injects a `system`-role message into the history, so
  // the union is wider than the public Messages API documents.
  role: 'user' | 'assistant' | 'system';
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

/**
 * Copilot CLI is an agent and prints its OWN tool-activity transcript to stdout
 * (e.g. `✓ bash(...)`, `✗ mcp__manual__search_manual query: "..."`, and the
 * `└ Tool 'x' does not exist.` continuation). Those lines are CLI chrome, not
 * model output — if they survive they get scored as the assistant's answer.
 * Strip them, including their indented continuation lines.
 */
export function stripCopilotToolTranscript(raw: string): string {
  const lines = raw.split('\n');
  const kept: string[] = [];
  let skippingContinuation = false;
  for (const line of lines) {
    if (/^\s*[✓✗×✔]\s/.test(line)) {
      skippingContinuation = true;
      continue;
    }
    // Continuation lines of a transcript entry: box-drawing gutter or deep indent.
    if (skippingContinuation && /^\s*(└|├|│)/.test(line)) continue;
    if (skippingContinuation && line.trim() === '') {
      skippingContinuation = false;
      continue;
    }
    skippingContinuation = false;
    kept.push(line);
  }
  return kept.join('\n').trim();
}

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
    // NOTE: do NOT pass `--available-tools=` here. It does not actually disable
    // Copilot's own toolset (verified: it still lists bash/web_search/etc.) and
    // it measurably increased the rate at which Copilot refused to emit the
    // protocol JSON at all. Plain --allow-all is what works.
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
      const text = stripCopilotToolTranscript(stripCopilotFooter(out));
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

/**
 * Flatten an Anthropic `tool_result.content` value into readable plain text.
 *
 * This is the crux of the tool_result round-trip. `content` is legally either a
 * plain string OR an array of content blocks (`{type:'text',text}`,
 * `{type:'image',...}`). The array form is what the Claude Agent SDK actually
 * sends for MCP tool results, and JSON-stringifying it produced
 * `[{"type":"text","text":"[owner-manual p.7 | fact]\n..."}]` — every newline
 * escaped, wrapped in array/object syntax. The model read that as machine noise
 * rather than as retrieved manual content, and answered as if it had no tools.
 *
 * We therefore unwrap to the underlying text verbatim, newlines intact.
 */
export function toolResultToText(content: unknown): string {
  if (content == null) return '(no content)';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item === 'string') {
        parts.push(item);
        continue;
      }
      if (!item || typeof item !== 'object') continue;
      const b = item as { type?: string; text?: unknown; source?: unknown };
      if (b.type === 'text' && typeof b.text === 'string') {
        parts.push(b.text);
      } else if (b.type === 'image') {
        // Never inline base64 — it would blow up the prompt for no benefit.
        parts.push('(an image was returned by this tool and is not shown here)');
      } else if (typeof b.text === 'string') {
        parts.push(b.text);
      } else {
        parts.push(safeJson(item));
      }
    }
    const joined = parts.filter((s) => s.trim().length > 0).join('\n\n');
    return joined || '(empty result)';
  }
  if (typeof content === 'object') {
    const b = content as { text?: unknown };
    if (typeof b.text === 'string') return b.text;
  }
  return safeJson(content);
}

/** Maps tool_use_id -> tool name so a tool_result can be labelled with the tool
 *  that produced it. Populated by walking the message history in order. */
type ToolNames = Map<string, string>;

function blockToText(block: ContentBlock, toolNames: ToolNames): string {
  switch (block.type) {
    case 'text':
      return String((block as { text?: string }).text ?? '');
    case 'tool_use': {
      const b = block as { id?: string; name: string; input: unknown };
      if (b.id) toolNames.set(b.id, b.name);
      return `[You requested execution of tool "${b.name}" with input ${safeJson(b.input)}]`;
    }
    case 'tool_result': {
      const b = block as { tool_use_id?: string; content?: unknown; is_error?: boolean };
      const name = (b.tool_use_id && toolNames.get(b.tool_use_id)) || 'unknown tool';
      const body = toolResultToText(b.content);
      if (b.is_error) {
        return (
          `<<< TOOL ERROR — tool "${name}" failed >>>\n${body}\n<<< END TOOL ERROR >>>`
        );
      }
      // Delimited, unescaped, and explicitly framed as authoritative retrieved
      // content so the model answers FROM it instead of doubting it exists.
      return (
        `<<< TOOL RESULT — real output of "${name}", executed successfully by the orchestrator >>>\n` +
        `${body}\n` +
        `<<< END TOOL RESULT >>>`
      );
    }
    case 'image':
      return '(the user attached an image)';
    default:
      return '';
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function contentToText(content: AnthropicMessage['content'], toolNames: ToolNames): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => blockToText(b, toolNames))
    .filter((s) => s.trim().length > 0)
    .join('\n\n');
}

/**
 * Tools the SDK host injects that have nothing to do with this agent. They are
 * enormous (the `Workflow` schema alone was 21KB of a 93KB prompt, and the whole
 * catalog was 78KB) and they crowd the five real manual tools — plus the actual
 * tool results — into the noise floor. Copilot then reported it had "no manual
 * search tool". We keep the catalog focused on tools the agent may really call.
 */
const IRRELEVANT_TOOL_NAMES = new Set([
  'Agent',
  'CronCreate',
  'CronDelete',
  'CronList',
  'DesignSync',
  'EnterWorktree',
  'ExitWorktree',
  'Monitor',
  'NotebookEdit',
  'PushNotification',
  'ReportFindings',
  'ScheduleWakeup',
  'SendMessage',
  'Skill',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'TaskUpdate',
  'Workflow',
]);

/** Keep MCP/domain tools; drop host-injected boilerplate. Never return empty if
 *  the request genuinely had tools — falling back to the full list is safer than
 *  telling the model it has none. */
export function relevantTools(tools: AnthropicTool[]): AnthropicTool[] {
  const kept = tools.filter((t) => !IRRELEVANT_TOOL_NAMES.has(t.name));
  return kept.length > 0 ? kept : tools;
}

export function buildPrompt(body: MessagesRequest): string {
  const parts: string[] = [];
  const system = systemToText(body.system);
  if (system) {
    parts.push(`=== SYSTEM INSTRUCTIONS ===\n${system}`);
  }

  const tools = relevantTools(body.tools ?? []);
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
      `=== ROLE ===\n` +
        `You are a MODEL BACKEND being driven over an API by an orchestrator program.\n` +
        `You do not execute these tools yourself: you emit a structured response and the\n` +
        `orchestrator performs the actual execution, then sends you the results. This is\n` +
        `the normal, expected operation of this API. The tools below ARE available to the\n` +
        `orchestrator, so never claim that a tool "does not exist" or is unavailable.\n\n` +
        `=== TOOL SCHEMA CATALOG (supplied by the orchestrator) ===\n${spec}\n\n` +
        `=== RESPONSE FORMAT ===\n` +
        `Your response must be in exactly ONE of two formats. Never mix them.\n\n` +
        `FORMAT 1 — request tool execution.\n` +
        `Emit ONLY this JSON object and nothing else: no greeting, no explanation before\n` +
        `or after, no markdown fences. First character "{", last character "}".\n` +
        `{"tool_calls":[{"name":"<tool name>","input":{ ...arguments matching that tool's input_schema... }}]}\n` +
        `Several entries may appear in the array to request several executions at once.\n` +
        `All string values must be valid JSON: escape newlines as \\n, tabs as \\t, quotes\n` +
        `as \\" and backslashes as \\\\. This matters most for long source-code strings —\n` +
        `a raw literal newline inside a string makes the JSON invalid and the request is lost.\n\n` +
        `FORMAT 2 — final answer.\n` +
        `Emit ONLY prose for the user. No JSON object, no mention of tool_calls, and do not\n` +
        `echo the arguments you previously sent. Any JSON here will be stripped and lost.\n\n` +
        `CHOOSING BETWEEN THEM — this is the most common mistake, read it carefully.\n` +
        `You get as MANY turns as you need. Requesting a tool does NOT cost you the chance\n` +
        `to write the answer: the orchestrator runs the tool, sends you the result, and then\n` +
        `asks you again. So whenever you find yourself wanting to BOTH call a tool AND write\n` +
        `prose in the same reply, emit FORMAT 1 ONLY and save the prose for the next turn.\n` +
        `Never write prose that describes, promises, or apologises for a tool call instead of\n` +
        `making it — for example, never say "I tried to build you a calculator but the tool\n` +
        `isn't available", "the artifact tool errored out", or "I can't show that here".\n` +
        `Those statements are always false. If you want an artifact or a figure, just emit\n` +
        `the FORMAT 1 tool call for it and you will get your turn to write prose afterwards.\n\n` +
        `This applies to EVERY turn, including turns that follow tool results. After you\n` +
        `receive tool results, either request more executions (Format 1) or write the final\n` +
        `answer as plain prose (Format 2).`,
    );
  } else {
    parts.push(
      `=== RESPONSE PROTOCOL ===\nReply with plain prose answering the user. Do not use any tools. Do not create, read or modify any files.`,
    );
  }

  // Walk messages IN ORDER with a shared tool_use_id -> name map, so each
  // tool_result can name the tool that produced it. The full history (including
  // every prior tool_use/tool_result pair) is replayed on every turn, because
  // each Copilot invocation is stateless.
  const toolNames: ToolNames = new Map();
  const convo = (body.messages ?? [])
    .map((m) => {
      const text = contentToText(m.content, toolNames);
      if (!text.trim()) return '';
      // The SDK sometimes injects a `system`-role message mid-history. Labelling
      // it "SYSTEM:" made it compete with the real system block, so it is
      // demoted to a clearly-marked context note.
      const label =
        m.role === 'user' ? 'USER' : m.role === 'assistant' ? 'ASSISTANT' : 'CONTEXT NOTE';
      return `${label}: ${text}`;
    })
    .filter((s) => s.trim().length > 0)
    .join('\n\n');

  const hasToolResults = (body.messages ?? []).some(
    (m) =>
      Array.isArray(m.content) && m.content.some((b) => b && b.type === 'tool_result'),
  );

  parts.push(
    `=== CONVERSATION ===\n${convo}\n\n=== YOUR REPLY ===` +
      (hasToolResults
        ? `\nThe TOOL RESULT blocks above are real output that the orchestrator already\n` +
          `executed on your behalf. They are authoritative — use their contents to answer.\n` +
          `Never say a tool is unavailable, missing, or that you lack access: the results\n` +
          `are right there. Answer directly from them and cite the pages they give you.`
        : ''),
  );

  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Response parsing: Copilot prose -> Anthropic content blocks
// ---------------------------------------------------------------------------

interface ParsedToolCall {
  name: string;
  input: Record<string, unknown>;
}

/** A candidate JSON region located inside the raw model output. `start`/`end`
 *  are offsets into the ORIGINAL text so the region can be excised afterwards
 *  (requirement: none of the tool_calls JSON may ever surface as prose). */
interface JsonSpan {
  start: number;
  end: number;
  raw: string;
}

/**
 * Repair the single most common way an LLM emits *almost*-valid JSON: literal
 * control characters (real newlines / tabs / CRs) inside a string literal.
 * This is exactly what breaks large embedded `code` payloads — one stray raw
 * newline in a 4KB source string invalidates the whole object.
 *
 * We walk the text with a proper string-state machine (so braces and escaped
 * quotes inside strings are handled correctly) and escape any raw control char
 * we find *while inside* a string. Everything outside strings is untouched.
 */
export function repairJsonControlChars(s: string): string {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      if (esc) {
        esc = false;
        out += c;
        continue;
      }
      if (c === '\\') {
        esc = true;
        out += c;
        continue;
      }
      if (c === '"') {
        inStr = false;
        out += c;
        continue;
      }
      if (c === '\n') out += '\\n';
      else if (c === '\r') out += '\\r';
      else if (c === '\t') out += '\\t';
      else if (c < ' ') out += '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0');
      else out += c;
      continue;
    }
    if (c === '"') inStr = true;
    out += c;
  }
  return out;
}

/** Scan forward from `start` (which must be a `{`) to its balanced closing
 *  brace, respecting string literals and escapes. Returns the end index
 *  (inclusive) or -1. */
function matchBalanced(text: string, start: number): number {
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
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Extract every plausible JSON-object candidate, with its offsets:
 *   - the whole trimmed output, when it is itself an object
 *   - the body of any ``` / ```json fence
 *   - EVERY balanced {...} region that contains `"tool_calls"` (not just the
 *     first — the model sometimes emits several)
 * Ordered most-specific-first so a tool_calls region wins over an outer wrapper.
 */
export function jsonSpans(text: string): JsonSpan[] {
  const out: JsonSpan[] = [];
  const seen = new Set<string>();
  const push = (start: number, end: number) => {
    if (start < 0 || end <= start) return;
    const key = `${start}:${end}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ start, end, raw: text.slice(start, end) });
  };

  // 1. Balanced regions anchored on each occurrence of "tool_calls".
  let from = 0;
  for (;;) {
    const idx = text.indexOf('"tool_calls"', from);
    if (idx === -1) break;
    from = idx + 1;
    let start = text.lastIndexOf('{', idx);
    while (start !== -1) {
      const end = matchBalanced(text, start);
      if (end !== -1) {
        push(start, end + 1);
        break;
      }
      // `lastIndexOf(x, -1)` clamps to 0 rather than returning -1, so walking
      // back from index 0 yields 0 forever. Stop explicitly at the start of the
      // string. Without this, an unbalanced payload (a truncated tool_calls
      // object) spins here indefinitely and hangs the request.
      if (start === 0) break;
      start = text.lastIndexOf('{', start - 1);
    }
  }

  // 2. Fenced blocks.
  const fence = /```(?:json)?[ \t]*\r?\n?([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) {
    const inner = m[1] ?? '';
    const innerStart = m.index + m[0].indexOf(inner);
    // Excise the whole fence, not just its body, so no ``` residue remains.
    if (inner.trim().startsWith('{')) push(m.index, m.index + m[0].length);
    else push(innerStart, innerStart + inner.length);
  }

  // 3. The entire output, if it is one object.
  const lead = text.length - text.trimStart().length;
  const tail = text.trimEnd().length;
  if (text.trim().startsWith('{') && text.trim().endsWith('}')) push(lead, tail);

  return out;
}

function coerceCalls(parsed: unknown): ParsedToolCall[] | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const calls = (parsed as { tool_calls?: unknown }).tool_calls;
  if (!Array.isArray(calls) || calls.length === 0) return null;
  const valid: ParsedToolCall[] = [];
  for (const c of calls) {
    if (!c || typeof c !== 'object') continue;
    const name = (c as { name?: unknown }).name;
    if (typeof name !== 'string' || !name) continue;
    const rawInput = (c as { input?: unknown }).input ?? (c as { arguments?: unknown }).arguments;
    let input: Record<string, unknown> = {};
    if (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) {
      input = rawInput as Record<string, unknown>;
    } else if (typeof rawInput === 'string') {
      // Some models double-encode the arguments object.
      try {
        const inner: unknown = JSON.parse(repairJsonControlChars(rawInput));
        if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
          input = inner as Record<string, unknown>;
        }
      } catch {
        /* leave empty */
      }
    }
    valid.push({ name, input });
  }
  return valid.length > 0 ? valid : null;
}

export interface ToolCallExtraction {
  calls: ParsedToolCall[];
  /** The model output with every JSON region that produced a tool call removed. */
  residualText: string;
}

/**
 * Find tool calls anywhere in the output. Strictly JSON.parse-based (never a
 * regex over the payload), with a control-character repair fallback so huge
 * embedded `code` strings containing raw newlines still parse.
 *
 * Returns the calls AND the text with those JSON regions excised, so callers
 * can guarantee the JSON never leaks into a text block.
 */
export function extractToolCalls(text: string): ToolCallExtraction | null {
  const spans = jsonSpans(text);
  for (const span of spans) {
    let calls: ParsedToolCall[] | null = null;
    for (const candidate of [span.raw, repairJsonControlChars(span.raw)]) {
      try {
        calls = coerceCalls(JSON.parse(candidate));
      } catch {
        calls = null;
      }
      if (calls) break;
    }
    if (!calls) continue;
    const residual = (text.slice(0, span.start) + text.slice(span.end)).trim();
    return { calls, residualText: residual };
  }
  return null;
}

/** Back-compat wrapper. */
export function parseToolCalls(text: string): ParsedToolCall[] | null {
  return extractToolCalls(text)?.calls ?? null;
}

/**
 * Last-resort safety net for requirement (4): if the output still *looks* like
 * a tool_calls payload but we could not parse it into calls, we must not show
 * that JSON to the user either. Excise every such region.
 */
export function stripUnparsedToolCallJson(text: string): string {
  if (!text.includes('"tool_calls"') && !text.includes("'tool_calls'")) return text;
  let out = text;
  for (const span of jsonSpans(text).slice().sort((a, b) => b.start - a.start)) {
    if (!span.raw.includes('tool_calls')) continue;
    out = out.slice(0, span.start) + out.slice(span.end);
  }
  // Truncated / structurally broken payloads produce no balanced span at all.
  // Fall back to cutting from the opening brace of the offending region to EOL-
  // end, since there is no valid closing brace to stop at.
  if (out.includes('tool_calls')) {
    const idx = out.indexOf('tool_calls');
    const brace = out.lastIndexOf('{', idx);
    out = brace === -1 ? '' : out.slice(0, brace);
  }
  return out.replace(/```(?:json)?\s*```/g, '').trim();
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
  // NOTE: this function is the SINGLE conversion point. Both the JSON and the
  // SSE paths call it, so they cannot diverge. It runs on every turn.
  const extracted = toolsAvailable ? extractToolCalls(copilotText) : null;
  let content: ContentBlock[];
  let stop_reason: 'end_turn' | 'tool_use';

  if (extracted && extracted.calls.length > 0) {
    // Multiple tool calls -> multiple tool_use blocks in ONE assistant message,
    // each with its own unique id.
    content = extracted.calls.map((c) => ({
      type: 'tool_use' as const,
      id: `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      name: c.name,
      input: c.input,
    }));
    stop_reason = 'tool_use';
    // Requirement (4): none of the tool_calls JSON may appear in a text block.
    // We deliberately DROP the residual prose entirely rather than risk
    // leaking a partially-excised fragment.
  } else {
    // Even with no parsable calls, never surface tool_calls JSON as prose.
    const safe = stripUnparsedToolCallJson(copilotText).trim();
    content = [{ type: 'text', text: safe || '(empty response)' }];
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

    if (process.env.SHIM_DEBUG_DIR) {
      try {
        mkdirSync(process.env.SHIM_DEBUG_DIR, { recursive: true });
        const stamp = `${Date.now()}-${randomUUID().slice(0, 8)}`;
        writeFileSync(join(process.env.SHIM_DEBUG_DIR, `req-${stamp}.json`), safeJson(body));
        writeFileSync(join(process.env.SHIM_DEBUG_DIR, `prompt-${stamp}.txt`), prompt);
      } catch {
        /* debugging only */
      }
    }

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

    if (process.env.SHIM_DEBUG_DIR) {
      try {
        const stamp = `${Date.now()}-${randomUUID().slice(0, 8)}`;
        writeFileSync(join(process.env.SHIM_DEBUG_DIR, `raw-${stamp}.txt`), copilotText);
        writeFileSync(join(process.env.SHIM_DEBUG_DIR, `built-${stamp}.json`), safeJson(msg));
      } catch {
        /* debugging only */
      }
    }

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
