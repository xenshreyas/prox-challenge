# Vulcan OmniPro 220 — Multimodal Reasoning Agent

<img src="product.webp" alt="Vulcan OmniPro 220" width="380" /> <img src="product-inside.webp" alt="Vulcan OmniPro 220 — inside panel" width="380" />

A support agent for the [Vulcan OmniPro 220](https://www.harborfreight.com/omnipro-220-industrial-multiprocess-welder-with-120240v-input-57812.html)
multiprocess welder, built on the Anthropic Claude Agent SDK. It answers deep
technical questions about the machine — duty cycle math, polarity setup,
troubleshooting, wire feed calibration — grounded page-by-page in the 48-page
owner's manual, the quick-start guide, and the process selection chart.

It is not text-only. When the answer is something you can *see*, the agent
surfaces the actual manual figure. When the answer has parameters you'd want to
vary, it writes and renders a live interactive artifact beside the chat.

**Submission for the Prox founding-engineer challenge.** This README is the
design document: what it does, how it's built, what I chose and what I rejected.

---

## Quickstart

Requires Node 20+ and an Anthropic API key.

```bash
git clone https://github.com/xenshreyas/prox-challenge.git
cd prox-challenge
npm install
cp .env.example .env         # then paste your key into ANTHROPIC_API_KEY
npm run dev
```

Open **http://localhost:5173**.

That's the whole setup. There is no extraction step, no vector database, no
Docker, no external service. The knowledge base is committed as static JSON +
page rasters under `kb/`, and retrieval is pure in-process TypeScript with zero
dependencies — so `npm install && npm run dev` is genuinely sufficient.

`npm run dev` runs two processes via `concurrently`: the Express/SSE backend on
`:8787` (`npm run dev:server`) and the Vite frontend on `:5173`
(`npm run dev:web`), which proxies `/api` and `/kb` to the backend.

**No key handy?** The UI has a mock mode that replays a canned multimodal
transcript — figure card, citations, and a live artifact — against the real
components, so you can see the interaction design without spending a token:

```bash
VITE_MOCK=1 npm run dev:web     # http://localhost:5173, no backend needed
```

**Retrieval quality can be checked with no key at all**, in about a second:

```bash
npx tsx evals/recall.ts
```

### All scripts

| Command | What it does |
|---|---|
| `npm run dev` | Backend + frontend together (the normal way to run it) |
| `npm run dev:server` | Express + SSE backend only, `:8787` |
| `npm run dev:web` | Vite frontend only, `:5173` |
| `npm run build` | `tsc` the backend, Vite-build the frontend into `dist/` |
| `npm start` | Run the built server (`dist/src/server/index.js`) |
| `npm run kb:build` | Rebuild `kb/index.json` from `kb/extracted/*.md` |
| `npm run eval` | End-to-end agent eval over the 40 golden questions (needs a key, spends tokens) |
| `npm run typecheck` | `tsc --noEmit`; currently clean |
| `npx tsx evals/recall.ts` | Retrieval-only recall@k; no key, no model, ~1s |

Try asking:

- *"What's the duty cycle for MIG welding at 200A on 240V?"* — a table lookup
  that should come back with an interactive duty-cycle calculator.
- *"What polarity setup do I need for TIG? Which socket does the ground clamp go in?"*
  — should show you the page 14 hookup diagram, not describe it.
- *"I'm getting porosity in my flux-cored welds."* — cross-references the
  troubleshooting matrix and the weld-diagnosis figures.

---

## Architecture

```
  OFFLINE  (already done; committed to the repo)
  ─────────────────────────────────────────────────────────────────────────
   files/*.pdf ─┬─ pdftoppm 150dpi ──▶ kb/pages/<doc>-<nn>.png   (51 rasters)
                └─ pdftotext -layout ─▶ kb/pages/<doc>-<nn>.txt   (text layer)
                                              │
                          both fed to a VLM ──┤ tools/extract_pages.py
                          "trust the IMAGE    │ (5 parallel workers)
                           over the text"     ▼
                                     kb/extracted/<doc>-<nn>.md
                            verbatim prose · markdown tables · ### FIGURE:
                            blocks w/ exhaustive descriptions + seed
                            questions · trailing YAML page metadata
                                              │
                                 npm run kb:build (src/kb/parse.ts + build.ts)
                                              ▼
                                        kb/index.json
                                1082 typed chunks over 51 pages

  RUNTIME
  ─────────────────────────────────────────────────────────────────────────
   Browser (React 19 + Vite)
      │  POST /api/chat  { question, sessionId, voltage, image? }
      ▼
   Express  src/server/index.ts ──── SSE stream of named AgentEvents ───┐
      │                                                                 │
      ▼                                                                 │
   Agent    src/agent/agent.ts                                          │
      │  Claude Agent SDK query() loop, streaming-input mode,           │
      │  includePartialMessages for token-level deltas                  │
      │                                                                 │
      ├─▶ search_manual   BM25 + domain rerank over kb/index.json ──────┤ citation
      ├─▶ show_figure     figure → UI  (ack only into model context) ───┤ figure
      ├─▶ render_page     page PNG → *into the model's own context*     │
      └─▶ create_artifact code → artifact-harness → sandboxed iframe ───┤ artifact
                                                                        │
   MessageView · FigureCard+Lightbox · CitationChip · ArtifactPanel ◀───┘
```

Everything under `OFFLINE` has already run. The grader never executes it.

### Why these transport and runtime choices

**SSE, not WebSockets.** Traffic during a turn is strictly one-way (server →
browser). SSE gets that for free, survives proxies, and reconnects without extra
machinery. Each `AgentEvent` is emitted as a *named* SSE event so the client
switches on `event:` instead of sniffing payload shapes.

**Streaming-input mode, not a plain string prompt.** It costs some ceremony (an
async generator of `SDKUserMessage`), but the SDK requires it to attach images to
a user turn. That's what makes *"here's a photo of my control panel, which knob
is this?"* possible — a natural extension for this product, and already wired
through `/api/chat`'s `image` field.

**A plain-string system prompt, not the `claude_code` preset.** The preset frames
the model as a coding assistant. That persona and its tool instincts leak badly
into a welding-support conversation.

**Sessions resume.** `sessionId` round-trips through the SSE `done` event, so
follow-ups (*"and on 120V?"*) keep context without replaying history.

---

## How knowledge is extracted and represented

### The finding that drove the architecture

`files/selection-chart.pdf` yields **literally 1 byte** from `pdftotext`. It is a
pure image, and it contains the entire welding-process selection decision matrix.
A text-only RAG pipeline scores approximately zero on any process-selection
question — not degraded, *zero*.

Page 14 is the same story in miniature: it documents DCEP polarity **only as a
labeled illustration** (ground clamp → negative socket, wire feed power →
positive socket). There is no body text stating it. Vision extraction recovered
it correctly with every callout; text extraction cannot recover it at all.

So vision extraction here isn't an enhancement layered on a text pipeline. It's
the pipeline.

### The extraction pass

Each page PNG goes to a vision model *together with* its raw `pdftotext` layer,
with an explicit instruction to trust the image when the two conflict (the text
layer is useful as a spelling/number cross-check, and actively harmful as a
source of truth for tables). Per page, the model emits:

- verbatim prose with headings preserved
- every table as a real GitHub markdown table, never summarized
- a `### FIGURE: <slug>` block per diagram carrying caption, type, an exhaustive
  description (every callout number and label, every socket, arrow directions),
  and 3–6 **"answers questions like"** seed queries
- a trailing YAML block: page, section, topics, processes, `key_facts`

This solves three problems in one pass. Scrambled table columns get
reconstructed. Image-only content becomes searchable text. And the seed questions
give the retriever hooks phrased the way a real user actually asks, which prose
alone never provides.

The YAML is parsed by a small hand-rolled tolerant parser (`src/kb/parse.ts`)
rather than a YAML dependency. That's deliberate: the block is machine-generated
and uses a narrow subset, and a strict parser would hard-fail an entire page over
one unescaped colon in a caption. Ours degrades gracefully to the
filename-derived page number.

### Four chunk kinds, and why granularity is mixed

`npm run kb:build` turns 51 extracted pages into **1082 chunks**:

| Kind | Count | What it holds | The question it's for |
|---|---|---|---|
| `prose` | 114 | A section's body text | *"How does the synergic mode work?"* — needs surrounding context |
| `table` | 29 | One whole table, verbatim | *"Duty cycle at 200A on 240V?"* — needs the matrix intact |
| `figure` | 143 | Caption + full description + seed questions | *"Which socket does the ground clamp go in?"* — needs a picture |
| `fact` | 796 | One atomic self-contained statement | *"Max wire spool weight?"* — needs one line, undiluted |

A single uniform chunk size would compromise all four. A duty-cycle table split
across chunks returns a fragment of a matrix, which is worse than nothing — the
model will confidently read the wrong row. Conversely, burying *"maximum wire
spool weight: 10 lb"* inside a 600-token prose block dilutes its embedding/term
match against every other spec on that page. And figures need their *description*
to be the retrievable text, since the pixels aren't searchable.

The high fact count (796) is intentional. Facts are cheap, high-precision
retrieval targets; they're what makes `recall@1` respectable on lookup questions.
Every chunk carries `doc`, `page`, `section`, `topics`, and `processes`, so every
answer can be page-cited and retrieval can filter by welding process.

### Retrieval

`src/kb/search.ts` — pure TypeScript, no dependencies, no network, no embedding
service. BM25 over tokenized chunk text, then a stack of domain-aware re-rankers:

- **Welding synonym/alias expansion.** DCEP ↔ "reverse polarity" ↔ "electrode
  positive"; MIG ↔ GMAW; TIG ↔ GTAW. Users don't speak the manual's dialect.
- **Numeric-token boosting.** `200a`, `240v`, `25%` are tokenized as units and
  exact-matched. On a spec manual, a number match is worth far more than a word
  match, and unit aliases (`amps`/`a`/`amperage`) are normalized.
- **Chunk-kind priors conditioned on question shape.** "Show me / which socket /
  what does it look like" upweights `figure`. "How many / rated / duty cycle"
  upweights `table` and `fact`.
- **Process filtering** inferred from the query text.
- **Per-page diversity**, so one verbose page can't monopolize the result set.
- **Adjacent-bigram matching** (`duty|cycle`, `wire|feed`), so multi-word domain
  terms score as phrases rather than as two independently common tokens.

The index builds lazily on first use (a few ms for ~1k chunks), so the server
boots instantly and the first request still gets full recall.

I chose lexical over vector search deliberately — see the tradeoffs section.

---

## Multimodal response design

The challenge calls this the most important part, so it's designed as a system,
not a feature.

**Four tools, exposed as an in-process MCP server** (`src/agent/tools.ts`):

| Tool | Purpose |
|---|---|
| `search_manual` | Page-cited retrieval, filterable by chunk kind and process |
| `show_figure` | Puts a real manual figure in front of the *user*, inline in chat |
| `render_page` | Puts a full page raster in front of the *model*, for its own eyes |
| `create_artifact` | Emits self-contained HTML/React/SVG that renders live beside the chat |

**Side-channel events vs. model context.** This is the core design decision.
`show_figure` and `create_artifact` push a rich structured event to the browser
over SSE, but return only a short *text acknowledgement* into the model's
context ("Displayed figure X from p.14; refer to it naturally"). Base64 PNGs and
multi-KB artifact source never enter the conversation history. That keeps later
turns cheap, keeps the context window for reasoning, and stops the model from
trying to re-read its own artifact source on the next turn.

**`render_page` is the deliberate exception.** It *does* return an image block
into the model's context, because its entire purpose is letting the model
visually inspect a page it couldn't resolve from extracted text — a dense wiring
schematic, an ambiguous multi-column table. Its tool description tells the model
to reach for it sparingly. This is the escape hatch that makes the offline
extraction safe: if extraction missed something, the model can still go look.

(Implementation trap worth documenting: tool-result image blocks use `mimeType`
camelCase, while user-message image blocks use `media_type` snake_case. Mixing
them up fails silently. Both are commented at their call sites.)

**Artifacts run in a hardened sandbox.** `src/agent/artifact-harness.ts` wraps
model-authored source into a standalone document rendered via iframe `srcdoc`
with `sandbox="allow-scripts"` and **no** `allow-same-origin`. Omitting
`allow-same-origin` is the load-bearing part — it forces an opaque origin, so
generated code can execute JS but cannot touch the host's DOM, cookies, or
localStorage. Same posture as Claude's own artifact sandbox.

The harness also supplies all boilerplate — React 19 via esm.sh, the Babel
transform, the root mount, the dark industrial theme, error handling — so the
model writes only the interesting part. Asking a model to emit a complete correct
HTML document with CDN tags every single time is a reliable source of broken
artifacts. (`react-dom` is pulled with `?external=react` so esm.sh doesn't bundle
a second React copy, which is the classic "Invalid hook call" cause.)

**Primary visual evidence does not require a second model display call.** Left
alone, the model often reads a figure description and answers in prose without
calling `show_figure`. `search_manual` therefore ranks figures alongside passages
and automatically emits one when it has strong literal relevance to the model's
search query. The prompt still tells the model to show additional useful figures
and to build a tool when the answer has parameters worth varying. A corpus-wide
audit using the exact golden queries covers all 21 visual golden
questions: 21/21 surface a figure, and all 21 come from an accepted reference
page. Duplicate tracking prevents a later `show_figure` call from displaying the
same image twice.

**Tone and safety** are also prompt-level commitments: the reader is mechanically
capable but not a professional welder, standing in a garage. Lead with the
answer, expand jargon on first use, never chirpy, and never bury a shock/fume/UV
hazard under three paragraphs of setup.

---

## Design decisions and tradeoffs

### Adopted

**Vision extraction offline, retrieval online.** One-time cost, committed
artifacts, zero setup burden on the grader, and zero extraction cost at query
time.

**Lexical hybrid retrieval instead of embeddings.** A vector store would mean an
embedding provider, an index artifact, and a second failure mode at setup time —
against a corpus of ~1000 chunks from one 48-page manual. This domain is dense
with exact tokens that BM25 handles natively and embeddings actively blur:
`200A` vs `220A`, `25%` vs `30%`, DCEP vs DCEN. The synonym layer recovers the
paraphrase robustness that embeddings would otherwise buy. *Tradeoff accepted:*
a genuinely novel paraphrase with no lexical overlap and no synonym entry will
miss. The recall harness exists specifically to catch that class of failure, and
adding a synonym group is a one-line fix.

**Copilot CLI as the dev-time extraction engine.** Extraction is an offline
batch; running it on separate credits kept Anthropic spend for agent runtime.
Zero effect on the deliverable — the grader still needs only the single
`ANTHROPIC_API_KEY` the challenge specifies, and pays no extraction cost.

**The KB is committed, not built on clone.** 20 MB of JSON and page rasters in
the repo, in exchange for a setup that can't fail. Right trade for a graded
2-minute clone-to-running bar.

### Rejected

**Naive text-only RAG over `pdftotext`.** `selection-chart.pdf` yields 1 byte.
Duty-cycle matrices and polarity diagrams are images. This fails the most heavily
weighted criterion by construction, not by tuning.

**Tesseract OCR as the primary extraction path.** OCR recovers glyphs, not
semantics. It cannot tell you that an arrow points from the ground clamp to the
negative socket, cannot reliably reconstruct a multi-column duty-cycle matrix,
and produces no figure descriptions at all. Kept in mind only as a possible cheap
numeric cross-check.

**Dumping whole-page images into the agent's context at query time.** Fifty-one
page images per turn is far too many tokens, latency is bad, and the model
re-reads the manual on every question. The correct shape is: extract once
offline, retrieve precisely, attach *only* the specific page or figure the answer
depends on. `render_page` is the narrow, model-invoked version of this idea.

**`npm install --legacy-peer-deps` to dodge a zod conflict.** Claude Agent SDK
0.3.220 peer-requires zod v4; the upstream scaffold pinned zod v3, so install
failed with `ERESOLVE`. Shipping a `package.json` that only installs behind a
special flag is precisely the friction the 2-minute bar tests for. Fixed properly
by moving to `zod@^4`: clean install, 0 vulnerabilities. Worth noting that the
setup criterion caught a real bug.

**Returning artifact source and base64 images into model context.** Rejected in
favor of the side-channel event split described above. Context cost compounds
across a conversation; a UI event costs nothing.

---

## Evaluation

Two harnesses, deliberately separate, because they answer different questions and
have very different costs.

### 1. Retrieval recall — `npx tsx evals/recall.ts`

No model, no API key, runs in about a second. It measures whether the correct
source enters the top-k for each of the 40 golden questions
(`research/eval-questions.json`), scored against hand-assigned page references
or document-qualified `source_refs` where page numbers are ambiguous.

This is the fast inner loop for tuning retrieval, and it's the honest ceiling on
end-to-end accuracy: if the right page never reaches the agent's context, no
amount of prompt engineering saves the answer.

**As measured on the current KB and retrieval config** (all 40 questions carry
an accepted source):

```
KB: 51 pages, 1082 chunks (143 figures, 29 tables)

Retrieval recall over 40 golden questions:
  recall@1   75.0%
  recall@3   95.0%
  recall@5   100.0%
  recall@10  100.0%
  MRR        0.8458
```

These are measured numbers from actual runs of the command above, not estimates.
Retrieval is deterministic — no model, no network, no sampling — so repeated runs
reproduce these figures exactly (verified across three consecutive runs).

There are currently no misses at k=10. The failure mode this harness exists to
surface is a real one, though, and worth naming: questions whose answer lives on
a page that never states the question's own vocabulary. Both of the original
misses were exactly that — one asked about the "nameplate" duty-cycle curves,
where the word *nameplate* appeared only inside a topic slug; the other asked
about flux-cored duty cycle, where the manual files flux-cored under the shared
MIG/wire specs. That second one was instructive: a hard process filter was
*excluding* the correct pages, because it encoded an assumption the source
document doesn't share. Softening it to a boost fixed it.

The golden references include every verified reproduction of the machine's
nameplate (pp. 16, 25, and 27). This matters because p. 25 has the clearest
process-labelled transcription: treating it as a miss understated retrieval and
penalized correct answers that cited it. The `@1` figure is where the remaining
headroom is — the right page is always retrieved, but not always ranked first.

### 2. End-to-end agent scoring — `npm run eval`

Runs the full agent against all 40 questions and scores four sub-metrics
separately — `accuracy` (required facts present, right pages cited),
`multimodal` (did it show a figure when the question needed one), `artifact`
(did it build a tool when the question warranted one), and `grounding` (did it
cite at all, and avoid unsupported numbers). They are kept separate on purpose:
averaging them into a single number hides exactly the regressions worth catching.
Results append to `evals/history.jsonl` so runs can be compared rather than
trusting a single noisy sample.

**Measured, all 40 questions:**

```
TOTAL       89.2%
accuracy    92.1%
grounding   98.5%
multimodal  87.5%
artifact    70.0%
95% CI      ±3.2 pts (n=40, per-question sd 10.3)

relevant figures on visual questions  21/21
artifacts on artifact questions       15/21
backend refusals                       0/40
runtime errors                         0/40
```

Read this with the caveat in *Known limitations*: there was no
`ANTHROPIC_API_KEY` on the machine this was built on, so the agent was exercised
against `src/shim/` (a local Anthropic-API-compatible proxy backed by the GitHub
Copilot CLI). The Claude Agent SDK is genuinely the foundation either way, but
the model behind it was not Claude. **Treat 89.2% as indicative, not as a number
you will reproduce.**

This latest run is **inconclusive against the statistically established 86.1%
incumbent**: +3.1 points is inside the combined ±5.8-point noise floor, so it is
corroboration rather than evidence of another model-quality gain. The decomposition
is more useful than the headline. Points lost against each sub-metric's available
weight:

| Sub-metric | Score | Points lost / available |
|---|---|---|
| accuracy | 92.1% | 3.54 of 45 |
| grounding | 98.5% | 0.30 of 20 |
| multimodal | 87.5% | 2.50 of 20 |
| artifact | 70.0% | 4.50 of 15 |

The most important corroboration is visual: all **21/21** visual questions now
surfaced a relevant figure from an accepted source in the model-backed run, matching
the separate 21/21 deterministic audit. The earlier rewritten-query misses on
q24/q26/q33 are gone. Artifact compliance remains stochastic through the shim and
is the largest current opportunity: 15/21 artifact-required questions built one.

### On sample size, and a mistake worth documenting

The harness reports a 95% confidence interval and refuses to print a
NEW BEST / REGRESSION verdict when a delta falls inside the combined noise floor
of both runs. That guard exists because I got this wrong first.

Earlier I was accepting and reverting changes based on 4-question runs. Measuring
the variance across six identical-configuration runs showed per-question standard
deviation of ~25 points — the *same question, nothing changed* scored anywhere
from 8% to 93%, because tool-call compliance through the shim is stochastic. The
standard error of a 4-question mean is therefore ±14 points, and detecting the
−2.5 and −6.9 point "regressions" I had acted on would need roughly 1,600 and 211
questions respectively. Those decisions were noise.

`npm run eval` now warns explicitly when `n < 12` and prints `INCONCLUSIVE`
rather than a verdict it cannot support.

### Independent corroboration of the extracted facts

The page 7 specification tables came through extraction exactly, and match
duty-cycle answers researched independently from other sources when the golden
question set was written:

| Process | 120 VAC | 240 VAC |
|---|---|---|
| MIG duty cycle | 40% @ 100 A / 100% @ 75 A | 25% @ 200 A / 100% @ 115 A |
| TIG duty cycle | 40% @ 125 A / 100% @ 90 A | 30% @ 175 A / 100% @ 105 A |
| Stick duty cycle | 40% @ 80 A / 100% @ 60 A | 25% @ 175 A / 100% @ 100 A |

Two independent paths agreeing on these numbers is the strongest extraction
accuracy signal available without a manual page-by-page audit.

---

## Project layout

```
files/                    Source PDFs (owner manual 48pp, quick-start 2pp, selection chart 1pp)

kb/
  pages/                  51 page rasters (.png) + raw pdftotext layers (.txt)
  extracted/              51 vision-extracted structured markdown pages
  index.json              Built KB: 1082 typed chunks + page metadata

tools/
  extract_pages.py        Dev-time vision extraction pipeline (offline; already run)

src/
  kb/
    types.ts              Chunk / PageMeta / FigureMeta / SearchHit contracts
    parse.ts              Tolerant parser: extracted markdown -> typed chunks
    build.ts              `npm run kb:build` -> kb/index.json
    search.ts             BM25 + synonym/numeric/kind-prior/diversity reranking
    search.test.ts        Retrieval unit tests
  agent/
    prompt.ts             System prompt: persona, grounding rules, visual policy, safety
    tools.ts              In-process MCP server: the four tools
    agent.ts              Claude Agent SDK query() loop -> AgentEvent stream
    events.ts             The AgentEvent discriminated union (the client contract)
    artifact-harness.ts   Wraps model code into a sandboxed standalone document
  server/
    index.ts              Express: SSE /api/chat, /api/health, /api/page-image
  shim/                   Dev-only proxy for running the SDK without an Anthropic
                          key during development. Not part of the graded path.

web/                      React 19 + Vite frontend
  src/components/         MessageView, FigureCard, Lightbox, ArtifactPanel,
                          CitationChip, Composer, ConnectionBanner, EmptyState
  src/hooks/useChat.ts    SSE consumption + message state
  src/lib/                api.ts, sse.ts, markdown.ts, artifactRuntime.ts, mock.ts

evals/
  recall.ts               Retrieval recall@k (no key, ~1s)
  run.ts                  End-to-end agent scoring (needs a key)

research/                 Working notes produced while building
  claude-agent-sdk-report.md   SDK behaviour verified against a real install
  artifacts-implementation.md  Artifact rendering/sandboxing protocol
  domain-brief.md              Welding domain background
  eval-questions.json          40 page-grounded golden questions
```

---

## Known limitations

- **The end-to-end score was measured through a dev-only proxy, not a real
  Anthropic key.** No `ANTHROPIC_API_KEY` was available during development, so
  the agent was exercised against `src/shim/` — a local Anthropic-Messages-API
  proxy backed by the GitHub Copilot CLI. The Claude Agent SDK is genuinely the
  foundation either way (it honours `ANTHROPIC_BASE_URL`), but the *model* behind
  it during evaluation was not Claude. Treat the 89.2% as indicative, not as a
  number a grader will reproduce.

  A consumer coding assistant has identity-safety behaviour a raw model API does
  not and has refused the product persona in earlier runs. The harness detects
  and reports those separately; the current 40-question run had zero backend
  refusals and zero runtime errors.
- **The right source is not always ranked first.** Retrieval now reaches an
  accepted page for every referenced golden question by k=5 and k=10, but
  recall@1 is 75.0%. Questions whose answer sits on a page that uses different
  vocabulary can still require several hits of context. The measured current
  figures are 75.0%@1, 95.0%@3, 100%@5, and 100%@10 (MRR 0.8458).
- **Extraction is a snapshot.** Vision extraction is not infallible, and there
  has been no page-by-page human audit of all 51 pages. Page 7 and page 14 were
  spot-checked against independent sources. `render_page` is the runtime mitigation:
  the model can go look at the actual page when extracted text seems wrong.
- **Lexical retrieval only.** No embeddings, so a heavily paraphrased question
  with no lexical or synonym overlap will miss. Deliberate tradeoff, documented
  above.
- **No voice, and no persistence.** Sessions resume within a browser session via
  `sessionId`, but nothing is stored server-side; a restart loses history.
- **Artifacts require network access** for the esm.sh/unpkg CDN fetches inside
  the sandboxed iframe. Fully offline artifact rendering would mean vendoring
  React and Babel into the bundle.
- **Single-machine, single-user.** No auth, no rate limiting, no multi-tenancy.
  It's a take-home, and the server is scoped accordingly.
- **`src/shim/` is a development-only convenience** for exercising the SDK
  without an Anthropic key. It is explicitly not the documented run path and is
  not required, used, or reached when `ANTHROPIC_API_KEY` is set.
