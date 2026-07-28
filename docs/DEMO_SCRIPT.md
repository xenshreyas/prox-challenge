# Video walkthrough script

Target length: 6 minutes. Six segments, timestamped. Each segment says what is on
screen and what to say over it.

Record at 1440p or better — manual figures and artifact controls need to be
legible. Browser at ~1400px wide so the chat column and the artifact panel are
both visible without scrolling.

## Before you hit record

```bash
bash scripts/demo-reset.sh
```

That verifies Node, `kb/index.json`, and `.env`, and prints the commands to
start. Then:

- `npm run dev` already running, backend healthy, browser on
  http://localhost:5173 with an empty chat.
- A second terminal, cleared, in the repo root.
- An editor window with `src/agent/tools.ts` open but not focused.
- Close anything with notifications.

Do one full dry run first. The agent is a live model; answers vary in wording
even when they are correct. The questions below were chosen because they land on
pages with strong retrieval coverage, but you still want to know what the run
looks like before it is the take.

---

## 0:00 – 0:40 · The problem

**On screen:** the README hero image (the OmniPro 220 and its inside panel),
then `files/selection-chart.pdf` open in a PDF viewer.

**Say:**

> This is a Vulcan OmniPro 220 — a multiprocess welder. It does MIG, TIG, stick
> and flux-cored, at two input voltages, and the manual for it is 48 pages of
> duty-cycle matrices, polarity diagrams and a troubleshooting tree.
>
> Here is the thing that decided the entire architecture. This is the process
> selection chart that ships with the machine. Run `pdftotext` on it and you get
> one byte. It is a pure image. Every welding-process selection question in this
> domain is answered by a document with no text in it.
>
> Page 14 of the owner's manual is the same story smaller: DCEP polarity — which
> socket the ground clamp goes into — is documented *only* as a labeled
> illustration. There is no sentence anywhere that says it.
>
> So this isn't text RAG with a vision feature bolted on. Vision extraction is
> the pipeline. Let me show you what that buys.

---

## 0:40 – 1:20 · Setup, live

**On screen:** the clean terminal. Type these for real, do not paste a
pre-baked scrollback.

```bash
git clone https://github.com/xenshreyas/prox-challenge.git
cd prox-challenge
npm install
cp .env.example .env      # paste your ANTHROPIC_API_KEY
npm run dev
```

**Say:**

> Clone, install, paste one key, run. That's it. No vector database, no Docker,
> no extraction step, no external service. The knowledge base is committed to
> the repo as static JSON plus page rasters, and retrieval is plain in-process
> TypeScript with zero dependencies — so there is nothing that can fail at setup
> except npm itself.
>
> If you don't want to spend a token, two things run with no key at all:
> `VITE_MOCK=1 npm run dev:web` replays a canned multimodal transcript through
> the real components, and `npx tsx evals/recall.ts` scores retrieval in about a
> second.

You can cut the actual `npm install` wait in the edit. Don't fake the output.

---

## 1:20 – 2:40 · A deep technical question, answered with a real figure

**On screen:** the running app. Type this exactly:

> **What polarity setup do I need for flux-cored welding? Which socket does the ground clamp go in?**

Let it stream. Do not talk over the first few seconds — let the viewer watch
tokens arrive and the tool activity appear.

**Say, while it works:**

> Watch the tool line. It searches the manual first, and then it decides to show
> me something.

**When the figure card appears — click it to open the lightbox:**

> That is the actual page 14 hookup diagram out of the PDF, not a description of
> it. The ground clamp goes to the negative socket, the wire feed power lead
> goes to the positive socket. The agent knows that because the extraction pass
> read the illustration and wrote down every callout and every arrow direction
> as searchable text.
>
> A text-only pipeline cannot answer this question. Not badly — at all. The
> information does not exist as text in the source.

**Point at the citation chips:**

> Every claim is page-cited. Click a chip and you get the page it came from.
> That's a prompt-level rule: no unsupported numbers, ever.

If the figure does not appear on the take, do not narrate around it — reroll.
This is the segment the whole video exists for.

---

## 2:40 – 4:00 · An artifact, generated and then actually used

**On screen:** same chat. Type:

> **What's the duty cycle for MIG welding at 200A on 240V? I keep tripping thermal overload.**

**Say, while it streams:**

> Duty cycle is a question with parameters. The manual gives you two anchor
> points — on 240 volts, MIG is 25 percent at 200 amps and 100 percent at 115
> amps — and what you actually want to know is "how long can I run *my* bead."
> Stating a number answers the question asked. Building the tool answers the
> question meant.

**When the artifact renders in the right panel — stop talking and use it.** Drag
the amperage slider. Let the on-time and rest-time readout move. Change voltage
input if the artifact exposes it.

**Then:**

> That was written by the model, live, this turn. It is React, and it is running
> in an iframe with `sandbox="allow-scripts"` and deliberately *without*
> `allow-same-origin` — which forces an opaque origin, so model-authored code
> can execute but cannot reach the host page's DOM, cookies or storage. Same
> posture Claude's own artifacts use.
>
> The model doesn't write the boilerplate. A harness supplies React, the Babel
> transform, the mount, the theme and error handling, so the model only writes
> the interesting part. Asking a model to emit a complete correct HTML document
> every single time is a reliable source of broken artifacts.

**Optional follow-up if you have room** — it demonstrates session resume:

> **And on 120V?**

> Sessions resume through the SSE stream, so follow-ups keep context without
> replaying history.

---

## 4:00 – 5:10 · The architecture

**On screen:** the README architecture diagram, then briefly `src/agent/tools.ts`.

**Say, tracing the diagram:**

> Offline, and already done — every PDF page is rastered at 150 dpi and also run
> through `pdftotext`. Both go to a vision model *together*, with an explicit
> instruction to trust the image when the two disagree, because the text layer
> is a useful spelling cross-check and an actively harmful source of truth for
> tables. Out comes structured markdown per page: verbatim prose, tables as real
> markdown tables, a figure block per diagram with an exhaustive description and
> a few seed questions phrased the way a user would actually ask, plus page
> metadata.
>
> That builds into 1063 typed chunks over 51 pages — and the granularity is
> deliberately mixed. 108 prose chunks, 16 tables, 143 figures, 796 atomic
> facts. A uniform chunk size would compromise all four: split a duty-cycle
> matrix across chunks and the model confidently reads the wrong row; bury
> "maximum wire spool weight, 10 pounds" in a 600-token prose block and it stops
> matching anything.
>
> Retrieval is BM25 plus domain re-rankers — welding synonym expansion so DCEP
> and "reverse polarity" hit the same chunks, numeric-token boosting because on
> a spec manual `200A` matching is worth more than any word matching, and
> chunk-kind priors conditioned on question shape, so "which socket" upweights
> figures and "duty cycle" upweights tables.
>
> The agent is the Claude Agent SDK with five in-process MCP tools:
> `search_manual`, `show_figure`, `render_page`, `create_artifact`, and
> `manual_overview`.

**Now the part worth pausing on — point at `show_figure` in tools.ts:**

> And here's the design decision I'd defend hardest. `show_figure` and
> `create_artifact` push a rich structured event to the browser over SSE, but
> return only a *short text acknowledgement* into the model's context —
> "displayed figure X from page 14." The base64 PNG and the multi-kilobyte
> artifact source never enter conversation history. That keeps every later turn
> cheap, keeps the context window for reasoning, and stops the model trying to
> re-read its own artifact source next turn.
>
> `render_page` is the one deliberate exception — it *does* put an image into
> the model's context, because its entire job is letting the model go look at a
> page it couldn't resolve from extracted text. That's the escape hatch that
> makes committing an offline extraction safe.

---

## 5:10 – 6:00 · Evaluation, honestly

**On screen:** run it live, it takes about a second:

```bash
npx tsx evals/recall.ts
```

**Say:**

> Two harnesses. This one needs no key and no model. It asks whether the correct
> manual page reaches the top-k for each of the 40 golden questions. Recall at
> 10 is 100 percent, at 5 it's 89.7, at 1 it's 66.7, MRR 0.7658. Retrieval is
> deterministic — no sampling, no network — so those reproduce exactly. That
> at-1 number is the honest headroom: the right page is always retrieved, it
> just isn't always ranked first.
>
> The end-to-end harness scores the full agent on all 40 questions across four
> separate sub-metrics. Total is 76.2 percent, plus or minus 5.8 — accuracy
> 83.5, grounding 97.0, multimodal 53.8, artifact 56.3. Zero tool-call failures
> across all 40.
>
> I want to be precise about that error bar. The per-question standard deviation
> is 18.7, and the run count is small, so a single run is a noisy sample. The
> harness reports a confidence interval rather than a bare number specifically
> so that a two-point move doesn't get read as a regression.
>
> The sub-metrics are kept separate for the same reason. Averaging them hides
> the interesting thing, which is that grounding is near-ceiling at 97 while
> multimodal and artifact sit in the mid-fifties. That's the real weakness: the
> agent is reliably *correct* and reliably *cited*, and it under-triggers the
> visual response. That's a prompt and tool-description problem, and it's where
> I'd spend the next day.
>
> Other known limits, briefly: retrieval is lexical only, so a heavily
> paraphrased question with no lexical or synonym overlap will miss. Extraction
> has not had a page-by-page human audit — pages 7 and 14 were spot-checked
> against independent sources, and `render_page` is the runtime mitigation.
> Artifacts need network access for the CDN fetches inside the sandbox. And
> there is no persistence: restart the server and history is gone.
>
> Full write-up is in the README, deeper technical detail in
> `docs/ARCHITECTURE.md`. Thanks for watching.

---

## Question bank

Primary demo questions, in order, chosen for reliability:

1. `What polarity setup do I need for flux-cored welding? Which socket does the ground clamp go in?` — figure + citation
2. `What's the duty cycle for MIG welding at 200A on 240V? I keep tripping thermal overload.` — table lookup + artifact
3. `And on 120V?` — session resume

Safe alternates if a take goes badly:

- `I'm getting porosity in my flux-cored welds.` — troubleshooting matrix plus weld-diagnosis figures
- `Which process should I use for 1/8 inch mild steel?` — hits the image-only selection chart, which is the strongest single proof that vision extraction did real work
- `What's the maximum wire spool weight and diameter this thing takes?` — a clean atomic-fact retrieval, fast and short

Avoid on camera: open-ended "tell me about this welder" (long, unfocused, no
figure) and anything about the nameplate voltage curves (a known
weaker-vocabulary area of retrieval).

## Editing notes

- Cut `npm install` wait time. Keep every model response uncut — the streaming
  is part of the point, and trimming it looks like you are hiding latency.
- Zoom on the figure lightbox and on the artifact controls. Both are illegible
  at full-screen 1080p.
- Do not add background music over the retrieval-numbers segment.
