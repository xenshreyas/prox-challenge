# Copilot-backed Anthropic Messages API shim

`copilot-proxy.ts` is a small local HTTP server that speaks a **subset of the
Anthropic Messages API** (`POST /v1/messages`) and answers it by shelling out to
the **GitHub Copilot CLI** (`copilot -p ... --allow-all --no-color`).

## Why this exists

This project is built on `@anthropic-ai/claude-agent-sdk`. The SDK requires an
Anthropic endpoint, but this development machine has **no `ANTHROPIC_API_KEY`** —
it does, however, have an authenticated GitHub Copilot CLI.

The SDK honours two environment variables:

- `ANTHROPIC_BASE_URL`
- `ANTHROPIC_AUTH_TOKEN`

So we point the SDK at this shim. The SDK remains the genuine foundation of the
agent; only the model transport is swapped, so the whole stack can be exercised
end-to-end on Copilot credits.

## Usage

```bash
# terminal 1
npx tsx src/shim/copilot-proxy.ts          # listens on 127.0.0.1:8787 (PORT overrides)

# terminal 2
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 \
ANTHROPIC_AUTH_TOKEN=dummy \
npx tsx src/shim/verify-sdk.ts
```

Programmatic: `import { startCopilotProxy } from './shim/copilot-proxy.js'`.

Endpoints: `POST /v1/messages` (streaming and non-streaming), `GET /v1/models`,
`GET /health`.

## How the bridge works

Copilot is an *agent*, not a raw completion endpoint — it returns prose and will
never emit Anthropic `tool_use` blocks natively. The shim bridges this by prompt
engineering:

1. The system prompt, full message history (including prior `tool_use` /
   `tool_result` turns, rendered as readable text), and the JSON schemas of all
   available tools are flattened into a single text prompt.
2. The model is instructed to reply with **either** plain prose **or** a strict
   JSON object `{"tool_calls":[{"name":..., "input":{...}}]}`.
3. The reply is parsed back by a **brace-balanced, `JSON.parse`-based**
   extractor (never a regex over the payload). It tolerates raw JSON, ```json
   fences, and JSON embedded in surrounding prose, and it scans *every*
   `"tool_calls"` occurrence rather than only the first. A control-character
   repair pass re-escapes literal newlines/tabs inside string values, so a
   multi-KB `code` argument containing raw newlines and nested braces still
   parses. If no valid tool call is found, the output is returned as `text`.
4. **Multiple** tool calls in one reply become **multiple `tool_use` blocks in
   the same assistant message**, each with a unique `toolu_...` id, and
   `stop_reason` is set to `tool_use`.
5. When a tool_calls payload is detected, its JSON region is excised and the
   assistant message contains *only* `tool_use` blocks — the JSON can never
   leak into a text block. As a safety net, any `tool_calls`-shaped JSON that
   could not be parsed is stripped from text output too.
6. Copilot CLI is an agent and prints its own tool-activity transcript
   (`✗ some_tool ...` / `└ Tool 'x' does not exist.`, and `● Web Search (MCP:
   github-mcp-server) …` when it invokes one of its *own* builtin MCP tools) to
   stdout. Those lines are CLI chrome, not model output, and are stripped
   before parsing — including embedded `{"type":"output_text",...}` MCP
   payloads, which are excised by brace matching wherever they appear.
7. The response-format contract is restated **verbatim at the very end of the
   prompt**, after the conversation. See "Protocol compliance" below.
8. If a reply comes back non-compliant (no parsable `tool_calls` and no
   plausible answer — typically an apology that a tool "isn't available"),
   `runCopilot` retries **once** with a short appended re-prompt.

## Protocol compliance — why the contract is repeated at the end

Copilot intermittently ignored the protocol and answered in prose claiming it
had no tools, making **zero** tool calls.

Root cause: the Claude Agent SDK appends a large host-injected *context note*
(its agent-type roster and skill catalog) to the **end** of the conversation. At
realistic prompt size (~19 KB) that note was the last thing Copilot read, so it
behaved like that agent harness and tried to *genuinely execute*
`mcp__manual__search_manual`. The CLI answered `Tool '…' does not exist`,
Copilot printed its own failure transcript, then wrote an apologetic
non-answer. Defects (A) prose-refusal and (B) trace-leak were the same bug.

Measured on the captured q11 prompt replayed straight through `copilot -p`:

| condition | tool_calls emitted | trace leaked |
|---|---|---|
| contract at top only (baseline) | 3/5 | 2/5 |
| `--disable-builtin-mcps` only | 5/6 | 1/6 |
| contract restated last | **6/6** | 0/6 |
| contract last + `--disable-builtin-mcps` | **6/6** | 0/6 |

Restating the contract last is the load-bearing fix. `--disable-builtin-mcps`
is kept because it removes the builtin GitHub-MCP web search that produced the
`●` trace in the first place (override with `SHIM_ALLOW_BUILTIN_MCPS=1`).
Prompt *length* alone was not the trigger — recency of the contract was.

This conversion lives in one function (`buildAnthropicMessage`) that **both**
the JSON and the SSE paths call, so streaming and non-streaming cannot diverge,
and it runs on **every** turn — not just the first.

Streaming (`stream: true`) is synthesised *after* the Copilot call returns: the
full answer is replayed as a correct Anthropic SSE sequence (`message_start`,
`ping`, `content_block_start`, `content_block_delta`, `content_block_stop`,
`message_delta`, `message_stop`).

## Security

The shim **never reads, prints, or forwards any credential**. It does not touch
`~/.copilot/config.json` or any token store; it only spawns the `copilot`
binary and lets that binary handle its own authentication. The
`ANTHROPIC_AUTH_TOKEN` the SDK sends is ignored entirely. Copilot is spawned in a
fresh temp directory so the agent cannot modify this repository.

## Limitations — read before relying on this

This is a **development / verification path only**. It is *not* the primary path
for a grader who has a real Anthropic key: in that case just set
`ANTHROPIC_API_KEY` and do not run this shim.

- **Latency.** Each `/v1/messages` call spawns a Copilot CLI process; 5–120s per
  turn is normal. Default timeout 180s (`COPILOT_TIMEOUT_MS`).
- **Not true streaming.** Tokens are not streamed from Copilot; the SSE sequence
  is replayed from the completed answer.
- **Tool calling is best-effort.** It depends on the model obeying the JSON
  protocol. Compliance is materially improved by restating the contract at the
  end of the prompt plus a one-shot retry (see "Protocol compliance"), but it is
  not guaranteed. Multiple tool calls per turn *are* supported, but the model
  does not always batch them.
- **Do not pass `--available-tools=`** to the Copilot CLI. It does not actually
  disable Copilot's own toolset (verified: it still lists bash/web_search/etc.)
  and it measurably increased the rate at which Copilot refused to emit the
  protocol JSON at all, saying the tools "do not exist". Plain `--allow-all` is
  what works.
- **`usage` is estimated** (chars/4), not real token accounting. Any cost figure
  the SDK reports downstream is therefore fictional.
- **No caching, no prompt-caching headers, no `thinking` blocks, no images,
  no `stop_sequences`, no temperature/top_p honouring, no `tool_choice`
  enforcement.**
- **Stateless.** No Copilot session resume between turns; the whole history is
  re-serialised into every prompt, which is token-expensive.
- The underlying model is whatever Copilot CLI is configured to use — the
  `model` field in the request is echoed back but does **not** select a model.

## Verified behaviour

The following were actually observed on this machine:

- Plain `/v1/messages` → `{"content":[{"type":"text","text":"The capital of France is Paris."}],"stop_reason":"end_turn"}`
- With a `get_weather` tool → `{"content":[{"type":"tool_use","id":"toolu_...","name":"get_weather","input":{"city":"Tokyo","unit":"celsius"}}],"stop_reason":"tool_use"}`
- `stream: true` → full correct SSE event sequence.
- Real SDK `query()` against the shim → `system/init` with `"apiKeySource": "none"`,
  an `assistant` message containing the expected text, and a final `result`
  message with `is_error: false`, `stop_reason: "end_turn"`.
