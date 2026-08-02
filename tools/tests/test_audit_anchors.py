"""Every mutation-audit row still points at code that exists.

`mutation_audit.py` breaks one invariant at a time by finding an exact string
in a source file and replacing it. When the code moves, that string stops
matching and the row reports `SKIP` — which is easy to miss in a 35-minute run
and means the invariant has silently stopped being audited.

That is not hypothetical. Batching the availability lookups moved the
`unknown`-never-hides guard into another file, and its row went on pointing at
code that no longer existed. Nothing failed; the row would simply have skipped
forever.

This is the cheap half of the problem. It runs in about a second, needs no
servers, starts no transcodes, and can therefore sit in `run_all.py` on every
push. It cannot tell you whether a row's *test* is meaningful — only a real
`mutation_audit.py` run does that, and six rows were once vacuous while every
anchor resolved perfectly. Treat a pass here as "the rows still aim at
something", not "the rows work".

Usage:
  py -3.13 -u tools/tests/test_audit_anchors.py
"""
from __future__ import annotations

import sys
from pathlib import Path

TESTS = Path(__file__).resolve().parent
sys.path.insert(0, str(TESTS))


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    try:
        import mutation_audit as ma
    except Exception as exc:  # a broken table is itself a failure
        print(f"[anchors] FAIL — could not import mutation_audit: {exc!r}", flush=True)
        return 1

    rows = ma.MUTATIONS
    print(f"[anchors] checking {len(rows)} mutation row(s)", flush=True)

    # Cache file reads: several rows edit the same file.
    text: dict[str, str] = {}

    def read(rel: str) -> str | None:
        if rel not in text:
            p = ma.REPO / rel
            try:
                text[rel] = p.read_text(encoding="utf-8")
            except OSError:
                return None
        return text[rel]

    stale: list[str] = []
    for i, m in enumerate(rows, 1):
        problems: list[str] = []

        src = read(m.path)
        if src is None:
            problems.append(f"file missing: {m.path}")
        else:
            if m.find not in src:
                problems.append("find")
            for j, (find, _) in enumerate(m.also):
                if find not in src:
                    problems.append(f"also[{j}]")

        for j, (path, find, _) in enumerate(m.extra):
            other = read(path)
            if other is None:
                problems.append(f"extra[{j}] file missing: {path}")
            elif find not in other:
                problems.append(f"extra[{j}]")

        if problems:
            stale.append(f"  [{i}] {m.name}\n      -> {', '.join(problems)}\n      in {m.path}")

    if stale:
        print(f"[anchors] FAIL — {len(stale)} row(s) no longer match the source:", flush=True)
        for s in stale:
            print(s, flush=True)
        print("[anchors] Those rows would SKIP, so the invariant is unaudited. "
              "Update the anchor text to wherever the guard now lives.", flush=True)
        return 1

    print(f"Done: all {len(rows)} mutation anchors resolve", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
