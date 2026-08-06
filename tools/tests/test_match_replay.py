"""
Replay the matcher over a frozen 8-season corpus and compare to a baseline.

This is the cheap half of match validation. The live check
(`tools/check_match_corpus.py`) takes ~7 minutes and makes ~440 real Jellyfin
lookups, so it cannot gate a push; this runs the *same shipping matcher* over
frozen local fixtures in a couple of seconds with no network and no server.

Scope: the shipping `matchSeries` with community-map ids only. The identity
layer above it - overrides, the remote resolver, the film index - is covered
by the unit tests, `test_jellyfin`, and `check_match_corpus.py`, not by this
replay.

What it protects, specifically: twelve real false positives - each a different
work matched onto its franchise parent (Pokémon Concierge -> Pokémon at
S20E109, Nanoha EXCEEDS -> the 2004 series, SAO Alternative -> Sword Art Online).
They are asserted **by name**, because a summary count moving from 234 to 236
tells you nothing about whether the Pokémon bug came back. It also fails if a
named assertion matches NO corpus entry - an assertion with no subject reads
as a pass forever, the same way a mutation row whose anchor moved reports SKIP.

**The fixtures are gitignored, not committed.** They are a snapshot of the real
Jellyfin library - every title plus internal item ids - and this repo is public,
so committing them would publish an inventory of the media server. That means
this test SKIPS on a machine that hasn't built them, which is the right trade:
`run_all.py` can't run in CI anyway (Playwright against live dev servers), so
the fixture only ever needs to exist where the suite actually runs.

It measures matcher *logic*, not current holdings - the library snapshot ages
and that is expected. Build and re-baseline deliberately (`--write` refuses to
bake a known-bad pair into the baseline):

    py -3.13 -u tools/tests/build_match_fixtures.py      # needs backend + DB
    cd backend && TS_NODE_PROJECT=tsconfig.json \\
        npx ts-node --transpile-only ../tools/tests/match_replay.ts --write
"""
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
RUNNER = ROOT / "tools" / "tests" / "match_replay.ts"
FIXTURES = ROOT / "tools" / "tests" / "fixtures" / "match_corpus"


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    missing = [f for f in ("library.json", "entries.json", "ids.json", "baseline.json")
               if not (FIXTURES / f).exists()]
    if missing:
        # SKIP, not fail. The fixtures are gitignored (why: module docstring),
        # so a fresh clone legitimately has none - that must not read as a
        # broken suite.
        print(f"[1/1 match-replay] SKIP - no fixtures ({', '.join(missing)})", flush=True)
        print("  Build them once on a machine with the backend running:", flush=True)
        print("    py -3.13 -u tools/tests/build_match_fixtures.py", flush=True)
        print("    cd backend && TS_NODE_PROJECT=tsconfig.json \\", flush=True)
        print("        npx ts-node --transpile-only ../tools/tests/match_replay.ts --write", flush=True)
        print("match-replay: SKIPPED - no fixtures on this machine", flush=True)
        return 0

    print("[1/1 match-replay] replaying 945 entries against the committed baseline", flush=True)
    env = dict(os.environ, TS_NODE_PROJECT="tsconfig.json")
    # ts-node resolves its tsconfig from the *script* directory, and there is no
    # tsconfig above tools/, so without this it falls back to a NodeNext default
    # and refuses to compile. Running from backend/ with an explicit project is
    # what makes the shipping module settings apply.
    proc = subprocess.run(
        ["npx", "ts-node", "--transpile-only", str(RUNNER)],
        cwd=str(BACKEND), env=env, capture_output=True, text=True,
        encoding="utf-8", errors="replace", shell=(os.name == "nt"),
    )
    out = (proc.stdout or "") + (proc.stderr or "")
    for line in out.splitlines():
        if line.strip():
            print(f"  {line}", flush=True)
    if proc.returncode != 0:
        print("match-replay: FAILED - DO NOT deploy", flush=True)
        return 1
    print("match-replay: baseline matched - OK", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
