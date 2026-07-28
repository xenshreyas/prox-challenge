# Claude Agent SDK (TypeScript) — Verified Technical Report

**Verified 2026-07-27** by real `npm install` + `tsc --strict` typecheck (see "Verification" at bottom).

## 1. Package & install

| Fact | Value |
|---|---|
| npm package | `@anthropic-ai/claude-agent-sdk` |
| Latest version | **0.3.220** (`dist-tags.latest`) |
| Repo | https://github.com/anthropics/claude-agent-sdk-typescript |
| Docs root | https://code.claude.com/docs/en/agent-sdk/overview (`docs.claude.com/en/api/agent-sdk/*` now redirects here) |
| TS reference | https://code.claude.com/docs/en/agent-sdk/typescript |
| Node | works on Node 20 (verified v20.19.3), ESM |

```bash
npm install @anthropic-ai/claude-agent-sdk zod
export ANTHROPIC_API_KEY=sk-ant-...
```

The SDK **bundles a native Claude Code binary** as an optional dep (e.g. `@anthropic-ai/claude-agent-sdk-darwin-arm64`). No separate Claude Code install. If your package manager skips optional deps you get `Native CLI binary for <platform> not found` — fix with `options.pathToClaudeCodeExecutable`. SDK version tracks the bundled CLI version (SDK v0.3.220 ⇒ Claude Code v2.1.220).

**Architecture note that matters for hosting:** each `query()` spawns a *subprocess*. N concurrent sessions = N subprocesses. Not a pure HTTP client library.

### Verified exports (`Object.keys` of the ESM module, v0.3.220)
```
query, startup, tool, createSdkMcpServer,
listSessions, getSessionInfo, getSessionMessages, getSubagentMessages,
forkSession, renameSession, tagSession, deleteSession, foldSessionSummary,
listSubagents, importSessionToStore, InMemorySessionStore,
resolveSettings, filterEscalatingDefaultMode,
DirectConnectTransport, DirectConnectError, parseDirectConnectUrl,
AbortError, HOOK_EVENTS, EXIT_REASONS, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, ...
```

## 2. Primary entrypoint — `query()`

```ts
function query({ prompt, options }: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}): Query;   // Query extends AsyncGenerator<SDKMessage, void>
```

Two modes:
- **Single-shot**: `prompt` is a `string`. Simplest. No images, no mid-session control.
- **Streaming input**: `prompt` is an `AsyncGenerator<SDKUserMessage>`. **Required for images/multimodal**, `interrupt()`, `setPermissionMode()`, `streamInput()`.

`Query` object methods (streaming-input mode only for most): `interrupt()`, `setPermissionMode(mode)`, `setModel(m)`, `streamInput(stream)`, `initializationResult()`, `supportedModels()`, `mcpServerStatus()`, `setMcpServers(...)`, `rewindFiles(...)`, `stopTask(id)`, `close()`.

`startup(params?)` → `Promise<WarmQuery>` pre-warms the subprocess (spawn + initialize handshake) so the first user request doesn't pay it. **Use this in a server**: call at boot, then `warm.query(prompt)`.

## 3. Message shapes (streaming)

`SDKMessage` is a large union. The ones you actually handle:

```ts
// type: "system", subtype: "init"  — first message, gives you session_id
{ type:"system"; subtype:"init"; session_id:string; model:string; tools:string[];
  mcp_servers:{name:string;status:string}[]; permissionMode:PermissionMode; cwd:string;
  slash_commands:string[]; skills:string[]; capabilities?:string[] }

// type: "assistant" — full assistant turn
{ type:"assistant"; uuid:UUID; session_id:string;
  message: BetaMessage;              // Anthropic SDK shape: {id, content[], model, stop_reason, usage}
  parent_tool_use_id: string|null; error?: SDKAssistantMessageError; timestamp?: string }

// type: "user"
{ type:"user"; message: MessageParam; parent_tool_use_id:string|null;
  uuid?:UUID; session_id?:string; tool_use_result?:unknown; shouldQuery?:boolean }

// type: "stream_event" — token-level deltas, ONLY when includePartialMessages: true
{ type:"stream_event"; event: BetaRawMessageStreamEvent; parent_tool_use_id:null;
  uuid:UUID; session_id:string; ttft_ms?:number }

// type: "result" — terminal message
{ type:"result"; subtype:"success"; session_id:string; result:string;
  duration_ms:number; duration_api_ms:number; num_turns:number; is_error:boolean;
  total_cost_usd:number; usage:NonNullableUsage; modelUsage:Record<string,ModelUsage>;
  permission_denials:SDKPermissionDenial[]; structured_output?:unknown; stop_reason:string|null }
// error subtypes include: error_max_turns, error_max_budget_usd, error_during_execution
```

Also present in the union (safe to ignore with a `default:`): `stream_event`, `system/compact_boundary`, `system/informational`, `SDKStatusMessage`, `SDKToolProgressMessage`, `SDKHook*Message`, `SDKRateLimitEvent`, etc. **Always write an exhaustive-but-tolerant switch** — the union grows between patch versions.

For token streaming to a browser, set `includePartialMessages: true` and forward `msg.event` when `msg.type === "stream_event"`; the delta text is at `event.type === "content_block_delta" && event.delta.type === "text_delta"` → `event.delta.text`.

## 4. Custom tools — `tool()` + `createSdkMcpServer()`

In-process MCP server; no subprocess, no stdio, handlers are plain async TS functions.

```ts
function tool<Schema extends AnyZodRawShape>(
  name: string,
  description: string,
  inputSchema: Schema,                       // Zod raw shape; Zod 3 and 4 both OK
  handler: (args, extra) => Promise<CallToolResult>,
  extras?: { annotations?: ToolAnnotations; searchHint?: string; alwaysLoad?: boolean }
): SdkMcpToolDefinition<Schema>;

function createSdkMcpServer(options: {
  name: string; version?: string; instructions?: string;
  tools?: Array<SdkMcpToolDefinition<any>>; alwaysLoad?: boolean;
}): McpSdkServerConfigWithInstance;
```

**Tool naming:** the key in `options.mcpServers` becomes the server segment. Pattern `mcp__{server}__{tool}`. Wildcard `mcp__manual__*` allowed in `allowedTools`.

**`CallToolResult.content[]`** blocks: `text`, `image`, `audio`, `resource`, `resource_link`. Image block for returning a page render to Claude:
```ts
{ type: "image", data: "<raw base64, NO data: prefix>", mimeType: "image/png" }
```
(That is `mimeType` camelCase on *tool results* — distinct from `media_type` snake_case on *user message* image blocks. Easy to get wrong.)

Also useful: `annotations: { readOnlyHint: true, openWorldHint: false }`, and `isError: true` on the result for tool failures.

## 5. System prompt

```ts
systemPrompt?: string | {
  type: 'preset'; preset: 'claude_code';
  append?: string; excludeDynamicSections?: boolean;
}
```
- **Default (omitted) = a minimal prompt**, NOT the Claude Code prompt. For a domain agent (welder manual QA), pass a plain string — you don't want coding-assistant framing.
- `{type:'preset',preset:'claude_code', append:"..."}` to keep Claude Code behavior + extend.
- `excludeDynamicSections: true` moves per-session context into the first user message → better prompt-cache reuse across machines.
- ⚠ System prompt options are resolved **once at startup**; `applyFlagSettings()` cannot change them mid-session.

## 6. Permission modes

```ts
type PermissionMode =
  | "default"            // standard behavior
  | "acceptEdits"        // auto-accept file edits
  | "bypassPermissions"  // bypass checks; explicit `ask` rules still prompt
  | "plan"               // read-only exploration
  | "dontAsk"            // never prompt; deny anything not pre-approved
  | "auto";              // model classifier approves/denies prompts
```
Related options: `allowedTools: string[]` (auto-approve, does **not** restrict), `disallowedTools` (block), `canUseTool` callback (invoked *only* when the flow falls through to a prompt — not for `allowedTools`/mode-approved calls), `allowDangerouslySkipPermissions: true` required alongside `permissionMode:'bypassPermissions'`.

**For a server-side headless agent: `permissionMode: 'bypassPermissions'` + `allowDangerouslySkipPermissions: true`, with a tightly-scoped `allowedTools` and `disallowedTools` for Bash/Write.** To gate *every* call, use a `PreToolUse` hook, not `canUseTool`.

## 7. Hooks

```ts
options.hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>

interface HookCallbackMatcher { matcher?: string; hooks: HookCallback[]; timeout?: number /*seconds*/ }
type HookCallback = (input: HookInput, toolUseID: string|undefined,
                     options: { signal: AbortSignal }) => Promise<HookJSONOutput>;
```
TS hook events include: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `UserPromptSubmit`, `UserPromptExpansion`, `MessageDisplay`, `Stop`, `StopFailure`, `SessionStart`, `SessionEnd`, `Notification`, `FileChanged`, `PreCompact`, `Setup`. Runtime list also exported as `HOOK_EVENTS`.

Matcher semantics: only `[A-Za-z0-9_\- ,|]` ⇒ exact-match with `|`/`,` alternatives (`"Write|Edit"`). Any other char ⇒ unanchored regex (`"^mcp__"`). `"*"` / `""` / omitted ⇒ all.

`PreToolUse` output can `permissionDecision: "allow" | "deny" | "ask" | "defer"`. Set `includeHookEvents: true` to see hook lifecycle in the message stream.

## 8. Sessions

- Capture `session_id` from the `system/init` message (or the `result` message).
- Resume: `options.resume = sessionId`. Fork instead of continue: `options.resume + forkSession: true` (new ID arrives on the fork's `init`).
- Resume at a point: `resumeSessionAt: <message uuid>`.
- Disable disk persistence: `persistSession: false`.
- ⚠ **`cwd` must match.** Transcripts live at `~/.claude/projects/<encoded-cwd>/*.jsonl` where `<encoded-cwd>` is the abs path with every non-alphanumeric char → `-`. A resume from a different cwd silently starts a fresh session.
- Helper fns: `listSessions({dir,limit})`, `getSessionInfo`, `getSessionMessages`, `renameSession`, `tagSession`, `deleteSession`, `forkSession`.
- For multi-host deployments use `options.sessionStore` (a `SessionStore` adapter) to mirror transcripts externally; `InMemorySessionStore` is exported for tests.

## 9. Images / multimodal — **requires streaming-input mode**

You cannot attach an image with a `string` prompt. Yield an `SDKUserMessage` whose `message.content` is an array of Anthropic content blocks:

```ts
{ type: "image", source: { type: "base64", media_type: "image/png", data: <base64> } }
```
Note `media_type` (snake_case) here vs `mimeType` in tool results. Also valid: `source: { type: "url", url: "https://..." }` (Anthropic MessageParam shape).

---

# Code snippets (Node 20, ESM, TypeScript)

Project setup for all of them:
```jsonc
// package.json
{ "type": "module",
  "dependencies": { "@anthropic-ai/claude-agent-sdk": "^0.3.220", "zod": "^3.23.8" },
  "devDependencies": { "typescript": "^5.6.0", "tsx": "^4.19.0", "@types/node": "^20.14.0" } }
```
```jsonc
// tsconfig.json
{ "compilerOptions": { "target":"ES2022", "module":"NodeNext", "moduleResolution":"NodeNext",
  "strict": true, "skipLibCheck": true, "outDir":"dist" }, "include":["src"] }
```
Run with `npx tsx src/x.ts`.

## Snippet 1 — minimal single-shot query

```ts
// src/basic.ts
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const msg of query({
  prompt: "In one sentence, what is a MIG welder duty cycle?",
  options: {
    systemPrompt: "You are a concise technical assistant for welding equipment.",
    maxTurns: 3,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    allowedTools: [],
  },
})) {
  if (msg.type === "system" && msg.subtype === "init") {
    console.log("session:", msg.session_id, "model:", msg.model);
  } else if (msg.type === "result" && msg.subtype === "success") {
    console.log(msg.result);
    console.log("cost $", msg.total_cost_usd, "turns", msg.num_turns);
  }
}
```

## Snippet 2 — custom tools via in-process MCP server

```ts
// src/tools.ts
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { readFile } from "node:fs/promises";

const searchManual = tool(
  "search_manual",
  "Search the welder owner's manual and return matching passages with page numbers.",
  { queryText: z.string().describe("search terms"), topK: z.number().int().min(1).max(10).default(5) },
  async ({ queryText, topK }) => {
    const hits = await myRetriever(queryText, topK); // your vector/BM25 search
    return {
      content: [{
        type: "text",
        text: hits.map(h => `[page ${h.page}] ${h.text}`).join("\n\n"),
      }],
    };
  },
  { annotations: { readOnlyHint: true, openWorldHint: false } }
);

const renderPage = tool(
  "render_page",
  "Render a page of the manual as an image so it can be visually inspected (diagrams, tables).",
  { page: z.number().int().min(1) },
  async ({ page }) => {
    const png = await readFile(`./pages/page-${page}.png`);   // pre-rendered
    return {
      content: [
        { type: "text", text: `Rendered page ${page}` },
        { type: "image", data: png.toString("base64"), mimeType: "image/png" }, // note: mimeType
      ],
    };
  },
  { annotations: { readOnlyHint: true } }
);

const manualServer = createSdkMcpServer({
  name: "manual",
  version: "1.0.0",
  instructions: "Tools for retrieving and rendering the welder owner's manual.",
  tools: [searchManual, renderPage],
});

for await (const msg of query({
  prompt: "What wire size should I use for 1/8 inch mild steel? Cite the page.",
  options: {
    systemPrompt:
      "You answer questions about a welder owner's manual. Always cite page numbers. " +
      "If the manual does not cover it, say so instead of guessing.",
    mcpServers: { manual: manualServer },
    allowedTools: ["mcp__manual__search_manual", "mcp__manual__render_page"],
    disallowedTools: ["Bash", "Write", "Edit"],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    maxTurns: 12,
  },
})) {
  if (msg.type === "assistant") {
    for (const b of msg.message.content) {
      if (b.type === "tool_use") console.log("[tool]", b.name, b.input);
    }
  } else if (msg.type === "result" && msg.subtype === "success") {
    console.log("\nANSWER:\n" + msg.result);
  }
}

declare function myRetriever(q: string, k: number): Promise<{ page: number; text: string }[]>;
```

## Snippet 3 — image input + hooks + session capture (streaming-input mode)

```ts
// src/image.ts
import { query, type SDKUserMessage, type HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { readFile } from "node:fs/promises";

const auditTools: HookCallback = async (input, toolUseID) => {
  if (input.hook_event_name === "PreToolUse") {
    console.error(`[audit] ${input.tool_name} ${toolUseID ?? ""}`);
    if (input.tool_name === "Bash") {
      return { hookSpecificOutput: { hookEventName: "PreToolUse",
                                     permissionDecision: "deny",
                                     permissionDecisionReason: "shell disabled" } };
    }
  }
  return { continue: true };
};

async function* turns(): AsyncGenerator<SDKUserMessage> {
  yield {
    type: "user",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        { type: "text", text: "This photo is from my welder's control panel. Which knob sets wire feed speed, and what does the manual say the range is?" },
        { type: "image", source: { type: "base64", media_type: "image/jpeg",
                                   data: await readFile("./panel.jpg", "base64") } },
      ],
    },
  };
}

let sessionId: string | undefined;
const q = query({
  prompt: turns(),
  options: {
    systemPrompt: "You are a welding equipment support agent.",
    hooks: { PreToolUse: [{ matcher: "*", hooks: [auditTools] }] },
    includePartialMessages: true,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    maxTurns: 10,
  },
});

for await (const msg of q) {
  switch (msg.type) {
    case "system":
      if (msg.subtype === "init") sessionId = msg.session_id;
      break;
    case "stream_event": {
      const ev = msg.event;
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta")
        process.stdout.write(ev.delta.text);
      break;
    }
    case "result":
      if (msg.subtype === "success") console.log("\n---\nsession:", sessionId);
      break;
  }
}
```

Resume later:
```ts
for await (const m of query({ prompt: "And what torque for the drive roll?",
                              options: { resume: sessionId /*, forkSession: true */ } })) { /* ... */ }
```

## Snippet 4 — Express + SSE, streaming to a browser

```ts
// src/server.ts
import express from "express";
import { query, startup, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { manualServer } from "./manualServer.js"; // createSdkMcpServer(...) from Snippet 2

const app = express();
app.use(express.json({ limit: "25mb" }));

const baseOptions = {
  systemPrompt: "You answer questions about a welder owner's manual. Always cite page numbers.",
  mcpServers: { manual: manualServer },
  allowedTools: ["mcp__manual__search_manual", "mcp__manual__render_page"],
  disallowedTools: ["Bash", "Write", "Edit"],
  permissionMode: "bypassPermissions" as const,
  allowDangerouslySkipPermissions: true,
  includePartialMessages: true,
  maxTurns: 15,
  cwd: process.cwd(), // keep stable so `resume` finds the transcript
};

// Optional: pay subprocess spawn cost at boot instead of on first request.
await startup({ options: baseOptions });

app.post("/api/chat", async (req, res) => {
  const { prompt, sessionId, imageBase64, imageMediaType } = req.body as {
    prompt: string; sessionId?: string; imageBase64?: string; imageMediaType?: string;
  };

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // disable nginx buffering
  });
  res.flushHeaders();

  const send = (event: string, data: unknown) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);

  // Streaming-input mode is required when an image is attached.
  const promptArg = imageBase64
    ? (async function* () {
        yield {
          type: "user" as const,
          parent_tool_use_id: null,
          message: {
            role: "user" as const,
            content: [
              { type: "text" as const, text: prompt },
              { type: "image" as const,
                source: { type: "base64" as const,
                          media_type: (imageMediaType ?? "image/png") as "image/png",
                          data: imageBase64 } },
            ],
          },
        };
      })()
    : prompt;

  const q = query({ prompt: promptArg, options: { ...baseOptions, resume: sessionId } });

  req.on("close", () => { clearInterval(heartbeat); q.close(); });

  try {
    for await (const msg of q as AsyncGenerator<SDKMessage>) {
      switch (msg.type) {
        case "system":
          if (msg.subtype === "init") send("session", { sessionId: msg.session_id, model: msg.model });
          break;
        case "stream_event": {
          const ev = msg.event;
          if (ev.type === "content_block_delta" && ev.delta.type === "text_delta")
            send("token", { text: ev.delta.text });
          break;
        }
        case "assistant":
          for (const b of msg.message.content)
            if (b.type === "tool_use") send("tool_use", { name: b.name, input: b.input });
          break;
        case "result":
          send("result", msg.subtype === "success"
            ? { ok: true, text: msg.result, costUsd: msg.total_cost_usd, turns: msg.num_turns,
                sessionId: msg.session_id }
            : { ok: false, subtype: msg.subtype });
          break;
      }
    }
  } catch (err) {
    send("error", { message: err instanceof Error ? err.message : String(err) });
  } finally {
    clearInterval(heartbeat);
    send("done", {});
    res.end();
  }
});

app.listen(3000, () => console.log("http://localhost:3000"));
```

Browser consumer (POST + SSE, so use `fetch` streaming rather than `EventSource`):
```ts
const res = await fetch("/api/chat", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ prompt, sessionId, imageBase64 }),
});
const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
let buf = "";
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += value;
  const frames = buf.split("\n\n"); buf = frames.pop()!;
  for (const f of frames) {
    const ev = /^event: (.*)$/m.exec(f)?.[1];
    const dataLine = /^data: (.*)$/m.exec(f)?.[1];
    if (!ev || !dataLine) continue;               // ": ping" heartbeats have neither
    const data = JSON.parse(dataLine);
    if (ev === "token") appendToken(data.text);
    if (ev === "session") setSessionId(data.sessionId);
    if (ev === "result") finish(data);
  }
}
```

## Snippet 5 — Fastify equivalent (raw stream)

```ts
// src/fastify-server.ts
import Fastify from "fastify";
import { query } from "@anthropic-ai/claude-agent-sdk";

const app = Fastify({ bodyLimit: 25 * 1024 * 1024 });

app.post("/api/chat", async (req, reply) => {
  const { prompt, sessionId } = req.body as { prompt: string; sessionId?: string };

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  const send = (event: string, data: unknown) =>
    reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const q = query({ prompt, options: { resume: sessionId, includePartialMessages: true,
                                       permissionMode: "bypassPermissions",
                                       allowDangerouslySkipPermissions: true } });
  req.raw.on("close", () => q.close());

  for await (const msg of q) {
    if (msg.type === "stream_event") {
      const ev = msg.event;
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta")
        send("token", { text: ev.delta.text });
    } else if (msg.type === "result") {
      send("result", { ok: msg.subtype === "success",
                       text: msg.subtype === "success" ? msg.result : null,
                       sessionId: msg.session_id });
    }
  }
  reply.raw.end();
  return reply;
});

await app.listen({ port: 3000 });
```

---

## Server-side gotchas (from the Hosting doc)

1. **One session = one subprocess.** Concurrency is bounded by container RAM, not event-loop capacity. Cap concurrent sessions explicitly.
2. **Set `cwd` per query** when sessions need separate filesystems; they otherwise inherit the app's cwd. But keep it *stable per session* or `resume` breaks.
3. **Always `q.close()` on client disconnect** — otherwise the subprocess leaks.
4. **Use `startup()`** to pre-warm and remove spawn latency from the first request.
5. Recycle subprocesses / cap session length to avoid memory growth on long sessions.
6. Disable proxy buffering (`X-Accel-Buffering: no`, `no-transform`) or SSE arrives in one lump.
7. `Content-Type: text/event-stream` + heartbeat comments (`: ping\n\n`) keep idle connections alive through load balancers.
8. Serverless/Lambda is a poor fit for long agent loops; prefer a long-lived container.

## Verification

- `npm view @anthropic-ai/claude-agent-sdk version` → `0.3.220`
- Installed into a clean Node v20.19.3 project; enumerated real ESM exports.
- Wrote a TS file exercising `query`, `tool`, `createSdkMcpServer`, `SDKUserMessage` with a base64 image block, `PermissionMode`, `HookCallback`, `systemPrompt` preset object, `mcpServers`, `allowedTools`, `hooks`, `includePartialMessages` → compiled clean under `tsc --strict --module nodenext --target es2022`. Result: **TYPECHECK_OK**.

## Sources
- https://code.claude.com/docs/en/agent-sdk/typescript
- https://code.claude.com/docs/en/agent-sdk/overview
- https://code.claude.com/docs/en/agent-sdk/custom-tools
- https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts
- https://code.claude.com/docs/en/agent-sdk/permissions
- https://code.claude.com/docs/en/agent-sdk/hooks
- https://code.claude.com/docs/en/agent-sdk/sessions
- https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode
- https://code.claude.com/docs/en/agent-sdk/streaming-output
- https://code.claude.com/docs/en/agent-sdk/mcp
- https://code.claude.com/docs/en/agent-sdk/hosting
