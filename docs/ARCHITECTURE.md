# Architecture

A deeper technical companion to the README. The README states what was built and
why; this document covers the parts that need more room — the end-to-end data
flow, the chunk model, the tool-layer contract, the artifact sandbox threat
model, and the evaluation methodology including how the variance is handled.

---

## 1. Data flow, end to end

Two phases. Everything above the line ran once, on my machine, and is committed.
A grader never executes it.

```
OFFLINE — already run, committed to the repo
════════════════════════════════════════════════════════════════════════

  files/owner-manual.pdf   (48 pp)
  files/quick-start.pdf    ( 2 pp)
  files/selection-chart.pdf( 1 pp)   ← 1 byte of extractable text
          │
          ├── pdftoppm -r 150 ────────▶  kb/pages/<doc>-<nn>.png     51 rasters
          └── pdftotext -layout ──────▶  kb/pages/<doc>-<nn>.txt     text layer
                    │        │
                    └────┬───┘
                         ▼
              tools/extract_pages.py       5 parallel workers
              ┌──────────────────────────────────────────────┐
              │ VLM sees BOTH the page image and the raw     │
              │ text layer. Instruction: trust the IMAGE     │
              │ when they conflict.                          │
              └──────────────────────────────────────────────┘
                         ▼
              kb/extracted/<doc>-<nn>.md
                • verbatim prose, headings preserved
                • every table as a real markdown table
                • ### FIGURE: <slug> blocks —
                    caption, type, exhaustive description
                    (callout numbers, socket labels, arrow
                    directions), 3–6 seed questions
                • trailing YAML: page, section, topics,
                    processes, key_facts
                         │
                         │  npm run kb:build
                         │  src/kb/parse.ts  →  src/kb/build.ts
                         ▼
              kb/index.json      1063 typed chunks over 51 pages


RUNTIME — what actually runs for a grader
════════════════════════════════════════════════════════════════════════

  Browser · React 19 + Vite · :5173
      │
      │  POST /api/chat  { question, sessionId, voltage, image? }
      ▼
  Express · src/server/index.ts · :8787
      │
      │  opens an SSE response, streams *named* events
      ▼
  Agent · src/agent/agent.ts
      │  Claude Agent SDK query(), streaming-input mode,
      │  includePartialMessages for token-level deltas
      │
      │  five in-process MCP tools (src/agent/tools.ts):
      │
      ├─ search_manual ──▶ src/kb/search.ts ──┐ full hits into model context
      │                     BM25 + rerankers  │ + `citation` event to UI
      │                                       │
      ├─ show_figure ─────────────────────────┤ `figure` event to UI
      │                     ACK ONLY to model │ (base64 PNG never in context)
      │                                       │
      ├─ render_page ─────────────────────────┤ image block INTO model context
      │                     (the exception)   │ (no UI event)
      │                                       │
      ├─ create_artifact ─▶ artifact-harness ─┤ `artifact` event to UI
      │                     ACK ONLY to model │ (source never in context)
      │                                       │
      └─ manual_overview ─────────────────────┘ small TOC/orientation payload
                                              │
                                              ▼
                                       SSE event stream
                                              │
      ┌───────────────────────────────────────┘
      ▼
  web/src/hooks/useChat.ts  switches on event: name
      │
      ├─ MessageView        token deltas
      ├─ CitationChip       page-cited claims → /api/page-image
      ├─ FigureCard + Lightbox
      └─ ArtifactPanel      iframe srcdoc, sandbox="allow-scripts"
```

Two properties of this shape are worth naming.

**The expensive, failure-prone, non-deterministic work happens offline.** Vision
extraction is slow, costs money, and can be wrong. Doing it at query time would
put all three of those on the critical path of every question. Doing it once and
committing the result means the runtime path is: read a JSON file, tokenize,
score, answer. There is no setup step that can fail and no per-query extraction
bill.

**Retrieval has no network dependency and no service dependency.** `search.ts`
is pure TypeScript with zero imports outside the repo. The index builds lazily
on first use — a few milliseconds for ~1000 chunks — so the server boots
instantly and the first request still gets full recall.

---

## 2. The chunk model

`kb/index.json` holds 1063 chunks in four kinds:

| Kind | Count | Unit of meaning | Retrieval role |
|---|---:|---|---|
| `prose` | 108 | one section's body text | context-needing "how does X work" questions |
| `table` | 16 | one entire table, verbatim | matrix lookups that must not be fragmented |
| `figure` | 143 | caption + exhaustive description + seed questions | anything the user needs to *see* |
| `fact` | 796 | one atomic self-contained statement | single-value spec lookups |

Every chunk carries `doc`, `page`, `section`, `topics`, and `processes`. That
metadata is what makes page citation universal rather than best-effort, and what
lets retrieval filter or boost by welding process.

### Why the granularity is mixed rather than uniform

Uniform chunking is the default because it is simple, and it is the wrong
default here. Each of the four kinds fails differently under a single size.

**Tables have to stay whole.** A duty-cycle matrix split across two chunks
returns a fragment of a matrix. That is strictly worse than returning nothing:
the model gets something that *looks* like an answer and confidently reads the
wrong row. There are only 16 tables in the corpus, so keeping each one intact
costs almost nothing and removes an entire class of confident-wrong answer.

**Facts have to stay small.** "Maximum wire spool weight: 10 lb" buried inside a
600-token prose block is a handful of matching tokens diluted by hundreds of
non-matching ones. As its own chunk it is a near-exact match for the query that
wants it. The 796 fact chunks are deliberately over-produced: they are cheap to
store, high-precision to retrieve, and they are the single biggest reason
`recall@1` is respectable on lookup questions rather than dismal.

**Prose has to stay large.** "How does synergic mode work" is answered by a
paragraph in context, not by a sentence. Chopping prose to fact size destroys
the referents — pronouns and "this setting" stop resolving.

**Figures have no retrievable text at all** unless you write it. The pixels are
not searchable. So the figure chunk's *description* is the retrieval surface,
and it is written exhaustively on purpose: every callout number, every socket
label, every arrow direction. The 3–6 seed questions attached to each figure
matter more than they look like they should — they give the lexical retriever
hooks phrased the way a user actually asks ("which socket does the ground clamp
go in"), which the manual's own prose never provides, because manuals are
written in manual dialect.

The cost of mixed granularity is that scores from different kinds are not
directly comparable — a fact chunk and a prose chunk of very different lengths
land in the same BM25 ranking. That is what the chunk-kind priors in the
re-ranker exist to correct: question shape conditions which kind gets upweighted,
so "which socket" pulls figures up and "duty cycle at" pulls tables and facts up.

---

## 3. The tool layer contract

Five tools, exposed as an in-process MCP server (`src/agent/tools.ts`). In-process
matters: no subprocess, no stdio transport, no port, nothing to start or
supervise. The tools are TypeScript functions with zod schemas that the SDK sees
as MCP tools.

| Tool | Returns to model | Emits to UI |
|---|---|---|
| `search_manual` | full ranked hits with page refs | `citation` |
| `show_figure` | short text ack | `figure` (image payload) |
| `render_page` | **an image block** | — |
| `create_artifact` | short text ack | `artifact` (full source) |
| `manual_overview` | compact TOC / orientation | — |

### The side-channel split

This is the core design decision of the runtime, and it is a deliberate
asymmetry: **what the user sees and what the model remembers are different
streams.**

When the model calls `show_figure`, the browser receives a `figure` SSE event
carrying the actual image reference and caption, and renders a figure card
inline in the chat. The model receives back a single line of text along the
lines of *"Displayed figure `polarity-hookup` from p.14; refer to it naturally."*

Same for `create_artifact`: the browser gets the full harnessed HTML document;
the model gets an acknowledgement that an artifact was rendered.

Three things follow from that.

**Token cost stops compounding.** A base64 page raster is on the order of tens of
thousands of tokens. Conversation history is resent on every subsequent turn, so
a single image returned into context is not paid once — it is paid on every turn
for the rest of the session. In a five-turn conversation that shows two figures
and builds one artifact, the naive design pays for those payloads roughly a dozen
times over. The ack design pays for a sentence.

**The context window stays available for reasoning.** The thing the model needs
in context is the retrieved manual content it is reasoning over, not a copy of
the picture the user is already looking at.

**The model stops fighting its own artifact.** With source in context, the model
reliably tries to re-read and incrementally patch its previous artifact on the
next turn, which produces long, drifting, increasingly broken regenerations. With
only an ack, "make the slider go to 250" produces a clean fresh artifact.

The invariant worth stating explicitly: *if a payload exists primarily for the
human to look at, it goes over the side channel and only an ack enters context.*

### `render_page` is the deliberate exception

`render_page` breaks the rule on purpose. It returns a real image block into the
model's context, because its entire purpose is letting the model *look* at a page
it could not resolve from extracted text — a dense wiring schematic, an ambiguous
multi-column table, anything where extraction may have gone wrong.

That is the escape hatch that makes committing an offline extraction safe. The
whole design rests on extraction being good; `render_page` is the answer to "what
if it wasn't, on this page, for this question." Its tool description tells the
model to reach for it sparingly, and it emits no UI event because it is for the
model's eyes, not the user's.

### An implementation trap

Tool-result image blocks use `mimeType` (camelCase). User-message image blocks use
`media_type` (snake_case). Mixing them up fails *silently* — no error, the image
just is not there, and the model answers from text as if nothing happened. Both
call sites carry a comment. This cost real debugging time and is the kind of thing
that only shows up as a mysteriously worse answer.

### Event contract

`src/agent/events.ts` defines `AgentEvent` as a discriminated union, and that
union *is* the client contract. Each variant is emitted as a *named* SSE event,
so `web/src/hooks/useChat.ts` switches on `event:` rather than sniffing payload
shapes. Adding a new event type is an additive change on both sides: a new union
member, a new named event, a new switch arm. Nothing existing has to be
re-parsed.

SSE rather than WebSockets because traffic during a turn is strictly one-way
(server → browser). SSE gets that for free, survives proxies, and reconnects
without extra machinery. The one thing that flows the other direction — the
question itself — is the POST that opens the stream.

`sessionId` round-trips through the terminal `done` event, so follow-ups ("and on
120V?") resume server-side context instead of replaying transcript.

---

## 4. Artifact sandbox security model

### The threat

`create_artifact` executes model-authored JavaScript in the user's browser, on
the same page as the chat. That is a real capability with a real blast radius,
and the fact that the code came from a well-behaved model is not a security
control. Treat it as untrusted code, because the alternative is trusting prompt
injection through 51 pages of extracted PDF content.

### The control

`src/agent/artifact-harness.ts` wraps the model's source into a complete standalone
HTML document. The document is rendered via iframe `srcdoc` with:

```html
<iframe srcdoc="..." sandbox="allow-scripts"></iframe>
```

`allow-scripts` is present because the artifact must run. **`allow-same-origin` is
absent, and that omission is the entire security model.**

Without `allow-same-origin`, the browser assigns the iframe an *opaque origin* — a
unique origin that is same-origin with nothing, including itself. Concretely, the
artifact:

- cannot reach `window.parent` DOM, so it cannot read the conversation, scrape the
  page, or rewrite the UI
- cannot read or write the host origin's cookies
- cannot read or write the host origin's `localStorage` / `sessionStorage`
- cannot make same-origin `fetch` calls that ride the user's credentials
- cannot navigate the top-level frame (no `allow-top-navigation`)
- cannot submit forms to the host (no `allow-forms`)

What it *can* do is execute JavaScript, render into its own document, and make
cross-origin network requests — which is what the CDN fetches for React and Babel
need. This is the same posture Claude's own artifact sandbox uses.

The failure mode to watch for: adding `allow-same-origin` alongside `allow-scripts`
collapses the sandbox entirely. Together, those two flags let the framed document
reach out and remove its own `sandbox` attribute. They must never both be present.
It is a one-word change that silently converts a hardened sandbox into no sandbox,
which is exactly why it is called out here and at the call site.

Residual risks, stated plainly: an artifact can still exfiltrate anything it was
*given* (it is only given what the model puts in it), can still hang its own frame
with a hot loop, and can still fetch from arbitrary cross-origin URLs. A stricter
build would add a CSP to the harnessed document restricting `connect-src` and
`script-src` to the CDN. That is the obvious next hardening step and is not
currently implemented.

### Why a harness rather than "model, emit an HTML file"

The harness supplies React 19 via esm.sh, the Babel transform, the root mount, the
dark industrial theme, and error handling. The model writes only the component.

This is a reliability decision more than an aesthetic one. Asking a model to emit a
complete, correct HTML document with correct CDN script tags on every single
generation is a dependable source of broken artifacts — a wrong version pin, a
missing `type="text/babel"`, a mount before the DOM exists. Fixing the boilerplate
in one place makes the variable part small enough to get right consistently.

One specific detail: `react-dom` is pulled with `?external=react` so esm.sh does
not bundle a second copy of React. Two React instances in one document is the
classic cause of "Invalid hook call," and it presents as the model having written
bad code when it did not.

---

## 5. Evaluation methodology

Two harnesses, deliberately separate, because they answer different questions and
have very different costs.

### 5.1 Retrieval recall — `npx tsx evals/recall.ts`

No model, no key, ~1 second. For each of the 40 golden questions in
`research/eval-questions.json` (39 carry hand-assigned `page_refs`), it asks
whether a correct page appears in the top-k.

```
KB: 51 pages, 1063 chunks (143 figures, 16 tables)

Retrieval recall over 39 golden questions:
  recall@1   66.7%
  recall@3   84.6%
  recall@5   89.7%
  recall@10 100.0%
  MRR        0.7658
```

Retrieval is deterministic — no model, no network, no sampling — so repeated runs
reproduce these exactly. Verified across consecutive runs.

This harness matters for two reasons beyond its own number. It is the fast inner
loop: a retrieval change can be evaluated in a second instead of a token-spending
model run. And it establishes the **ceiling** on end-to-end accuracy. If the right
page never enters the agent's context, no prompt engineering recovers the answer.
When end-to-end accuracy drops, this harness is what tells you whether the cause is
upstream (retrieval) or downstream (prompt, tools, model).

The `@1` and `@3` figures are where the remaining headroom is: the right page is
always retrieved by k=10, it is just not always ranked first.

### 5.2 End-to-end agent scoring — `npm run eval`

Runs the full agent against all 40 questions and scores four sub-metrics
separately:

| Metric | Question it answers | Score |
|---|---|---:|
| `accuracy` | required facts present, correct pages cited | 83.5% |
| `grounding` | did it cite, and did it avoid unsupported numbers | 97.0% |
| `multimodal` | did it show a figure when the question needed one | 53.8% |
| `artifact` | did it build a tool when the question warranted one | 56.3% |
| **TOTAL** | | **76.2% ± 5.8** |

Zero tool-call failures across all 40 questions.

They are kept separate on purpose. Collapsing them into one number hides the most
actionable fact in the table, which is the shape of the profile: the agent is
reliably correct (83.5) and near-ceiling on grounding (97.0), and it
*under-triggers the visual response* (53.8 / 56.3). That is a prompt and
tool-description problem, not a retrieval or correctness problem, and it is
identifiable only because the metrics are reported apart. An averaged 76.2 would
have looked like "generally decent" and pointed nowhere.

Results append to `evals/history.jsonl` so runs can be compared rather than
trusting a single sample.

### 5.3 The variance problem, and why the harness reports intervals

The honest methodological issue with this harness is sample size.

Per-question scores have a standard deviation of 18.7 points. That is large, and it
is expected: the questions are heterogeneous (a one-line spec lookup and a
multi-part troubleshooting question are not the same measurement), and the model is
sampled rather than deterministic, so the same question can score differently on
two runs.

With only a handful of runs available, the standard error on the total is
meaningful — roughly ±5.8 points at the reported confidence level. Concretely,
**76.2 and 80.0 are not distinguishable results from this harness.** A change that
moves the total by two or three points has told you nothing.

Reporting a bare point estimate invites exactly the wrong behaviour: tuning a
prompt, re-running once, seeing 79.1, and concluding the change worked. Half the
time it did not, and you have just baked a coin flip into the prompt. This is the
standard trap in LLM eval work, and it is easy to fall into because the number
looks precise.

So the harness reports the interval alongside the point estimate. The practical
rules that follow:

1. **Treat overlapping intervals as no result.** If the intervals overlap, the
   change is unproven, not confirmed.
2. **Prefer the sub-metrics for diagnosis.** They move for identifiable reasons and
   are easier to reason about than the total. A multimodal jump from 53.8 to 70 is
   a real signal about tool triggering; a total moving 76.2 → 78 is noise.
3. **Use `recall.ts` for anything retrieval-shaped.** It is deterministic and
   free, so a retrieval change should be validated there first and only then
   confirmed end-to-end.
4. **Accumulate runs.** `evals/history.jsonl` exists so the interval narrows over
   time instead of every run being an isolated sample.

The right long-term fix is more runs per configuration and paired comparison on
identical questions, which cancels much of the per-question variance. That is a
cost question, not a design one.

### 5.4 Independent corroboration of extraction

Extraction accuracy is checked separately from retrieval and answer quality,
because a fully accurate retrieval over a wrongly extracted KB is confidently
wrong. Page 7's specification tables came through extraction exactly and match
duty-cycle values researched independently from other sources when the golden
question set was written:

| Process | 120 VAC | 240 VAC |
|---|---|---|
| MIG | 40% @ 100 A / 100% @ 75 A | 25% @ 200 A / 100% @ 115 A |
| TIG | — | 30% @ 175 A |
| Stick | — | 25% @ 175 A |

Two independent paths agreeing is the strongest extraction-accuracy signal
available short of a page-by-page human audit, which has not been done. The other
spot-check is page 14's DCEP polarity illustration, which vision extraction
recovered with every callout intact and text extraction cannot recover at all.

### 5.5 On the dev-time shim

`src/shim/` is a development-only Copilot-CLI-backed proxy used to exercise the SDK
without an Anthropic key on the build machine. It is not the documented run path,
not required, and not reached when `ANTHROPIC_API_KEY` is set. The primary and
intended path for a grader is a real `ANTHROPIC_API_KEY` in `.env`. It is
mentioned here only so that its presence in the tree is not mistaken for a
production dependency.

---

## 6. Where I would go next

In priority order, given the evidence above:

1. **Raise multimodal / artifact trigger rates.** They are the lowest sub-metrics
   by a wide margin and the highest-weighted criterion in the challenge. This is
   prompt and tool-description work — making the visual policy more prescriptive
   and the trigger conditions more concrete — and it is cheap to iterate on.
2. **Close the `recall@1` gap.** The right page is always retrieved by k=10 but
   ranked first only 66.7% of the time. A cheap query-rewrite pass or targeted
   synonym groups for the known weak vocabulary (nameplate curves, open-circuit
   voltage) is the direct fix.
3. **More eval runs per configuration.** The ±5.8 interval is currently wide
   enough to hide most single changes. Paired repeat runs narrow it fastest.
4. **CSP inside the artifact harness.** Restrict `connect-src` and `script-src` to
   the CDN, closing the residual exfiltration path noted in §4.
