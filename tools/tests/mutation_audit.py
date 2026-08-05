"""
Is the pre-deploy suite load-bearing, or does it just pass?

`Pre-deploy: 15/15 passed — ready to build` is the sentence the whole deploy
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
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path

import warm_cache

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
    # Same idea as `also`, but for sites in *other* files: (path, find, replace).
    # Needed because a guard can legitimately live at more than one layer — the
    # "never act on an `unknown` availability verdict" rule is enforced both
    # where server data enters the store and again in the page that consumes it.
    # Breaking either alone changes no behaviour, because the other still holds,
    # so the mutation reads as 'survived' while proving nothing. The answer is to
    # let the audit express the invariant, not to thin out a safety guard so a
    # single-file mutation can reach it.
    extra: list[tuple[str, str, str]] = field(default_factory=list)
    settle: float = 6.0       # ts-node-dev / vite need a moment to reload
    env: dict = field(default_factory=dict)

    @property
    def paths(self) -> list[str]:
        """Every file this mutation edits, so all of them get reverted."""
        seen = [self.path] + [p for p, _, _ in self.extra]
        return list(dict.fromkeys(seen))


BACKEND_JF = "backend/src/routes/jellyfin.ts"
BACKEND_MATCH = "backend/src/lib/animeMatch.ts"
BACKEND_IDENTITY = "backend/src/lib/seriesIdentity.ts"
BACKEND_REMOTE = "backend/src/lib/remoteIdentity.ts"
PLAYER = "frontend/src/components/JellyfinPlayerModal.svelte"
ADMIN_MATCHING = "frontend/src/pages/AdminMatching.svelte"

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
T_REPLAY = PY + [str(TESTS / "test_match_replay.py")]

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
        name="AniList->TVDB/TMDB id match tier disabled",
        path=BACKEND_JF,
        # Both ids, not just tvdbId. Nulling TVDB alone leaves the tier alive
        # through TMDB — measured: step 6 still found id matches, and the
        # mutation was caught by an unrelated assertion instead. A row that
        # fails for the wrong reason audits nothing.
        find="""    const identity = resolveIdentity(mediaId);""",
        replace="""    const identity = { ...resolveIdentity(mediaId), tvdbId: null, tmdbId: null }; /* mutation */""",
        test=T_JELLYFIN,
        expect="NONE by id",
        guards="every match silently degrades to fuzzy titles, which has already "
               "matched a 2026 show to a 2004 one",
    ),
    Mutation(
        name="a known id no longer rules out a title match",
        path=BACKEND_MATCH,
        # Removing the negative-evidence rule, i.e. restoring the fallback that
        # produced every remaining false positive. The replay names the pairs it
        # brings back rather than reporting a moved count.
        # This row and "a guessed id gains negative-evidence power" mutate the
        # same line in opposite directions, which is exactly right: one deletes
        # negative evidence, the other hands it to guesses. Both are wrong, in
        # ways that produce different bugs.
        find="    if (entry.idIsAuthoritative !== false) return null;",
        replace="    /* mutation: fall back to titles */",
        test=T_REPLAY,
        expect="franchise-sibling false positive is back",
        guards="a new work resolves to its franchise parent — Pokemon Concierge "
               "played episode 109 of season 20 of Pokemon",
    ),
    Mutation(
        name="a guessed id gains negative-evidence power",
        path=BACKEND_MATCH,
        # Resolver ids must be positive-only. Granting them both directions lets
        # an unverified TMDB guess delete a working title match — the same
        # false-positive class as the franchise siblings, from the other side.
        find="    if (entry.idIsAuthoritative !== false) return null;",
        replace="    return null; /* mutation */",
        test=T_UNIT,
        expect="positive-only",
        guards="an unverified guess suppresses a Watch button that works today",
    ),
    Mutation(
        name="the air-date gate stops rejecting absurd remote matches",
        path=BACKEND_REMOTE,
        # Without it, "5-Oku-nen Button Part 2" resolves to Babylon 5 (9,441 days
        # off) and "Star Wars: Visions Volume 3" to Star Wars Rebels (2,795).
        find="""    if (input.deltaMs <= AIR_DATE_TOLERANCE_MS) {
      return { verdict: 'accept', rung: `air date ${days(input.deltaMs)}d` };
    }""",
        replace="""    if (input.deltaMs >= 0) { /* mutation: everything within tolerance */
      return { verdict: 'accept', rung: `air date ${days(input.deltaMs)}d` };
    }""",
        test=T_UNIT,
        expect="should reject",
        guards="a TMDB search result decades away from the entry is written into "
               "the identity table as fact",
    ),
    Mutation(
        name="a film we don't hold falls back to matching TV series",
        path=BACKEND_JF,
        # Restoring the category error: without the early return, a film id that
        # isn't in the film index drops through to title-matching a series-only
        # list. Measured at 26 wrong matches against 1 real one.
        find="""      if (!film) {
        const data = { available: false, matchedBy: 'id' };
        rememberAvailability(mediaId, data, 10 * 60 * 1000);
        return data;
      }""",
        replace="      if (!film) { /* mutation: fall through to series */ } else {",
        also=[("      rememberAvailability(mediaId, data, 60 * 60 * 1000);\n      return data;\n    }\n\n    const entry = {",
               "      rememberAvailability(mediaId, data, 60 * 60 * 1000);\n      return data;\n      }\n    }\n\n    const entry = {")],
        test=T_JELLYFIN,
        expect="fell through to a SERIES title match",
        guards="a film resolves to the television series of the same name — "
               "The Last Blossom played House",
    ),
    Mutation(
        name="an explicit rejection no longer suppresses the title match",
        path=BACKEND_JF,
        # This shipped broken and no test caught it: a rejection carries no ids,
        # so without the short-circuit it falls through to the title tier — the
        # very match being rejected. It looked fixed on screen (the row leaves
        # the review list) while the Watch button stayed.
        find="    if (identity.rejected) {",
        replace="    if (false) { /* mutation */",
        test=T_JELLYFIN,
        expect="override did not change the verdict",
        guards="Reject on /admin/matching saves a row, drops the entry from the "
               "list, and leaves the wrong Watch button on screen",
    ),
    Mutation(
        name="a recorded miss shadows the community map",
        path=BACKEND_IDENTITY,
        # Both halves of "check again later" were broken by the same bookkeeping
        # row. This half meant a pair added upstream could never take effect:
        # once we had looked and failed, our empty row answered first, forever.
        # Nothing observable goes wrong — the system just silently stops
        # improving, which is why it needs a test rather than a reader.
        find="  if (override && !isBookkeeping) return override;",
        replace="  if (override) return override; /* mutation */",
        test=T_UNIT,
        expect="shadow the community map",
        guards="identity quietly stops improving as the upstream map fills in",
    ),
    Mutation(
        name="a failed lookup retires an entry forever",
        path=BACKEND_IDENTITY,
        # The other half: the sweep filtered on \"has any identity row\", so one
        # empty search result took the entry out of scope permanently and the
        # retry tiering below it could never fire.
        find="  if (o?.tvdbId || o?.tmdbId) return false;           // we already have an id",
        replace="  if (o) return false; /* mutation */",
        test=T_UNIT,
        expect="re-examines an entry it previously failed on",
        guards="a show that gains a TVDB/TMDB record as it approaches airing is "
               "never looked at again",
    ),
    Mutation(
        name="concurrent cold film lookups each fetch the whole index",
        path="backend/src/lib/jellyfinFilmIndex.ts",
        # The whole guard is check-and-set with nothing awaited between. Making
        # the set unconditional recreates the race the first shape had (check,
        # await the persisted read, then assign): the availability batch's
        # concurrency pool starts one ~6,600-item scan per movie entry.
        find="  if (!_filmsInFlight) {",
        replace="  if (true) { /* mutation: every caller starts its own fetch */",
        test=T_UNIT,
        expect="share one in-flight fetch",
        guards="a cold wheel with two films fires duplicate full-library scans "
               "at Jellyfin — the stampede class this codebase keeps relearning",
    ),
    Mutation(
        name="a same-day double premiere opens on whichever episode came last",
        path="backend/src/lib/episodeMatch.ts",
        find="    if (delta < bestDelta || (delta === bestDelta && best !== null && earlier(e, best))) {",
        replace="    if (delta < bestDelta) { /* mutation: first-seen wins ties */",
        test=T_UNIT,
        expect="ties must go to the earlier episode even when",
        guards="Watch opens episode 2 of a double premiere whenever Jellyfin "
               "happens to list it first — order the API never promised",
    ),
    Mutation(
        name="specials win air-date ties against real episodes again",
        path="backend/src/lib/episodeMatch.ts",
        # Season 0 dates cluster around the seasons they ship with; without the
        # skip a special can sit exactly on the premiere date and beat E1.
        find="    if ((e.ParentIndexNumber ?? 0) < 1 || !e.PremiereDate) continue;",
        replace="    if (!e.PremiereDate) continue; /* mutation: specials compete */",
        test=T_UNIT,
        expect="season 0 must not compete for air-date ties",
        guards="Watch opens an OVA or recap instead of the season premiere for "
               "any show whose specials shipped alongside it",
    ),
    Mutation(
        name="check-batch is sent everything in one request again",
        path="frontend/src/pages/Home.svelte",
        # The route does .slice(0, 100): everything past position 100 is
        # silently dropped, those shows never learn they have English CC, and
        # each starts a needless Whisper translation when opened. Only
        # meaningful while current+prev trailers exceed 100 (the flow prints
        # the live count; 146 when this row was written).
        find="""    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += CHECK_BATCH_MAX) {
      chunks.push(ids.slice(i, i + CHECK_BATCH_MAX));
    }""",
        replace="    const chunks: string[][] = [ids]; /* mutation: unchunked */",
        test=T_UI,
        expect="the server slices at 100",
        guards="a third of a full season silently loses its known English CC "
               "and burns CPU re-translating trailers that never needed it",
    ),
    Mutation(
        name="a failed translation is console-only again",
        path="frontend/src/components/AnimeGridTranslate.svelte",
        # "Server busy" was written for a human and only ever reached the
        # console; the viewer saw a trailer with no subtitles, identical to a
        # trailer that simply has none.
        find="          showTranslationError(data.error);",
        replace="          /* mutation: console-only again */",
        test=T_UI,
        expect="data-translation-error",
        guards="a struggling translation server is indistinguishable from "
               "subtitles that don't exist",
    ),
    Mutation(
        name="the phone sidebar opens over the whole page again",
        path="frontend/src/pages/Home.svelte",
        find="  let sidebarCollapsed = typeof window !== 'undefined' && window.innerWidth < 640;",
        replace="  let sidebarCollapsed = false; /* mutation */",
        test=T_UI,
        expect="covers the viewport centre on a 375px phone load",
        guards="every phone load starts behind a full-screen My List panel "
               "that has to be dismissed before anything is usable",
    ),
    Mutation(
        name="a desktop visit records itself as 'chose expanded'",
        path="frontend/src/pages/Home.svelte",
        # The subtler half of the same bug, found by the flow's realistic
        # ordering (desktop flows run before the phone one): the reactive
        # prefs-save persisted the width DEFAULT as though the user chose it,
        # so one desktop visit poisoned every later phone load.
        find="      if (sidebarChoiceMade) {",
        replace="      if (true) { /* mutation: default recorded as a choice */",
        test=T_UI,
        expect="covers the viewport centre on a 375px phone load",
        guards="anyone who ever opened Home on a desktop gets the full-screen "
               "sidebar back on every phone load, stored as their own choice",
    ),
    Mutation(
        name="a guest's options stop reaching localStorage",
        path="frontend/src/stores/options.ts",
        find="      localStorage.setItem('options', JSON.stringify(value));",
        replace="      /* mutation: guests lose options on reload */",
        test=T_UI,
        expect="did not reach localStorage",
        guards="a guest's theme and language choices silently revert on every "
               "reload",
    ),
    Mutation(
        name="a typo'd Compare user renders as silence again",
        path="frontend/src/pages/Compare.svelte",
        find="""    suggestionsFor === typedOther &&
    suggestions.length === 0;""",
        replace="""    suggestionsFor === typedOther &&
    false; /* mutation: never fires */""",
        test=T_UI,
        expect="data-unknown-user",
        guards="a typo leaves the previous user's ranks on screen under the "
               "wrong name, reading as what that person rated",
    ),
    Mutation(
        name="unaired shows light the Hide button again",
        path="frontend/src/pages/Randomize.svelte",
        # notAired is `available:false` with `unknown` falsy, so a writer that
        # guards only `unknown` records every unaired show as confirmed-missing
        # and the button enables on seasons where nothing was checked at all.
        # The hide action itself filters notAired, so this lies without acting —
        # which is why only the button-state assertion can see it.
        find="          if (!info.unknown && !info.notAired) recordAvailability(mediaId, info.available);",
        replace="          if (!info.unknown) recordAvailability(mediaId, info.available); /* mutation */",
        test=T_UI,
        expect="'Hide Not in Library' is enabled on a season of NOT_YET_RELEASED",
        guards="the app's default look-ahead season shows an enabled control "
               "promising hides it cannot perform",
    ),
    Mutation(
        name="every Confirm claims the human looked it up",
        path="frontend/src/pages/AdminMatching.svelte",
        # `chosen` (a picked lookup result) is the Confirm discriminator; its
        # predecessor inferred "hand-typed" from prefilled boxes and relabelled
        # every id-bearing confirm as source:'manual', note:null — wiping the
        # provenance the server-side merge exists to preserve. This recreates
        # that: an untouched confirm is dressed up as a manual correction.
        find="                  const changed = !sameIdentity(sel, baseline[r.mediaId] ?? null);",
        replace="                  const changed = !!sel; /* mutation: any selection reads as a correction */",
        test=T_UI,
        expect="relabelled it manual",
        guards="the review page's own Confirm button erases which rung of the "
               "ladder accepted every id it touches",
    ),
    Mutation(
        name="an id paste stops naming the library match",
        path=BACKEND_JF,
        # The preview is the feature: what the admin is agreeing to, named,
        # before Confirm writes it as permanent fact. Unnamed, the lookup is
        # the old raw id box with more steps.
        find="""      if (s) {
        library = { title: s.title };""",
        replace="""      if (s) {
        /* mutation: unnamed */""",
        test=T_JELLYFIN,
        expect="did not name the library match",
        guards="the admin confirms bare numbers again, which is exactly the "
               "blind agreement this control replaced",
    ),
    Mutation(
        name="the sweep stores half-filled identities again",
        path=BACKEND_REMOTE,
        # The remote search supplies TMDB only; a stored series row must take
        # its TVDB sibling from the held library item (or the map) at write
        # time, or every resolver row reads TMDB-flavoured to a Sonarr user
        # and the id redundancy the matcher relies on never materialises.
        # `if (false && library)` was the first version, and it never exercised
        # the guard: TS narrows `library` to null inside the dead block, the
        # file fails to COMPILE (TS18047 x3), and node --test reports the whole
        # test file as ERR_TEST_FAILURE without running one assertion — red for
        # the wrong reason. A mutant must type-check, or it audits the compiler.
        find="""  if (library) {
    tvdbId = tvdbId ?? library.tvdbId ?? null;""",
        replace="""  if (library) {
    tvdbId = tvdbId ?? null; /* mutation: half-filled */""",
        test=T_UNIT,
        expect="must take its tvdb id",
        guards="resolver rows stay TMDB-only forever; nulling one id space in "
               "a library edit silently disables the id tier for them",
    ),
    Mutation(
        name="the id cross-walk stops joining through the anilist key",
        path="backend/src/lib/anilistTvdbMap.ts",
        # Jellyfin's remote search returns TMDB ids only on this server, so the
        # cross-walk is the only thing that puts a TVDB id on a looked-up pick
        # (and vice versa for a pasted tvdb:). Without the join, an id paste
        # resolves to half an identity and nobody is told.
        find="      if (ref) return { tvdbId: wantTvdb, tmdbId: ref.id, tmdbKind: ref.kind };",
        replace="      /* mutation: no join */",
        test=T_UNIT,
        expect="a tvdb id must pick up its tmdb sibling from the map",
        guards="pasted ids and picked results carry only the id space they "
               "arrived in — corrections quietly lose their redundancy",
    ),
    Mutation(
        name="a title-text remote accept is invisible to review again",
        path="frontend/src/pages/AdminMatching.svelte",
        # The resolver accepts an exact title without any air date vouching for
        # it, stored pending=false — this clause is the only one that lists such
        # a row. Neutering it recreates the hole: a wrong exact-title collision
        # (two works genuinely sharing a name) becomes permanent, and the empty
        # state says nothing needs review.
        find="""  const resolverAccept = (r: Row) =>
    !r.confirmed && r.source === 'remote' && !r.pending &&""",
        replace="""  const resolverAccept = (r: Row) =>
    false && !r.confirmed && r.source === 'remote' && !r.pending && /* mutation */""",
        test=T_UI,
        expect="remote-accepted row is invisible on /admin/matching",
        guards="everything the resolver accepts on a title string alone is "
               "invisible to the one page that could catch a wrong one",
    ),
    Mutation(
        name="a corrupt sweep-status row is served as a status",
        path=BACKEND_REMOTE,
        # Same contract as every persisted AppConfig blob: corrupt means
        # "no status", never garbage handed to the page as though it ran.
        find="""    return v && typeof v === 'object' && typeof v.finishedAt === 'number'
      ? (v as SweepStatus)
      : null;""",
        replace="    return v as SweepStatus; /* mutation: no shape guard */",
        test=T_UNIT,
        expect="a non-object must read as no-status",
        guards="a hand-edited or half-written cache row renders as a nonsense "
               "status line instead of the honest 'hasn't run yet'",
    ),
    Mutation(
        name="a two-year-old miss is retried forever",
        path=BACKEND_REMOTE,
        # The retirement rung: an entry that aired >2 years ago and is still
        # unknown upstream has been unknown its whole life — without this line
        # every permanent residue entry burns a lookup a month, forever.
        find="  if (startYear < thisYear - 2) return Infinity;",
        replace="  /* mutation: never retire */",
        test=T_UNIT,
        expect="must be retired",
        guards="the sweep budget is spent re-asking about lost causes monthly, "
               "and the status line's retired count silently reads zero",
    ),
    Mutation(
        name="a retry cooldown never expires",
        path=BACKEND_REMOTE,
        # retryStateFor drives the per-row captions and the stats tiles on
        # /admin/matching. A cooldown that sticks reads as "the sweep will
        # never come back for this" on every miss, forever.
        find="""  return now < nextRetryAt
    ? { state: 'cooldown', lastLookupAt, nextRetryAt }
    : { state: 'eligible', lastLookupAt, nextRetryAt: null };""",
        replace="  return { state: 'cooldown', lastLookupAt, nextRetryAt }; /* mutation: cooldown never expires */",
        test=T_UNIT,
        expect="cooldown must expire, not stick",
        guards="the admin page tells the admin every miss is waiting on a "
               "retry that (per the page) never arrives",
    ),
    Mutation(
        name="the stats block silently disappears",
        path=ADMIN_MATCHING,
        # The tiles are the page's answer to "how much of this season is
        # actually handled" — a markup regression that drops them leaves the
        # page functional-looking and the question unanswerable.
        find='<div class="flex flex-wrap items-end justify-between gap-x-6 gap-y-2" data-matching-stats>',
        replace='<div class="hidden" data-matching-stats-mutated>',
        test=T_UI,
        expect="no stats block",
        guards="the season-health and auto-search-queue tiles can vanish "
               "without any test noticing",
    ),
    Mutation(
        name="the sweep trigger endpoint loses its admin gate",
        path=BACKEND_JF,
        # The manual sweep starts real provider traffic (skyhook + TMDB via
        # Jellyfin) — ungated, any logged-in user can drain someone else's
        # budget. NOTE: the mutant run really does 202 a sweep on the dev
        # backend; the revert's restart kills it within seconds, and the dev
        # DB's eligible queue is near-empty, so the leaked traffic is a few
        # calls at most.
        find="router.post('/identity/sweep', jellyfinLimiter, requireAuth, requireAdmin, async (_req, res) => {",
        replace="router.post('/identity/sweep', jellyfinLimiter, requireAuth, async (_req, res) => { /* mutation */",
        test=T_JELLYFIN,
        expect="ADMIN_REQUIRED",
        guards="any signed-up user can trigger unbounded drain sweeps against "
               "the shared providers",
    ),
    Mutation(
        name="the Run-sweep button silently does nothing",
        path=ADMIN_MATCHING,
        # The page's version of the fire-and-forget hide toggle: a click that
        # changes nothing on screen is indistinguishable from a working one.
        find="on:click={runSweep}",
        replace="on:click={() => {}}",
        test=T_UI,
        expect="did not enter its running state",
        guards="the admin's only manual sweep control can break without any "
               "test noticing — a dead button still looks clickable",
    ),
    Mutation(
        name="the release-year rung accepts TV candidates again",
        path=BACKEND_REMOTE,
        # The year rung exists because a film has no episodes to date. For a
        # series the year is nearly free — TMDB's Year-filtered search returns
        # same-year works — so ungating it writes a coincidental TV sibling
        # into the identity table as accepted fact, no human in the loop.
        find="  if (input.kind === 'movie' && input.yearDelta != null && input.yearDelta <= 1) {",
        replace="  if (input.yearDelta != null && input.yearDelta <= 1) { /* mutation */",
        test=T_UNIT,
        expect="year rung is for films only",
        guards="a same-year TV franchise sibling we don't hold becomes a stored "
               "id that is never re-examined — the air-date gate's failure "
               "class, minus the air date",
    ),
    Mutation(
        name="an exact title blind-accepts against a refuting premiere date",
        path=BACKEND_REMOTE,
        # The Echo bug restored: rung A2 used to be the whole of rung A — an
        # exact title accepted unconditionally, so TMDB's "Echo" (2023) was
        # written as fact for an anime premiering 2026-07-19, with the day that
        # refuted it (1,012d) sitting unread in the same search response.
        find="  if (input.exact && p == null) return { verdict: 'accept', rung: 'exact title' };",
        replace="  if (input.exact) return { verdict: 'accept', rung: 'exact title' }; /* mutation */",
        test=T_UNIT,
        expect="must not blind-accept",
        guards="a same-titled work years from the entry's premiere is stored as "
               "an accepted match — the Echo class",
    ),
    Mutation(
        name="a dated localized-title match stays queued forever",
        path=BACKEND_REMOTE,
        # Rung D0 is what resolves the queue rows title text never could: TMDB
        # holds the work under its localized English title, 0 days from the
        # AniList premiere. Neutering it re-strands all 14 measured cases.
        # `p <= -1` and not `if (false)`: p is an absolute delta so it can never
        # fire, but the branch stays reachable — TS drops null-narrowing inside
        # unreachable code and `if (false)` turns the mutation into a compile
        # error, which the audit would report as CRASHED rather than a catch.
        find="    if (p <= AIR_DATE_TOLERANCE_MS) return { verdict: 'accept', rung: `premiere date ${days(p)}d` };",
        replace="    if (p <= -1) return { verdict: 'accept', rung: `premiere date ${days(p)}d` }; /* mutation */",
        test=T_UNIT,
        expect="localized titles",
        guards="a work TMDB files under its English title can never leave the "
               "review queue, however perfectly its premiere date matches",
    ),
    Mutation(
        name="the pick takes TMDB's first exact title again",
        path=BACKEND_REMOTE,
        # The other half of the Echo bug: with two same-titled candidates the
        # winner was whichever TMDB ranked first (popularity), not the one the
        # premiere date vouches for — DIVE IN! shipped its 167d sibling while
        # the 16d one sat second in the list.
        find="  const datedExact = all.filter((c) => c.exact && within(c)).sort(byDelta);",
        replace="  const datedExact = all.filter((c) => c.exact); /* mutation */",
        test=T_UNIT,
        expect="the one the premiere date vouches for must win",
        guards="a title collision is decided by TMDB popularity instead of the "
               "entry's own premiere date",
    ),
    Mutation(
        name="baseTitles strips the subtitle before the season marker again",
        path=BACKEND_REMOTE,
        # The old ordering collapsed "Mission: Yozakura Family Season 2 Part 2"
        # straight to "Mission" — which TMDB answered with Mission: Impossible —
        # while the form that resolves on TVDB was never generated at all.
        find="""  let m = t;
  while (SEASON_MARKER.test(m)) m = m.replace(SEASON_MARKER, '');""",
        replace="""  let m = t.replace(SUBTITLE_SEPARATOR, '').trim(); /* mutation */
  while (SEASON_MARKER.test(m)) m = m.replace(SEASON_MARKER, '');""",
        test=T_UNIT,
        expect="markers are stripped BEFORE the subtitle",
        guards="a sequel with a subtitle searches as its bare franchise word and "
               "matches whatever is popular under it",
    ),
    Mutation(
        name="a mid-word colon or dash counts as a subtitle separator again",
        path=BACKEND_REMOTE,
        # Greedy separators are how "Re:Zero" became "Re" (-> RE: European
        # Stories), "Ouji-sama" split mid-word, and "5-Oku-nen" collapsed to
        # "5" (-> Babylon 5).
        find=r"const SUBTITLE_SEPARATOR = /(:\s|\s+[-–—]).*$/;",
        replace=r"const SUBTITLE_SEPARATOR = /\s*[:\-–—]\s*.*$/; /* mutation */",
        test=T_UNIT,
        expect="a separator must look like a separator",
        guards="search terms collapse to fragments like 'Re' and '5', which "
               "match unrelated popular works",
    ),
    Mutation(
        name="a collapsed base title relates to everything again",
        path="backend/src/lib/skyhookIdentity.ts",
        # Short search terms still reach here ("Q" and "mono" are full titles,
        # "Mission" a legitimate variant) — without the length floor a short
        # prefix relates to every similarly-titled work; the measurement that
        # shaped this watched a collapsed "Re" relate to "Re:Born".
        find="    if (shorter.length < MIN_RELATION_CHARS) continue;",
        replace="    if (false) continue; /* mutation */",
        test=T_UNIT,
        expect="never relate",
        guards="every skyhook search result sharing two letters with a "
               "collapsed base becomes date-checkable",
    ),
    Mutation(
        name="any weekly episode verifies a TVDB season again",
        path="backend/src/lib/skyhookIdentity.ts",
        # An AniList entry's start date is a season START, and a weekly series
        # has SOME episode within days of any date — the first pass of the
        # measurement 'verified' Natsume S7 against a Lego Friends mid-run
        # episode exactly this way.
        find="    if (e.seasonNumber <= 0 || e.episodeNumber !== 1 || !e.airDate) continue;",
        replace="    if (e.seasonNumber <= 0 || !e.airDate) continue; /* mutation */",
        test=T_UNIT,
        expect="must not verify",
        guards="any currently-airing series on TVDB date-verifies against any "
               "seasonal entry — the Lego Friends confound",
    ),
    Mutation(
        name="a held rejection ignores TVDB's undated future season",
        path=BACKEND_REMOTE,
        # The sequel-reject bug: held episodes are stale by construction for a
        # season nobody has grabbed, so Frieren S3 was rejected against its own
        # parent at 553d. While TVDB lists an undated future season, the honest
        # verdict is review, not reject.
        find="""    return input.tvdbHasUndatedFutureSeason
      ? { verdict: 'queue', rung: null }
      : { verdict: 'reject', rung: null };""",
        replace="    return { verdict: 'reject', rung: null }; /* mutation */",
        test=T_UNIT,
        expect="premature",
        guards="every unaired new season of a held show writes 'not this "
               "series' about its own parent — the Frieren S3 class",
    ),
    Mutation(
        name="identity writes tell no one — the availability cache goes stale",
        path=BACKEND_IDENTITY,
        # Every identity writer (admin PUT and the sweep's three call sites)
        # invalidates the cached availability through this one notify. Gutting
        # it recreates the persist gap: the correction looks applied (fresh
        # reads bypass the cache) but the on-disk blob keeps the old verdict,
        # and the next restart restores it.
        find="  notifyIdentityChanged(input.anilistId);",
        replace="  /* mutation: identity writes tell no one */",
        test=T_JELLYFIN,
        expect="stale availability verdict survives a restart",
        guards="an admin correction silently reverts on the next deploy or dev "
               "reload, for up to the entry's remaining TTL",
    ),
    Mutation(
        name="identity invalidation never reaches the persisted blob",
        path=BACKEND_JF,
        # The in-memory delete alone looked correct in every live check — the
        # persist call is what makes the correction survive a restart, and it
        # is the half that was originally missing.
        find="""  availabilityCache.delete(id);
  persistMapSoon(AVAILABILITY_KEY, availabilitySnapshot);
});""",
        replace="""  availabilityCache.delete(id);
  /* mutation: deletion never reaches the persisted blob */
});""",
        test=T_JELLYFIN,
        expect="stale availability verdict survives a restart",
        guards="boot restore resurrects the pre-correction verdict from disk — "
               "the exact failure the identity cache-bust exists to prevent",
    ),
    Mutation(
        name="Confirm wipes provenance again",
        path=BACKEND_IDENTITY,
        # The PUT handler merges onto the stored row so that confirming a
        # resolver suggestion keeps its source/note/candidates. Nulling the note
        # on every write is exactly what the handler used to do — one click of
        # Confirm erased which rung of the ladder accepted the id and relabelled
        # it a human decision.
        find="    note: patch.note !== undefined ? patch.note : existing.note,",
        replace="    note: patch.note ?? null, /* mutation */",
        test=T_UNIT,
        expect="Confirm must not wipe provenance",
        guards="the review page destroys its own evidence — every confirmed row "
               "reads as a hand-typed correction with no explanation",
    ),
    Mutation(
        name="identity overrides are ignored",
        path=BACKEND_IDENTITY,
        # Same line as "a recorded miss shadows the community map", mutated the
        # other way: that row makes the override win too often, this one stops
        # it winning at all.
        find="  if (override && !isBookkeeping) return override;",
        replace="  /* mutation: overrides ignored */",
        test=T_JELLYFIN,
        expect="override did not change the verdict",
        guards="the admin page appears to save a correction that never takes "
               "effect, which is worse than not offering one",
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
        name="the 429 backoff drops back inside AniList's lockout",
        path="backend/src/lib/anilistRateLimit.ts",
        find="    waitMs = DEFAULT_LOCKOUT_MS;",
        replace="    waitMs = 15_000 * attempt; /* mutation */",
        test=T_UNIT,
        expect="documented one-minute lockout",
        guards="every retry lands inside AniList's 60s timeout, so all attempts "
               "are spent failing and a cold season load hangs for minutes and "
               "then errors anyway — the exact bug this replaced",
        settle=0.0,  # a pure helper; no dev server involved
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
        # The guard moved when availability was batched. It is now in the store,
        # which drops `unknown` before any page sees it — so the old row, which
        # broke the filter in Randomize, mutated a site that can no longer
        # receive an `unknown` and survived while proving nothing. Break it
        # where the data actually arrives.
        path="frontend/src/stores/jellyfin.ts",
        find="""        if (!info?.unknown) {
          _availabilityCache.set(mediaId, info);
          out.set(mediaId, info);
        }""",
        replace="""        _availabilityCache.set(mediaId, info); /* mutation */
        out.set(mediaId, info);""",
        # The single-show path keeps its own copy of the rule, and it feeds the
        # same client cache — leaving it intact lets a pop-up refill the cache
        # with a definite answer and mask the mutation.
        also=[("      if (!data.unknown) _availabilityCache.set(mediaId, data);",
               "      _availabilityCache.set(mediaId, data); /* mutation */")],
        # And the page checks again on the way in. That second guard is real
        # defence in depth, not redundancy to be deleted — but it does mean the
        # store guard alone is unreachable: an `unknown` that gets past the
        # store is filtered here instead, so the wheel behaves correctly and the
        # mutation survives having changed nothing. Both layers have to go for
        # the invariant to be exercised at all.
        extra=[("frontend/src/pages/Randomize.svelte",
                "          if (!info.unknown && !info.notAired) recordAvailability(mediaId, info.available);",
                "          if (!info.notAired) recordAvailability(mediaId, info.available); /* mutation */")],
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
    Mutation(
        name="requests can hang forever again (abort timeout removed)",
        path="frontend/src/lib/remote.ts",
        find="      const res = await fetch(path, { ...init, signal: AbortSignal.timeout(timeoutMs) });",
        replace="      const res = await fetch(path, { ...init }); /* mutation */",
        test=T_UI,
        expect="hung availability request left the page waiting",
        guards="a hung backend hangs the page indefinitely — no error, no timeout, "
               "nothing to catch, which is the failure mode with no upper bound",
    ),
    Mutation(
        name="a failed hide write no longer reverts",
        path="frontend/src/pages/Randomize.svelte",
        # Break the state revert only, leaving the message. Removing the whole
        # `revertHidden` call also removes the warning, so the test died waiting
        # for that instead of reaching the assertion about UI/server agreement —
        # red, but for the wrong reason, which proves nothing about the guard.
        find="    watchList = watchList.map((e) => (undo.has(e.mediaId) ? { ...e, hidden: back } : e));",
        replace="    /* mutation: no revert */",
        test=T_UI,
        expect="UI and server have diverged",
        guards="the screen shows shows as hidden while the server disagrees, so a "
               "reload silently undoes what the user just did — data loss, not "
               "just a missing message",
    ),
    Mutation(
        name="a failed single-show hide stops reverting",
        path="frontend/src/pages/Randomize.svelte",
        # The per-row eye toggle had its own fire-and-forget fetch for months
        # after the bulk paths gained the rollback — one shared revert helper
        # is not one shared guarantee, so this path gets its own row. The
        # mutant is type-valid on purpose (see row: half-filled identities —
        # a mutant that fails to compile audits the compiler).
        find="""    const failed = await writeHidden([item.id], targetHidden);
    if (failed.length) revertHidden(failed, !targetHidden, 1);""",
        replace="    void writeHidden([item.id], targetHidden); /* mutation: no single revert */",
        test=T_UI,
        expect="single-show hide left applied",
        guards="hiding one show from the list or pop-up looks applied, the server "
               "never saved it, and the next reload silently undoes it",
    ),
    Mutation(
        name="a failed library lookup goes back to being silent",
        path="frontend/src/stores/jellyfin.ts",
        find="  libraryStatus.set(failedChunks ? 'unreachable' : 'ok');",
        replace="  libraryStatus.set('ok'); /* mutation */",
        test=T_UI,
        expect="the page said nothing",
        guards="a failed availability lookup renders exactly like a healthy library "
               "with nothing missing — the state a real outage was reported in, "
               "which cost four wrong theories and was never explained",
    ),
    Mutation(
        name="unaired series are looked up in the library again",
        path="frontend/src/stores/jellyfin.ts",
        find="  if (info.status) return info.status === 'NOT_YET_RELEASED';",
        replace="  if (info.status) return false; /* mutation */",
        test=T_UI,
        expect="availability lookup(s) fired for a NOT_YET_RELEASED season",
        guards="every match on the default (unaired) season falls through to fuzzy "
               "titles against a library that cannot hold the show — measured 7/7 "
               "wrong, offering 'Firefly' for 'Firefly Wedding'",
    ),
    Mutation(
        name="Escape stops closing the trailer modal",
        path="frontend/src/components/AnimeGridTranslate.svelte",
        find="    if (modal && e.key === 'Escape') closeModal();",
        replace="    /* mutation: escape disabled */",
        test=T_UI,
        expect="Escape did not close the trailer modal",
        guards="the only remaining exit is the backdrop, which is a thin strip on a "
               "phone — and the test that was meant to catch this used to fall back "
               "to a backdrop click and assert on that instead",
    ),
    Mutation(
        name="the trailer modal loses its close button",
        path="frontend/src/components/AnimeGridTranslate.svelte",
        find='        aria-label="Close trailer"',
        replace='        aria-label="Close trailer mutated"',
        test=T_UI,
        expect="trailer modal has no visible close button",
        guards="viewers who don't know Escape have to guess that the dark area "
               "around the video is clickable",
    ),
    Mutation(
        name="a no-match search renders nothing again",
        path="frontend/src/pages/Home.svelte",
        find="      <p class=\"text-center opacity-60 my-12\" data-no-results>",
        replace="      <p class=\"text-center opacity-60 my-12\" data-no-results-mutated>",
        test=T_UI,
        expect="no-match search rendered nothing at all",
        guards="searching for a show that isn't in this season shows a blank page, "
               "which reads as a broken site rather than an empty result",
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
    """Repo-relative paths with uncommitted changes.

    Do NOT strip the output. Porcelain lines are `XY PATH`, and an unstaged
    modification is `" M path"` — a leading space. Stripping the whole blob
    removes it from the *first* line only, so `l[3:]` then eats a character of
    that path: `backend/...` became `ackend/...`, matched nothing, and the
    dirty-tree guard silently stopped protecting whichever file sorted first.
    That is not hypothetical — it reverted uncommitted work in
    `backend/src/routes/jellyfin.ts` on the run that found this.
    """
    out = git("status", "--porcelain").stdout
    paths = []
    for line in out.splitlines():
        if len(line) < 4:
            continue
        path = line[3:]
        # Renames read `R  old -> new`; the new name is the one on disk.
        if " -> " in path:
            path = path.split(" -> ", 1)[1]
        paths.append(path.strip('"'))
    return paths


def apply(m: Mutation) -> bool:
    """Edit every site this mutation names. All-or-nothing.

    Nothing is written until every anchor has been located, because a partial
    application is the worst outcome available: the code is broken in one place,
    intact in another, and the run reports on a state nobody described.
    """
    edits: dict[str, str] = {}

    src = (REPO / m.path).read_text(encoding="utf-8")
    if m.find not in src:
        return False
    src = src.replace(m.find, m.replace, 1)
    for find, replace in m.also:
        if find not in src:
            return False
        src = src.replace(find, replace, 1)
    edits[m.path] = src

    for path, find, replace in m.extra:
        text = edits.get(path) or (REPO / path).read_text(encoding="utf-8")
        if find not in text:
            return False
        edits[path] = text.replace(find, replace, 1)

    for path, text in edits.items():
        (REPO / path).write_text(text, encoding="utf-8", newline="")
    return True


def _healthy() -> bool:
    try:
        import urllib.request
        with urllib.request.urlopen("http://localhost:3000/api/health", timeout=2) as r:
            return r.status == 200
    except Exception:
        return False


#: Time for ts-node-dev's watcher to notice a write. Measured at ~0.5 s; this
#: is generous because the audit is running tests at the same time.
WATCHER_GRACE_S = 2.0
#: Consecutive healthy polls required before calling it settled.
STABLE_POLLS = 3


def wait_for_backend(timeout: float = 90.0) -> None:
    """Block until ts-node-dev has finished reloading and is serving again.

    A fixed sleep is a guess, and it was wrong in both directions: editing a
    backend file restarts the process and so does reverting it, so a row could
    start testing while the previous row's revert was still booting. Rows then
    failed with no FAIL line at all and were counted as coverage holes.

    Watching for a *new PID* was the obvious fix and it is wrong. Measured: on
    apply the PID changes within 0.5 s, but on a revert that lands while the
    first restart is still in flight, ts-node-dev folds both writes into one
    cycle and the PID never changes again. Waiting for a second change then
    burns the whole timeout and proceeds anyway — which is how an audit run
    reported 7/14 with `test_jellyfin` exiting in one second against a backend
    that was not up.

    So this asks the question that actually matters — "is it serving?" — rather
    than a proxy for it. The grace period matters as much as the polling: without
    it we sample the *old* process, get a 200 immediately, and conclude all is
    well before the restart has even begun.
    """
    time.sleep(WATCHER_GRACE_S)
    deadline = time.time() + timeout
    healthy_in_a_row = 0
    while time.time() < deadline:
        healthy_in_a_row = healthy_in_a_row + 1 if _healthy() else 0
        if healthy_in_a_row >= STABLE_POLLS:
            return
        time.sleep(0.5)
    # Don't abort: a backend that never came back is itself a finding, and the
    # test about to run reports it far more usefully than a crash here would.
    print(f"      (warning: backend did not come back within {timeout:.0f}s "
          f"— the next result may be unreliable)", flush=True)


def settle_after_edit(m: Mutation) -> None:
    """Wait for whichever dev server the edited file belongs to."""
    if not m.settle:
        return
    if any(p.startswith("backend/") for p in m.paths):
        wait_for_backend()
    else:
        # Vite HMR keeps the same process and reloads far quicker than a
        # ts-node-dev restart, so a short sleep is honest here.
        time.sleep(m.settle)


def restore(m: Mutation, wait: bool = True) -> None:
    """Put every file this mutation touched back. `wait` is False for cleanup.

    Mid-run the wait is load-bearing — it stops one row's revert bleeding into
    the next row's test. In the final sweep nothing runs afterwards, so waiting
    there only adds a settle per file to the end of every audit.
    """
    git("checkout", "--", *m.paths)
    if wait and m.settle and any(p.startswith("backend/") for p in m.paths):
        wait_for_backend()


def run_test(m: Mutation, ctx: str = "") -> tuple[bool, str]:
    """True when the test PASSED (i.e. the mutation went unnoticed).

    The child's output is a diagnostic to scan afterwards, never progress to
    show — but a silent 110s child is a frozen status line (the status bar
    shows the last line of output, and a UI-suite row prints nothing for two
    minutes). So the child writes to a temp file and a heartbeat ticks here,
    carrying the row context because a bare "still running" is meaningless as
    the one visible line.
    """
    cwd = REPO / "backend" if m.test is T_UNIT else REPO
    shell = sys.platform == "win32" and m.test[0] in ("npm", "npx")
    with tempfile.TemporaryFile(mode="w+", encoding="utf-8", errors="replace") as sink:
        p = subprocess.Popen(m.test, cwd=cwd, stdout=sink, stderr=subprocess.STDOUT,
                             shell=shell, encoding="utf-8", errors="replace")
        t0 = time.time()
        while True:
            try:
                rc = p.wait(timeout=20)
                break
            except subprocess.TimeoutExpired:
                elapsed = time.time() - t0
                if elapsed > 900:
                    p.kill()
                    p.wait()
                    return False, "TIMED OUT"
                say(f"{ctx} test running {elapsed:.0f}s…")
        sink.seek(0)
        return rc == 0, sink.read()


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
    targets = {p for m in chosen for p in m.paths}
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
    # Warm before touching anything. The audit restarts the backend twice per
    # row, and a stale season key would re-fetch on the first request after each
    # restart — dozens of cold AniList fetches across a run, which is what kept
    # tripping the 30/min limit and made rows fail for reasons unrelated to the
    # invariant they were testing.
    #
    # INVARIANT: the audit's whole runtime must fit inside the season-cache TTL
    # (6 h, routes/anime.ts), because this warm happens ONCE. The runtime grows
    # every time a row is added, and this assumption has already broken
    # silently: 18 rows (~35 min) fit the old 1 h TTL, 57 rows (~90 min) did
    # not, and the last half hour of that run fired a stale background refresh
    # per restart into AniList's shared ~30/min budget — nothing failed, the
    # run just quietly became a 429 storm. Live tests must never provoke a 429;
    # the 429/backoff *logic* is unit-tested in anilistRateLimit without
    # touching the network. If the audit ever approaches the TTL, raise the
    # TTL case for re-warming here rather than letting it ride.
    _, warm_failed = warm_cache.warm()
    if warm_failed:
        # An audit against a missing season is worse than no audit: every row
        # would go red for the wrong reason, and rows that genuinely aren't
        # guarded would be indistinguishable from rows whose test never got to
        # run. That is precisely the "red is not the same as covered" mistake
        # this tool exists to detect, so it must not commit it itself.
        say(f"Refusing to run: {warm_failed} season key(s) could not be fetched, "
            f"so every row would fail for a reason unrelated to its invariant.")
        return 1

    skipped: list[str] = []
    try:
        for i, m in enumerate(chosen, 1):
            n = args.only or i
            # Every line below carries this: the status bar shows exactly one
            # line, and "caught in 112s" with no row number tells a reader
            # nothing about where the run is.
            ctx = f"[{n}/{len(MUTATIONS)}]"
            say(f"{ctx} {m.name}")
            if not apply(m):
                say(f"      {ctx} SKIP — anchor text not found; the code moved, update this row\n")
                skipped.append(m.name)
                continue
            try:
                settle_after_edit(m)
                t0 = time.time()
                passed, out = run_test(m, ctx)
            finally:
                restore(m)
            took = time.time() - t0
            if passed:
                say(f"      {ctx} SURVIVED in {took:.0f}s — nothing caught it")
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
                # Distinguish "the test asserted something else" from "the test
                # never got to assert at all". Both used to print
                # `(no FAIL line)`, which reads like a coverage hole and hides a
                # broken harness — five player rows were reported as holes for a
                # week because `--only-steps` skipped a step they depended on and
                # the run died on an UnboundLocalError.
                if not why and "Traceback (most recent call last)" in out:
                    crash = next((l.strip() for l in reversed(out.splitlines())
                                  if l.strip() and not l.startswith((" ", "\t"))), "")
                    why = f"CRASHED before asserting — {crash[:100]}"
                say(f"      {ctx} WRONG REASON in {took:.0f}s — red, but not because of "
                    f"this invariant")
                say(f"      expected to see: {m.expect!r}")
                say(f"      actually failed: {why[:140] or '(no FAIL line)'}")
                say(f"      still unguarded: {m.guards}\n")
                survived.append(f"{m.name}  [red for an unrelated reason]")
            else:
                hit = next((l for l in out.splitlines()
                            if m.expect.lower() in l.lower()), "").strip()
                say(f"      {ctx} caught in {took:.0f}s — {hit[:130]}\n")
    finally:
        # Belt and braces: restore what this run touched, including on Ctrl-C.
        #
        # `chosen`, NOT `MUTATIONS`. This looped over every row once, so a
        # `--only 1` run ran `git checkout --` across all thirteen target files
        # and destroyed uncommitted work in two of them that the run never even
        # touched. The dirty-tree check above is scoped to `chosen`; if this is
        # ever widened again, that guard silently stops covering it.
        for m in chosen:
            # No wait: nothing runs after this sweep, and waiting here added a
            # full settle per backend file to the end of every audit.
            restore(m, wait=False)

    total = len(chosen) - len(skipped)
    say(f"Done: {total - len(survived)}/{total} caught"
        + (f", {len(skipped)} skipped" if skipped else ""))
    for s in survived:
        say(f"   COVERAGE HOLE: {s}")
    return 1 if survived else 0


if __name__ == "__main__":
    sys.exit(main())
