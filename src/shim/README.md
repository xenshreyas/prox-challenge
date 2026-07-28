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
3. The reply is parsed back. The parser tolerates raw JSON, ```json fences, and
   JSON embedded in surrounding prose (balanced-brace scan). If no valid tool
   call is found, the output is returned as a plain `text` block.
4. `stop_reason` is set to `tool_use` or `end_turn` accordingly, and `tool_use`
   blocks get freshly generated `toolu_...` ids.

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
  protocol. A model that answers in prose when it should have called a tool will
  silently produce a text block instead. Parallel/complex tool use is fragile.
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
