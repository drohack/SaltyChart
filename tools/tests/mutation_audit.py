"""
Is the pre-deploy suite load-bearing, or does it just pass?

`Pre-deploy: 12/12 passed — ready to build` is the sentence the whole deploy
rests on, and a passing suite says nothing about what it would *catch*. This
breaks one invariant at a time and checks that the test guarding it actually
fails. A mutation that survives is a coverage hole, reported as one.

It found real holes the first time it was run by hand. Two of three mutations
shipped green: the Jellyfin API key stopped being stripped from the URL handed
to browsers (test_jellyfin passed 10/10; test_player failed with the unrelated
message "video never advanced"), and the AniList->TVDB match tier was disabled
so every match silently fell back to fuzzy titles (10/10 again). Both are
failure classes that have already happened in this repo.

Deliberately NOT part of run_all.py: it edits tracked source and is slow. It is
a periodic audit, not a deploy gate. Add a row here whenever you add a test —
a test nobody has watched fail is a test nobody should trust.

Two things about the table are load-bearing, not cosmetic. Rows are **sorted by
the file they edit**, because every switch back to a backend file restarts
ts-node-dev; and the player rows run a **single step** rather than the whole
player test,
because each step that switches stream costs a real transcode. Running this
without either of those pushed the Jellyfin server process to ~800% CPU.

Usage:
  py -3.13 -u tools/tests/mutation_audit.py                # every mutation
  py -3.13 -u tools/tests/mutation_audit.py --only 3       # one, while iterating
  py -3.13 -u tools/tests/mutation_audit.py --list         # just show the table

Needs the same running dev servers as the suite it audits.
"""
import argparse
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TESTS = REPO / "tools" / "tests"


def say(msg: str = "") -> None:
    print(msg, flush=True)


@dataclass
class Mutation:
    """One invariant, the edit that breaks it, and the test that must notice."""
    name: str
    path: str                 # repo-relative
    find: str
    replace: str
    test: list[str]           # argv, run from REPO
    expect: str               # substring the FAILING output must contain
    guards: str               # what breaks in production if this goes unnoticed
    # Some invariants are enforced in more than one place, and breaking a single
    # site leaves the others still holding the line — the mutation then reads as
    # 'survived' when it was simply too narrow to change any behaviour.
    also: list[tuple[str, str]] = field(default_factory=list)
    settle: float = 6.0       # ts-node-dev / vite need a moment to reload
    env: dict = field(default_factory=dict)


BACKEND_JF = "backend/src/routes/jellyfin.ts"
PLAYER = "frontend/src/components/JellyfinPlayerModal.svelte"

PY = ["py", "-3.13", "-u"]
T_JELLYFIN = PY + [str(TESTS / "test_jellyfin.py")]
def player(*steps: int) -> list[str]:
    """The player test, limited to the steps guarding one invariant.

    A full run starts four real transcodes; a targeted one starts two. Across
    five player mutations that is the bulk of the audit's encode load, and none
    of those mutations touches the steps being skipped.
    """
    return PY + [str(TESTS / "test_player.py"),
                 "--only-steps", ",".join(str(s) for s in steps)]
T_NEGATIVE = PY + [str(TESTS / "test_api_negative.py")]
T_UI = PY + [str(TESTS / "test_ui_interactions.py")]
T_UNIT = ["npm", "run", "test:unit"]

MUTATIONS: list[Mutation] = [
    Mutation(
        name="Jellyfin API key is no longer stripped from transcodingUrl",
        path=BACKEND_JF,
        find="""      for (const k of [...params.keys()]) {
        if (/^(api_?key|x-emby-token)$/i.test(k)) params.delete(k);
      }""",
        replace="      /* mutation: strip disabled */",
        test=T_JELLYFIN,
        expect="transcodingUrl containing a credential",
        guards="the server's Jellyfin credential is handed to every viewer's browser",
    ),
    Mutation(
        name="AniList->TVDB id match tier disabled",
        path=BACKEND_JF,
        find="    const entry = { tvdbId: tvdbIdForAnilist(mediaId), titles };",
        replace="    const entry = { tvdbId: null, titles }; /* mutation */",
        test=T_JELLYFIN,
        expect="NONE by id",
        guards="every match silently degrades to fuzzy titles, which has already "
               "matched a 2026 show to a 2004 one",
    ),
    Mutation(
        name="subtitles 'Off' stops sending subtitleStreamIndex=-1",
        path=BACKEND_JF,
        find="      ...(Number.isInteger(subtitleIndex) && subtitleIndex >= -1",
        replace="      ...(Number.isInteger(subtitleIndex) && subtitleIndex >= 0",
        test=player(8),
        expect="they are not being burned in",
        guards="Jellyfin picks a default track and burns it in, so subtitles stay "
               "on screen for a viewer who just turned them off",
    ),
    Mutation(
        name="a stream restart drops the requested quality",
        path=PLAYER,
        find="""        fresh: true,
        quality,
        subtitleIndex: activeSubIndex,""",
        replace="""        fresh: true,
        subtitleIndex: activeSubIndex,""",
        test=player(9),
        expect="the restart did not carry the new quality",
        guards="the quality menu selects a tier and changes nothing",
    ),
    Mutation(
        name="the abandoned session is never stopped on a restart",
        path=PLAYER,
        find="      if (abandoned && abandoned !== playSessionId) stopSession(abandoned);",
        replace="      /* mutation: orphan the old session */",
        test=player(9),
        expect="the abandoned session was never stopped",
        guards="every track or quality change leaves an ffmpeg writing a ~1 GB "
               "episode to the transcode cache for nobody",
    ),
    Mutation(
        name="an interrupted play() counts as autoplay-blocked",
        path=PLAYER,
        find="    if ((err as DOMException | undefined)?.name !== 'NotAllowedError') return;",
        replace="    if (false) return;",
        test=player(9),
        expect="big play button flashed",
        guards="a big play button flashes over a video that is already restarting",
    ),
    Mutation(
        name="the seek bar is not pinned during a rebuild",
        path=PLAYER,
        find="      player.addClass?.('sc-rebuilding');",
        replace="      /* mutation: no freeze */",
        test=player(9),
        expect="seek bar collapsed",
        guards="the played section collapses to zero mid-switch, so a viewer 10 "
               "minutes in appears to have lost their place",
    ),
    Mutation(
        name="the JWT `id` guard is removed",
        path="backend/src/middleware/auth.ts",
        find="""  if (typeof payload?.id !== 'number') {
    return res.status(401).json({ error: 'Invalid token', code: 'INVALID_TOKEN' });
  }

""",
        replace="",
        test=T_NEGATIVE,
        expect="request hung",
        guards="a signed token with no id hangs the request forever instead of 401",
    ),
    Mutation(
        name="an `unknown` availability verdict is treated as a definite 'no'",
        path="frontend/src/pages/Randomize.svelte",
        find="        if (!c.info.unknown) next.set(c.item.id, c.info.available);",
        replace="        next.set(c.item.id, c.info.available); /* mutation */",
        # Guarded in two places: the bulk prefetch and the per-item recheck.
        # Breaking only the first leaves the second still filtering, so the
        # button stays correctly disabled and the mutation proves nothing.
        also=[("          if (!info.unknown) recordAvailability(item.id, info.available);",
               "          recordAvailability(item.id, info.available); /* mutation */")],
        test=T_UI,
        # The failure text, not the pass text — 'unknown verdicts' appears only
        # in the PASS line, so matching it reported a real catch as a hole.
        expect="is enabled while every lookup returned unknown",
        guards="one slow moment from Jellyfin empties the whole wheel, because "
               "'couldn't ask' gets recorded as 'not in the library'",
    ),
    Mutation(
        name="share-as-image can no longer resolve toJpeg",
        path="frontend/src/components/WatchListSidebar.svelte",
        find="      const toJpeg = (domToImageMod.toJpeg ?? domToImageMod.default?.toJpeg) as (",
        replace="      const toJpeg = (domToImageMod.nope ?? domToImageMod.default?.nope) as (",
        test=T_UI,
        expect="Share produced nothing",
        guards="Share silently does nothing — the failure is swallowed by its own "
               "try/catch, the same shape that downgraded every ASS release to WebVTT",
    ),
    Mutation(
        name="the Compare user search stops querying the backend",
        path="frontend/src/pages/Compare.svelte",
        find="          bind:filterText={otherInput}",
        replace="          bind:searchText={otherInput}",
        test=T_UI,
        expect="never offered by the picker",
        guards="the second-user picker is capped at whatever /api/users returns "
               "unfiltered, so most users cannot be compared with at all",
    ),
    Mutation(
        name="the 8-bit ceiling is dropped from the DeviceProfile",
        path="backend/src/lib/jellyfinApi.ts",
        find="            Property: ProfileConditionValue.VideoBitDepth,",
        replace="            Property: ProfileConditionValue.VideoLevel, /* mutation */",
        test=T_UNIT,
        expect="8-bit ceiling stays",
        guards="Hi10P anime releases play as a black picture in Chrome",
        settle=0.0,
    ),
    Mutation(
        name="the device id stops matching ActiveEncodings",
        path="backend/src/lib/jellyfinApi.ts",
        find="export const DEVICE_ID = 'saltychart';",
        replace="export const DEVICE_ID = 'saltychart-x'; /* mutation */",
        test=T_UNIT,
        expect="device id ActiveEncodings",
        guards="closing the player stops telling Jellyfin to kill the transcode, "
               "silently, because the stop matches nothing",
        settle=0.0,
    ),
]


# Grouped by the file each row edits, so the audit stops bouncing between the
# backend and frontend dev servers — every switch back to a backend file costs a
# ts-node-dev restart. Enforced by sorting rather than by hand-ordering the list
# above, so adding a row in the wrong place cannot quietly undo it. Sorting by
# path also puts all `backend/` rows first, which is where the restarts are.
MUTATIONS.sort(key=lambda m: m.path)


def git(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=REPO, capture_output=True, text=True)


def dirty_paths() -> list[str]:
    out = git("status", "--porcelain").stdout.strip()
    return [l[3:] for l in out.splitlines() if l.strip()]


def apply(m: Mutation) -> bool:
    f = REPO / m.path
    src = f.read_text(encoding="utf-8")
    if m.find not in src:
        return False
    src = src.replace(m.find, m.replace, 1)
    for find, replace in m.also:
        if find not in src:
            return False
        src = src.replace(find, replace, 1)
    f.write_text(src, encoding="utf-8", newline="")
    return True


def restore(m: Mutation) -> None:
    git("checkout", "--", m.path)


def run_test(m: Mutation) -> tuple[bool, str]:
    """True when the test PASSED (i.e. the mutation went unnoticed)."""
    cwd = REPO / "backend" if m.test is T_UNIT else REPO
    shell = sys.platform == "win32" and m.test[0] in ("npm", "npx")
    try:
        r = subprocess.run(m.test, cwd=cwd, capture_output=True, text=True,
                           timeout=900, shell=shell, encoding="utf-8", errors="replace")
    except subprocess.TimeoutExpired:
        return False, "TIMED OUT"
    return r.returncode == 0, (r.stdout or "") + (r.stderr or "")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", type=int, help="run a single mutation by number")
    ap.add_argument("--list", action="store_true", help="show the table and exit")
    args = ap.parse_args()

    if args.list:
        for i, m in enumerate(MUTATIONS, 1):
            say(f"{i:>2}. {m.name}\n     guards: {m.guards}")
        return 0

    # A mutation is reverted with `git checkout --`, which would also throw away
    # uncommitted work in the same file. Refuse rather than risk it.
    chosen = [MUTATIONS[args.only - 1]] if args.only else MUTATIONS
    if args.only and not (1 <= args.only <= len(MUTATIONS)):
        say(f"--only must be 1..{len(MUTATIONS)}")
        return 2

    # Only the files this run will actually revert. Checking every row's target
    # blocked `--only 9` because some unrelated file had edits in it, which is a
    # guard being unhelpful rather than safe.
    dirty = dirty_paths()
    targets = {m.path for m in chosen}
    clash = sorted(targets & set(dirty))
    if clash:
        say("Refusing to run: these files have uncommitted changes and would be "
            "reverted by this audit —")
        for c in clash:
            say(f"   {c}")
        say("\nCommit or stash them first.")
        return 2

    say(f"Mutation audit — {len(chosen)} mutation(s), each must be CAUGHT by its test")
    say("Servers must be running, same as the suite this audits.\n")

    survived: list[str] = []
    skipped: list[str] = []
    try:
        for i, m in enumerate(chosen, 1):
            n = args.only or i
            say(f"[{n}/{len(MUTATIONS)}] {m.name}")
            if not apply(m):
                say("      SKIP — anchor text not found; the code moved, update this row\n")
                skipped.append(m.name)
                continue
            try:
                if m.settle:
                    time.sleep(m.settle)  # let ts-node-dev / vite pick the edit up
                t0 = time.time()
                passed, out = run_test(m)
            finally:
                restore(m)
            took = time.time() - t0
            if passed:
                say(f"      SURVIVED in {took:.0f}s — nothing caught it")
                say(f"      would ship: {m.guards}\n")
                survived.append(m.name)
            elif m.expect and m.expect.lower() not in out.lower():
                # Red is not the same as covered, and conflating the two is the
                # exact mistake this audit exists to catch: a leaked credential
                # once turned a test red with the message "video never advanced"
                # — a real failure pointing at the wrong subsystem, which nobody
                # would have traced back. If no assertion names this invariant,
                # it is still a hole, however red the run looks.
                why = next((l for l in out.splitlines() if "FAIL" in l), "").strip()
                say(f"      WRONG REASON in {took:.0f}s — red, but not because of "
                    f"this invariant")
                say(f"      expected to see: {m.expect!r}")
                say(f"      actually failed: {why[:120] or '(no FAIL line)'}")
                say(f"      still unguarded: {m.guards}\n")
                survived.append(f"{m.name}  [red for an unrelated reason]")
            else:
                hit = next((l for l in out.splitlines()
                            if m.expect.lower() in l.lower()), "").strip()
                say(f"      caught in {took:.0f}s — {hit[:150]}\n")
    finally:
        # Belt and braces: restore what this run touched, including on Ctrl-C.
        #
        # `chosen`, NOT `MUTATIONS`. This looped over every row once, so a
        # `--only 1` run ran `git checkout --` across all thirteen target files
        # and destroyed uncommitted work in two of them that the run never even
        # touched. The dirty-tree check above is scoped to `chosen`; if this is
        # ever widened again, that guard silently stops covering it.
        for m in chosen:
            restore(m)

    total = len(chosen) - len(skipped)
    say(f"Done: {total - len(survived)}/{total} caught"
        + (f", {len(skipped)} skipped" if skipped else ""))
    for s in survived:
        say(f"   COVERAGE HOLE: {s}")
    return 1 if survived else 0


if __name__ == "__main__":
    sys.exit(main())
