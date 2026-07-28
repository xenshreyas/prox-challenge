import type { StreamEvent } from '../types';

/**
 * MOCK MODE (VITE_MOCK=1).
 *
 * Replays a canned, hand-authored SSE transcript so the UI can be developed and
 * demoed without an Anthropic API key or a running backend. This is the ONLY
 * place in the app where content is fabricated, and every mock answer is
 * labelled in the UI by the MOCK badge in the header.
 *
 * Prose here is transcribed from the Vulcan OmniPro 220 owner's manual
 * (Harbor Freight item 57812) so the demo is at least factually grounded.
 */

interface Script {
  match: RegExp | null;
  events: StreamEvent[];
}

const chunk = (text: string): StreamEvent[] =>
  // split on word boundaries to look like real token streaming
  text
    .split(/(?<=\s)/)
    .filter(Boolean)
    .map((t) => ({ type: 'token', text: t }) as StreamEvent);

const DUTY_CYCLE_ARTIFACT = `import React, { useState, useMemo } from 'react';

const TABLE = {
  '120': {
    MIG:   { min: 30, max: 140, points: [[40,100],[60,85],[100,75]] },
    TIG:   { min: 10, max: 125, points: [[40,125],[60,105],[100,90]] },
    Stick: { min: 10, max: 80,  points: [[40,80],[60,70],[100,60]] },
  },
  '240': {
    MIG:   { min: 30, max: 220, points: [[25,200],[60,130],[100,115]] },
    TIG:   { min: 10, max: 175, points: [[30,175],[60,125],[100,105]] },
    Stick: { min: 10, max: 175, points: [[25,175],[60,115],[100,100]] },
  },
};

function dutyFor(points, amps) {
  // piecewise-linear interpolation across the nameplate three-point curve
  const sorted = [...points].sort((a, b) => a[1] - b[1]); // by amps asc
  if (amps <= sorted[0][1]) return 100;
  if (amps >= sorted[sorted.length - 1][1]) return sorted[sorted.length - 1][0];
  for (let i = 0; i < sorted.length - 1; i++) {
    const [d1, a1] = sorted[i], [d2, a2] = sorted[i + 1];
    if (amps >= a1 && amps <= a2) {
      const t = (amps - a1) / (a2 - a1);
      return d1 + t * (d2 - d1);
    }
  }
  return 100;
}

export default function DutyCycleCalculator() {
  const [volts, setVolts] = useState('240');
  const [process, setProcess] = useState('MIG');
  const spec = TABLE[volts][process];
  const [amps, setAmps] = useState(150);
  const clamped = Math.min(Math.max(amps, spec.min), spec.max);
  const duty = useMemo(() => dutyFor(spec.points, clamped), [spec, clamped]);
  const weldMin = (duty / 100) * 10;
  const restMin = 10 - weldMin;

  return (
    <div style={{ fontFamily: 'Inter, system-ui, sans-serif', color: '#e6edf3' }}>
      <h2 style={{ margin: '0 0 4px', fontSize: 18 }}>Duty Cycle Calculator</h2>
      <p style={{ margin: '0 0 18px', color: '#8b949e', fontSize: 13 }}>
        OmniPro 220 — nameplate curves, manual p.&nbsp;7 &amp; p.&nbsp;16. Duty cycle is
        measured over any 10-minute window.
      </p>

      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        {['120', '240'].map((v) => (
          <button key={v} onClick={() => setVolts(v)}
            style={btn(volts === v)}>{v} VAC</button>
        ))}
        <span style={{ width: 12 }} />
        {['MIG', 'TIG', 'Stick'].map((p) => (
          <button key={p} onClick={() => setProcess(p)}
            style={btn(process === p)}>{p}</button>
        ))}
      </div>

      <label style={{ fontSize: 12, color: '#8b949e', letterSpacing: '.08em' }}>
        OUTPUT CURRENT — {clamped} A (range {spec.min}–{spec.max} A)
      </label>
      <input type="range" min={spec.min} max={spec.max} value={clamped}
        onChange={(e) => setAmps(Number(e.target.value))}
        style={{ width: '100%', accentColor: '#ff8a3d', margin: '10px 0 22px' }} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 12 }}>
        <Stat label="Duty cycle" value={duty.toFixed(0) + '%'} accent />
        <Stat label="Weld time" value={weldMin.toFixed(1) + ' min'} />
        <Stat label="Cool time" value={restMin.toFixed(1) + ' min'} />
      </div>

      <div style={{ marginTop: 18, height: 14, background: '#161b22', borderRadius: 7, overflow: 'hidden', display: 'flex' }}>
        <div style={{ width: duty + '%', background: 'linear-gradient(90deg,#ff8a3d,#ffc46b)' }} />
        <div style={{ flex: 1, background: '#21262d' }} />
      </div>
      <p style={{ marginTop: 14, fontSize: 12, color: '#8b949e' }}>
        Leave the power switch ON while cooling so the internal fan runs (p.&nbsp;19).
        Values between nameplate points are interpolated.
      </p>
    </div>
  );
}

const btn = (on) => ({
  padding: '7px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600,
  border: '1px solid ' + (on ? '#ff8a3d' : '#30363d'),
  background: on ? 'rgba(255,138,61,.14)' : '#161b22',
  color: on ? '#ffb27d' : '#c9d1d9',
});

function Stat({ label, value, accent }) {
  return (
    <div style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 10, padding: '12px 14px' }}>
      <div style={{ fontSize: 11, letterSpacing: '.1em', color: '#8b949e' }}>{label.toUpperCase()}</div>
      <div style={{ fontSize: 26, fontWeight: 700, color: accent ? '#ff8a3d' : '#e6edf3' }}>{value}</div>
    </div>
  );
}
`;

const WIRE_CHART_ARTIFACT = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { font-family: Inter, system-ui, sans-serif; background: transparent; color: #e6edf3; margin: 0; }
  h2 { font-size: 17px; margin: 0 0 12px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid #21262d; }
  th { color: #8b949e; font-size: 11px; letter-spacing: .09em; text-transform: uppercase; }
  tr:hover td { background: rgba(255,138,61,.06); }
  code { color: #ffb27d; font-family: 'JetBrains Mono', monospace; }
</style></head>
<body>
  <h2>Wire size vs. material thickness</h2>
  <table>
    <thead><tr><th>Wire</th><th>Type</th><th>Typical thickness</th></tr></thead>
    <tbody>
      <tr><td><code>0.025"</code></td><td>Solid (MIG)</td><td>24 ga – 1/8"</td></tr>
      <tr><td><code>0.030"</code></td><td>Solid / flux-cored</td><td>22 ga – 3/16"</td></tr>
      <tr><td><code>0.035"</code></td><td>Solid / flux-cored</td><td>20 ga – 1/4"</td></tr>
      <tr><td><code>0.045"</code></td><td>Flux-cored only</td><td>1/8" – 1/4"+</td></tr>
    </tbody>
  </table>
  <p style="color:#8b949e;font-size:12px;margin-top:14px">
    Wire speed range 50–500 IPM; spools up to 12 lb. Manual p.&nbsp;7.
  </p>
</body></html>
`;

const SCRIPTS: Script[] = [
  {
    match: /duty\s*cycle|overheat|how long can i weld/i,
    events: [
      { type: 'tool', name: 'search_manual', input: { query: 'duty cycle rated output' } },
      ...chunk(
        '## Duty cycle on the OmniPro 220\n\nDuty cycle is the number of minutes you may weld within any **10-minute** window at a given output current. It depends on both the input voltage and the process.\n\n| Process | Input | Current range | Rated duty cycle |\n| --- | --- | --- | --- |\n| MIG | 120 VAC | 30–140 A | 40% @ 100 A · 100% @ 75 A |\n| MIG | 240 VAC | 30–220 A | 25% @ 200 A · 100% @ 115 A |\n| TIG | 240 VAC | 10–175 A | 30% @ 175 A · 100% @ 105 A |\n| Stick | 240 VAC | 10–175 A | 25% @ 175 A · 100% @ 100 A |\n\nSo at **200 A on 240 V MIG**, 25% means 2.5 minutes of arc time followed by 7.5 minutes of cooling.\n\n',
      ),
      {
        type: 'figure',
        figure: {
          doc: 'owner-manual',
          page: 7,
          slug: 'specifications-table',
          caption: 'Specifications — welding current ranges and rated duty cycles',
          imageUrl: '/kb/pages/owner-manual-07.png',
          description:
            'Specifications table listing input voltage, current input at rated output, welding current range and rated duty cycles for MIG, TIG and Stick.',
        },
      },
      ...chunk(
        'If the machine does trip its thermal protection, it shuts the output down and shows a warning screen. **Leave the power switch ON** so the internal fan keeps running — it returns to service automatically once cool.\n\nI built you a calculator for the in-between points:\n',
      ),
      {
        type: 'artifact',
        artifact: {
          id: 'duty-cycle-calc',
          title: 'Duty Cycle Calculator',
          mimeType: 'application/vnd.react+jsx',
          code: DUTY_CYCLE_ARTIFACT,
        },
      },
      { type: 'citation', citation: { doc: 'owner-manual', page: 7, section: 'Specifications' } },
      { type: 'citation', citation: { doc: 'owner-manual', page: 16, section: 'Nameplate' } },
      { type: 'citation', citation: { doc: 'owner-manual', page: 19, section: 'Duty Cycle' } },
      { type: 'done', sessionId: 'mock-session' },
    ],
  },
  {
    match: /wire|spool|thickness|gauge/i,
    events: [
      { type: 'tool', name: 'search_manual', input: { query: 'wire size capacity spool' } },
      ...chunk(
        "### Wire capacity\n\nThe OmniPro 220 feeds **solid wire** in 0.025\", 0.030\" and 0.035\", and **flux-cored wire** in 0.030\", 0.035\" and 0.045\". Wire feed speed is adjustable from **50 to 500 IPM**, and the compartment takes spools up to **12 lb**.\n\nAluminium wire requires the optional spool gun — the built-in drive will not feed it reliably.\n\n",
      ),
      {
        type: 'artifact',
        artifact: {
          id: 'wire-chart',
          title: 'Wire Selection Chart',
          mimeType: 'text/html',
          code: WIRE_CHART_ARTIFACT,
        },
      },
      { type: 'citation', citation: { doc: 'owner-manual', page: 7, section: 'Specifications' } },
      { type: 'done', sessionId: 'mock-session' },
    ],
  },
  {
    match: /panel|control|knob|button|display|front/i,
    events: [
      { type: 'tool', name: 'find_figure', input: { query: 'front control panel callouts' } },
      ...chunk(
        '### Front panel controls\n\nFrom the top down: the **LCD display**, with the **HOME** button to its lower-left and **BACK** to its lower-right. Below those sit three knobs — the **left knob** (wire feed), the **main control knob**, and the **right knob** (voltage). The wire spool compartment door, power switch and vents run along the lower front, with the MIG gun socket, positive socket and negative socket along the bottom edge.\n\n',
      ),
      {
        type: 'figure',
        figure: {
          doc: 'owner-manual',
          page: 8,
          slug: 'front-panel-callouts',
          caption: 'Front panel — labelled controls and sockets',
          imageUrl: '/kb/pages/owner-manual-08.png',
          description: 'Exterior callout diagram of the machine front panel.',
        },
      },
      { type: 'citation', citation: { doc: 'owner-manual', page: 8, section: 'Know Your Product' } },
      { type: 'done', sessionId: 'mock-session' },
    ],
  },
  {
    match: null,
    events: [
      { type: 'tool', name: 'search_manual', input: { query: 'general' } },
      ...chunk(
        "You're running in **mock mode**, so I'm replaying a canned transcript rather than reasoning over the manual.\n\nThe real agent searches the indexed OmniPro 220 owner's manual, pulls the relevant page images, and cites every claim by page. To try it for real, stop this dev server, set `ANTHROPIC_API_KEY` in `.env`, and run `npm run dev` without `VITE_MOCK=1`.\n\nThe scripted demo questions that have full canned answers are:\n\n- Duty cycle / how long can I weld\n- Wire sizes and spool capacity\n- Front panel controls\n",
      ),
      { type: 'citation', citation: { doc: 'owner-manual', page: 1, section: 'Cover Page' } },
      { type: 'done', sessionId: 'mock-session' },
    ],
  },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function* mockStream(
  prompt: string,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const script = SCRIPTS.find((s) => s.match && s.match.test(prompt)) ?? SCRIPTS.at(-1)!;
  await sleep(320);
  for (const ev of script.events) {
    if (signal?.aborted) return;
    yield ev;
    if (ev.type === 'token') await sleep(6 + Math.random() * 18);
    else await sleep(260);
  }
}
