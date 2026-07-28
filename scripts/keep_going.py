#!/usr/bin/env python3
"""Keep the Prox challenge work going without a human in the loop.

Why this exists: the agent is turn-based. It runs, finishes a turn, and then
stops existing until something sends it another message. This script is that
something -- it pokes the agent on an interval so work continues unattended.

Usage:
    python3 ~/Documents/GitHub/prox-challenge/scripts/keep_going.py            # every 10 min, forever
    python3 .../keep_going.py --interval 300 --max-turns 20
    python3 .../keep_going.py --dry-run                                        # show what it would send

Stop it with Ctrl-C, or:
    touch ~/Documents/GitHub/prox-challenge/.STOP

The .STOP file is checked before every turn, so you can halt the loop from any
terminal without hunting for the process.
"""

from __future__ import annotations

import argparse
import datetime as dt
import pathlib
import subprocess
import sys
import time

REPO = pathlib.Path(__file__).resolve().parent.parent
STOP_FILE = REPO / ".STOP"
LOG_FILE = REPO / "keep-going.log"

# Kept deliberately short. The agent already has the full brief in its session
# context and in ~/Downloads/prox-challenge-engineering-log.md; restating the
# whole plan every turn would just burn tokens re-reading what it already knows.
PROMPT = (
    "Continue the Prox challenge work autonomously. Pick the single highest-value "
    "unfinished item, do it, verify it for real (typecheck/test/build or a measured "
    "eval run), and commit if it holds up. Do not ask questions -- there is no human "
    "waiting. Keep the engineering log at ~/Downloads/prox-challenge-engineering-log.md "
    "current. If an eval is already running, do useful work alongside it rather than "
    "waiting on it. "
    "IMPORTANT: end every turn by running `git push` so the work reaches the fork at "
    "github.com/xenshreyas/prox-challenge. A local commit that is never pushed is "
    "invisible to the user. Never force-push and never rewrite history."
)


def log(message: str) -> None:
    stamp = dt.datetime.now().strftime("%H:%M:%S")
    line = f"[{stamp}] {message}"
    print(line, flush=True)
    with LOG_FILE.open("a", encoding="utf-8") as fh:
        fh.write(line + "\n")


def run_turn(prompt: str, timeout: int) -> tuple[bool, str]:
    """Sends one prompt to the running Hermes session and returns (ok, tail)."""
    try:
        proc = subprocess.run(
            ["hermes", "-z", prompt, "--continue"],
            cwd=REPO,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return False, f"turn exceeded {timeout}s"
    except FileNotFoundError:
        return False, "hermes not found on PATH"

    out = (proc.stdout or "").strip()
    tail = out.splitlines()[-1][:160] if out else "(no output)"
    return proc.returncode == 0, tail


def push_if_needed() -> str:
    """Pushes any local commits the turn produced.

    Belt and braces: the prompt also asks the agent to push, but a turn that ends
    early, errors, or simply forgets would leave commits stranded on this machine.
    An unpushed commit is invisible to the user, which defeats the point of running
    the loop unattended, so the script enforces it rather than trusting the model.
    """
    try:
        ahead = subprocess.run(
            ["git", "log", "origin/main..HEAD", "--oneline"],
            cwd=REPO, capture_output=True, text=True, timeout=60,
        ).stdout.strip()
        if not ahead:
            return "nothing to push"
        n = len(ahead.splitlines())
        proc = subprocess.run(
            ["git", "push"], cwd=REPO, capture_output=True, text=True, timeout=300
        )
        return f"pushed {n} commit(s)" if proc.returncode == 0 else (
            f"PUSH FAILED: {(proc.stderr or '').strip().splitlines()[-1][:100]}"
        )
    except Exception as exc:  # noqa: BLE001 - never let pushing kill the loop
        return f"push error: {exc}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--interval", type=int, default=600, help="seconds between turns (default 600)")
    ap.add_argument("--max-turns", type=int, default=0, help="stop after N turns (0 = forever)")
    ap.add_argument("--timeout", type=int, default=3600, help="per-turn timeout in seconds")
    ap.add_argument("--dry-run", action="store_true", help="print the prompt and exit")
    args = ap.parse_args()

    if args.dry_run:
        print(PROMPT)
        return 0

    if STOP_FILE.exists():
        log(f"{STOP_FILE.name} exists -- remove it to start. Exiting.")
        return 0

    log(f"keep-going started: every {args.interval}s, max_turns={args.max_turns or 'unlimited'}")
    log(f"stop with Ctrl-C or: touch {STOP_FILE}")

    turn = 0
    try:
        while True:
            if STOP_FILE.exists():
                log(f"found {STOP_FILE.name} -- stopping.")
                return 0
            if args.max_turns and turn >= args.max_turns:
                log(f"reached max-turns={args.max_turns} -- stopping.")
                return 0

            turn += 1
            log(f"turn {turn}: sending nudge...")
            started = time.monotonic()
            ok, tail = run_turn(PROMPT, args.timeout)
            elapsed = time.monotonic() - started
            log(f"turn {turn}: {'ok' if ok else 'FAILED'} in {elapsed:.0f}s -- {tail}")
            log(f"turn {turn}: {push_if_needed()}")

            # Interruptible sleep so Ctrl-C and .STOP are responsive.
            for _ in range(args.interval):
                if STOP_FILE.exists():
                    break
                time.sleep(1)
    except KeyboardInterrupt:
        log("interrupted -- stopping.")
        return 0


if __name__ == "__main__":
    sys.exit(main())
