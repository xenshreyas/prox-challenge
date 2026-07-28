#!/usr/bin/env bash
#
# demo-reset.sh — prepare a clean demo of the Vulcan OmniPro 220 agent.
#
# Idempotent and non-destructive. It only ever reads, or creates things that
# are missing. It never deletes anything, never overwrites .env, and never
# touches kb/extracted/ or files/.
#
# Usage:  bash scripts/demo-reset.sh
#
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || { echo "cannot cd to $REPO_ROOT" >&2; exit 1; }

WARNINGS=0
BLOCKERS=0

ok()    { printf '  ok    %s\n' "$1"; }
warn()  { printf '  warn  %s\n' "$1"; WARNINGS=$((WARNINGS + 1)); }
fail()  { printf '  FAIL  %s\n' "$1"; BLOCKERS=$((BLOCKERS + 1)); }
head1() { printf '\n%s\n' "$1"; }

# count <dir> <glob> — number of matching files, 0 if the dir is absent
count() { find "$1" -maxdepth 1 -type f -name "$2" 2>/dev/null | wc -l | tr -d ' '; }

printf 'demo-reset — %s\n' "$REPO_ROOT"

# ---------------------------------------------------------------- node -------
head1 'Node'

if ! command -v node >/dev/null 2>&1; then
  fail "node not found on PATH. Install Node 20 or newer."
else
  NODE_RAW="$(node -v)"                 # e.g. v20.19.3
  NODE_MAJOR="${NODE_RAW#v}"
  NODE_MAJOR="${NODE_MAJOR%%.*}"
  if [ "$NODE_MAJOR" -ge 20 ] 2>/dev/null; then
    ok "node $NODE_RAW (>= 20 required)"
  else
    fail "node $NODE_RAW is too old; package.json requires >= 20"
  fi
fi

if command -v npm >/dev/null 2>&1; then
  ok "npm $(npm -v)"
else
  fail "npm not found on PATH"
fi

# ------------------------------------------------------------ dependencies ---
head1 'Dependencies'

if [ -d node_modules ]; then
  ok "node_modules present"
else
  warn "node_modules missing — run: npm install"
fi

# --------------------------------------------------------------- knowledge ---
head1 'Knowledge base'

if [ -f kb/index.json ]; then
  ok "kb/index.json present ($(wc -c < kb/index.json | tr -d ' ') bytes)"
else
  warn "kb/index.json missing — rebuilding with: npm run kb:build"
  if [ -d node_modules ]; then
    if npm run kb:build; then
      if [ -f kb/index.json ]; then
        ok "kb/index.json rebuilt"
      else
        fail "kb:build finished but kb/index.json still missing"
      fi
    else
      fail "npm run kb:build failed"
    fi
  else
    fail "cannot rebuild the KB without node_modules; run npm install first"
  fi
fi

PAGE_PNGS="$(count kb/pages '*.png')"
if [ "$PAGE_PNGS" -gt 0 ]; then
  ok "kb/pages: $PAGE_PNGS page rasters"
else
  warn "no page rasters found under kb/pages — figures will not render"
fi

EXTRACTED="$(count kb/extracted '*.md')"
if [ "$EXTRACTED" -gt 0 ]; then
  ok "kb/extracted: $EXTRACTED extracted pages"
else
  warn "no extracted pages under kb/extracted"
fi

# ------------------------------------------------------------------- env -----
head1 'Environment'

if [ -f .env ]; then
  ok ".env present (left untouched)"
  if grep -Eq '^[[:space:]]*ANTHROPIC_API_KEY[[:space:]]*=[[:space:]]*.+' .env; then
    ok "ANTHROPIC_API_KEY is set in .env"
  else
    warn "ANTHROPIC_API_KEY is empty in .env — the agent will not run live"
  fi
elif [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  ok "ANTHROPIC_API_KEY found in the shell environment (no .env needed)"
else
  warn "no .env found"
  if [ -f .env.example ]; then
    cp .env.example .env
    ok "created .env from .env.example — paste your ANTHROPIC_API_KEY into it"
  else
    fail ".env.example missing; cannot scaffold .env"
  fi
fi

# ------------------------------------------------------------------ ports ----
head1 'Ports'

for PORT in 8787 5173; do
  if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    warn "port $PORT is already in use — stop the existing process before demoing"
  else
    ok "port $PORT free"
  fi
done

# --------------------------------------------------------------- next steps --
head1 'Next steps'

cat <<'EOF'
  Full stack (backend :8787 + frontend :5173), the normal way to run it:
      npm run dev
      open http://localhost:5173

  No API key handy — canned multimodal transcript through the real UI:
      VITE_MOCK=1 npm run dev:web

  Retrieval recall, no key, no model, about a second:
      npx tsx evals/recall.ts

  End-to-end agent eval over the 40 golden questions (needs a key, spends tokens):
      npm run eval

  Type checking:
      npm run typecheck

  Demo questions, in order (see docs/DEMO_SCRIPT.md):
      1. What polarity setup do I need for flux-cored welding?
         Which socket does the ground clamp go in?
      2. What's the duty cycle for MIG welding at 200A on 240V?
         I keep tripping thermal overload.
      3. And on 120V?
EOF

# ------------------------------------------------------------------ summary --
head1 'Summary'

if [ "$BLOCKERS" -gt 0 ]; then
  printf '  %d blocker(s), %d warning(s). Fix the blockers above before demoing.\n\n' \
    "$BLOCKERS" "$WARNINGS"
  exit 1
elif [ "$WARNINGS" -gt 0 ]; then
  printf '  Ready, with %d warning(s) above.\n\n' "$WARNINGS"
  exit 0
else
  printf '  Ready.\n\n'
  exit 0
fi
