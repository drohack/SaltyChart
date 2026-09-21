"""
Is the pre-deploy suite load-bearing, or does it just pass?

`Pre-deploy: 24/24 passed - ready to build` is the sentence the whole deploy
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
a periodic audit, not a deploy gate. Add a row here whenever you add a test -
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
import datetime
import time
from dataclasses import dataclass, field
from pathlib import Path

import warm_cache

REPO = Path(__file__).resolve().parents[2]
TESTS = REPO / "tools" / "tests"


def say(msg: str = "") -> None:
    print(msg, flush=True)


# Every other test here does this; this file never did, and it shows up in the
# one place nobody reads carefully - the status bar. Redirected stdout on
# Windows defaults to the locale codec (cp1252), so the em dashes and ellipses
# in these very messages were written as bytes no UTF-8 reader can decode, and
# every progress line arrived with a `?` in it. errors="replace" so a stray
# character from a child's output can never take the run down.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


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
    # site leaves the others still holding the line - the mutation then reads as
    # 'survived' when it was simply too narrow to change any behaviour.
    also: list[tuple[str, str]] = field(default_factory=list)
    # Same idea as `also`, but for sites in *other* files: (path, find, replace).
    # Needed because a guard can legitimately live at more than one layer - the
    # "never act on an `unknown` availability verdict" rule is enforced both
    # where server data enters the store and again in the page that consumes it.
    # Breaking either alone changes no behaviour, because the other still holds,
    # so the mutation reads as 'survived' while proving nothing. The answer is to
    # let the audit express the invariant, not to thin out a safety guard so a
    # single-file mutation can reach it.
    extra: list[tuple[str, str, str]] = field(default_factory=list)
    # Which test_ui_interactions flows this row needs, by their registry label.
    #
    # A T_UI row without this re-runs all 25 browser flows twice - about half
    # this audit's wall clock for rows that touch one screen. Naming the flow
    # cuts a ~110 s child to ~15 s.
    #
    # ONLY labels in that file's SELECTABLE_FLOWS allowlist are accepted, and
    # the test refuses anything else: a flow that inherits state from its
    # predecessors can pass alone while proving nothing, which is precisely how
    # `--only-steps` hollowed out six player rows. The default (no flows) is the
    # full suite, so forgetting this is slow rather than wrong.
    #
    # Never add one without watching the mutant fail UNDER THE NARROWED RUN.
    flows: tuple[str, ...] = ()
    settle: float = 6.0       # ts-node-dev / vite need a moment to reload
    env: dict = field(default_factory=dict)

    @property
    def paths(self) -> list[str]:
        """Every file this mutation edits, so all of them get reverted."""
        seen = [self.path] + [p for p, _, _ in self.extra]
        return list(dict.fromkeys(seen))


BACKEND_JF = "backend/src/routes/jellyfin.ts"
BACKEND_LIST = "backend/src/routes/list.ts"
BACKEND_LIBPICK = "backend/src/lib/libraryPick.ts"
BACKEND_MATCH = "backend/src/lib/animeMatch.ts"
BACKEND_IDENTITY = "backend/src/lib/seriesIdentity.ts"
BACKEND_REMOTE = "backend/src/lib/remoteIdentity.ts"
BACKEND_SONARR = "backend/src/lib/sonarrSelect.ts"
BACKEND_SONARR_PUSH = "backend/src/lib/sonarrPush.ts"
BACKEND_SONARR_ROUTE = "backend/src/routes/sonarr.ts"
BACKEND_SUBS = "backend/src/lib/subtitleReport.ts"
BACKEND_AUTHCODES = "backend/src/lib/authCodes.ts"
BACKEND_AUTH_ROUTE = "backend/src/routes/auth.ts"
BACKEND_ADMIN_USERS = "backend/src/routes/adminUsers.ts"
BACKEND_MIDDLEWARE = "backend/src/middleware/auth.ts"
PLAYER = "frontend/src/components/JellyfinPlayerModal.svelte"
ADMIN_MATCHING = "frontend/src/pages/AdminMatching.svelte"
ADMIN_SONARR = "frontend/src/pages/AdminSonarr.svelte"

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
# Boots its own backend on an EMPTY database, so its destructive admin
# assertions cannot touch the dev account. Rows that break an admin guard
# belong here: against the dev server the same assertions succeeded and left
# the real admin's password reset and email cleared.
T_ACCTSEC = PY + [str(TESTS / "test_account_security.py")]
# Cheap (~15 s) and it `fail()`s at the guarded step, so a caught row pays only
# as far as its own assertion - the right layer for a purely server-side rule.
T_SMOKE = PY + [str(TESTS / "test_api_smoke.py")]
T_UI = PY + [str(TESTS / "test_ui_interactions.py")]
T_UNIT = ["npm", "run", "test:unit"]
T_REPLAY = PY + [str(TESTS / "test_match_replay.py")]
# Runs in about a second against no servers, so the doc rows below are the
# cheapest in the table.
T_ANCHORS = PY + [str(TESTS / "test_audit_anchors.py")]
T_YTGUARD = PY + [str(TESTS / "test_yt_guard.py")]
T_HOLD = PY + [str(TESTS / "test_download_hold.py")]
T_VERDICT = PY + [str(TESTS / "test_run_verdict.py")]
T_SUBS = PY + [str(TESTS / "test_subtitle_paths.py")]
T_STATUS = PY + [str(TESTS / "test_status_page.py")]
T_LOCALRUN = PY + [str(TESTS / "test_local_run_report.py")]
T_SONARR = PY + [str(TESTS / "test_sonarr.py")]

MUTATIONS: list[Mutation] = [
    Mutation(
        name="the broken-downloads alert mails on every failure past the threshold",
        path="backend/src/lib/downloadHealth.ts",
        # An alert that fires on every failure is the alert that gets muted. The
        # edge is exactly the failure that takes the streak to BROKEN_AFTER.
        find="    crossed: streak === BROKEN_AFTER,",
        replace="    crossed: streak >= BROKEN_AFTER, /* mutation: mails on every failure */",
        test=T_UNIT,
        expect="the broken alert fires once, at the crossing, not on every failure after it",
        guards="a month-long outage produces one mail, not one per trailer per viewer",
    ),
    Mutation(
        name="an unverified admin address receives alerts",
        path="backend/src/lib/subtitleAlerts.ts",
        # The root rule: a verified email is what counts. An unverified address
        # could be anyone's, and it would be told when the server is degraded.
        find="    if (!r.email || !r.emailVerifiedAt) continue;",
        replace="    if (!r.email) continue; /* mutation: unverified addresses count */",
        test=T_UNIT,
        expect="an unverified admin address never receives an alert",
        guards="the same rule that keeps an unverified address from protecting an account",
    ),
    Mutation(
        name="the Sunday-run silence alert repeats every day",
        path="backend/src/lib/subtitleAlerts.ts",
        # Without the stamp the daily timer mails once a day for as long as the
        # task stays down - which is the volume that gets a rule created to bin it.
        find="  if (run.silentAlertedAt) return 'alreadyAlerted';",
        replace="  /* mutation: stamp ignored */",
        test=T_UNIT,
        expect="a silence already alerted is not alerted again",
        guards="once per silence; a new report clears the stamp and re-arms it",
    ),
    Mutation(
        name="a failed CC check is written as no-CC again",
        path="backend/src/lib/subtitleCheck.ts",
        # The original bug: `null !== undefined` is true, so a check that could
        # not find out was pinned as 0 with a fresh lastEnCheckAt for seven days.
        find="  return typeof v === 'boolean' ? (v ? 1 : 0) : null;",
        replace="  return v === undefined ? null : (v ? 1 : 0); /* mutation: null is written as 0 */",
        test=T_UNIT,
        expect="a null verdict from a failed check is not written as no-CC",
        guards="a transient IP block sent a video WITH English captions down the download "
               "path for a week",
    ),
    Mutation(
        name="an arbitrary failure kind is persisted to AppConfig",
        path="backend/src/lib/downloadHealth.ts",
        # `kind` arrives from a spawned process's JSON; everything else on that
        # path is bounded. Only the four known kinds may be stored.
        find="  return (FAIL_KINDS as readonly string[]).includes(k as string) ? (k as FailKind) : 'other';",
        replace="  return typeof k === 'string' ? (k as FailKind) : 'other'; /* mutation: any string stored */",
        test=T_UNIT,
        expect="an unknown failure kind is stored as other",
        guards="persisted config is not a place for an unbounded string from a child process",
    ),
    Mutation(
        name="an idle daemon is logged as busy after a yt-dlp upgrade",
        path="backend/src/lib/ytdlpUpdate.ts",
        # 'none' is the idle norm (the daemon exits after two quiet hours). Calling
        # it busy tells the operator the old version is still serving when it is not.
        find="    case 'none': return 'no daemon was running (not running is the idle norm), the next spawn imports it';",
        replace="    case 'none': return 'daemon busy with a translation, it keeps the old version until its next respawn'; /* mutation */",
        test=T_UNIT,
        expect="an idle daemon is not reported as busy",
        guards="the one daily log line must say which version the next translation uses",
    ),
    Mutation(
        name="a bot wall delivered as a 403 gets the stale-yt-dlp hint",
        path="backend/src/lib/downloadHealth.ts",
        # The daemon checks bot-wall phrases before the 403 status. The hint must
        # follow the same precedence or the admin page recommends the wrong remedy.
        find="  if (kind && kind !== 'forbidden') return false;",
        replace="  /* mutation: kind ignored */",
        test=T_UNIT,
        expect="a bot wall delivered as a 403 gets no stale-yt-dlp hint",
        guards="'upgrade yt-dlp' under a rate-limit banner sends someone down the wrong path",
    ),
    Mutation(
        name="check-batch queues live checks while YouTube is refusing us",
        path="backend/src/routes/translate.ts",
        # Inverting the hold makes every held id queue a live transcript-API call
        # - poking a blocked IP from the one door the hold was supposed to close.
        find="  const held = uncachedIds.length > 0 && (await shouldHoldDownloads()).hold;",
        replace="  const held = uncachedIds.length > 0 && !(await shouldHoldDownloads()).hold; /* mutation: hold inverted */",
        test=T_HOLD,
        expect="FAIL: check-batch queues nothing while holding",
        guards="the header is the observable; the daemon-down case reads no-daemon, not held",
    ),
    Mutation(
        name="/check makes a live YouTube call while holding",
        path="backend/src/routes/translate.ts",
        # `hold.hold && !hold.hold` is always false and type-checks (`false &&`
        # would narrow). The request falls through to a live check on a fake id.
        find="  if (hold.hold) return res.json({ ...cachedExtra, hasEnglish: null, holdUntil: hold.until });",
        replace="  if (hold.hold && !hold.hold) return res.json({ ...cachedExtra, hasEnglish: null, holdUntil: hold.until }); /* mutation */",
        test=T_HOLD,
        expect="FAIL: check answers from cache only while holding",
        guards="one more live request per modal open at a blocked IP",
    ),
    Mutation(
        name="the local-run report route drops its admin gate",
        path="backend/src/routes/translate.ts",
        # /admin/subtitles repeats whatever this route stores. Without the gate
        # any account could rewrite what the page says about the Sunday run -
        # including painting a failed month green.
        find="router.post('/local-run', express.json({ limit: '64kb' }), requireAuth, requireAdmin, async (req: AuthRequest, res: Response) => {",
        replace="router.post('/local-run', express.json({ limit: '64kb' }), requireAuth, async (req: AuthRequest, res: Response) => {  /* mutation */",
        test=T_LOCALRUN,
        expect="FAIL: local-run rejects a non-admin",
        guards="every write route in this router is admin-gated and each has a row; "
               "this one decides what the admin page reports",
    ),
    Mutation(
        name="a batch run that mostly failed exits 0 again",
        path="backend/scripts/translate_stream.py",
        # The original behaviour, restored: no error count ever fails a run. This
        # is the shape that let four Sunday runs with 46/49 failures report
        # lastResult=0x0 for a month.
        find="    if errors >= RUN_FAIL_MIN and errors > attempted * RUN_FAIL_RATIO:",
        replace="    if errors > attempted:  # mutation: impossible, so a run can never fail",
        test=T_VERDICT,
        expect="FAIL: 46 of 49 failures is a failed run",
        guards="Task Scheduler and persistBatchRun both read the exit code; a run "
               "that cannot exit non-zero is a run whose failure nobody can see",
    ),
    Mutation(
        name="the YouTube budget lets one call over the 10-minute cap through",
        path="tools/yt_guard.py",
        # An off-by-one on a budget is the classic silent loosening: nothing
        # errors, the guard just admits one more burst than it claims to.
        find="    if len(recent10) >= max10:",
        replace="    if len(recent10) > max10:  # mutation: one over the cap",
        test=T_YTGUARD,
        expect="FAIL: 10-min cap enforced at exactly the cap",
        guards="the burst cap is the gate that maps onto the run that tripped the IP "
               "block; a loose one is a documented number that isn't enforced",
    ),
    Mutation(
        name="a failed skyhook lookup is cached as an empty schedule",
        path="backend/src/lib/skyhookIdentity.ts",
        # The outage shape, restored. skyhook started answering 400 to axios's
        # default User-Agent; the bare catch made every failure an empty result
        # and this line pinned it for the process lifetime, so the whole TVDB
        # evidence tier was dead and nothing said a word.
        find="  if (!failed) _showCache.set(tvdbId, show);",
        replace="  _showCache.set(tvdbId, show);  /* mutation: a 400 becomes permanent */",
        test=T_UNIT,
        expect='a failed show lookup is not cached as "this show has no episodes"',
        guards="'could not ask' must never be cached as 'nothing to find' - the same "
               "rule the unknown-availability and empty-Sonarr-snapshot guards follow",
    ),
    Mutation(
        name="an unverified address can become the alert owner",
        path="backend/src/lib/subtitleAlerts.ts",
        # The same rule the password-reset path follows, for the same reason: a
        # typo in an address nobody confirmed would redirect every alert into a
        # black hole, permanently and silently - and the failure is invisible,
        # because an alert that is never delivered looks exactly like no alert
        # being needed.
        find="""    if (!r.email || !r.emailVerifiedAt) continue;
    if (!best || r.id < best.id) best = { id: r.id, email: r.email };""",
        replace="""    if (!r.email) continue;  /* mutation: unverified counts */
    if (!best || r.id < best.id) best = { id: r.id, email: r.email };""",
        test=T_UNIT,
        expect="an unverified address can never make someone the owner",
        guards="a verified address is the only thing that makes a recipient real; "
               "this is where every operational alert is addressed",
    ),
    Mutation(
        name="a service nobody has checked reports as working",
        path="backend/src/lib/upstreamHealth.ts",
        # The single most load-bearing rule on the status page, and the exact
        # shape of the outage it exists for: "we have not asked" rendered as
        # green is how skyhook stayed invisible for weeks. Same family as an
        # unreachable Sonarr reading "0 still to add".
        find="  if (!rec.lastCheckedAt) return 'unknown';",
        replace="  if (!rec.lastCheckedAt) return 'ok';  /* mutation: never asked reads as healthy */",
        test=T_UNIT,
        expect="a service nobody has checked reads unknown, never ok",
        guards="a status page that cannot say 'I do not know' is worse than none - "
               "it converts ignorance into false reassurance",
    ),
    Mutation(
        name="a service with no saved alert preference goes silent",
        path="backend/src/lib/alertSettings.ts",
        # Absence must mean ENABLED. If it meant off, every service added to the
        # registry later would arrive silent - the failure this feature exists
        # to end, reintroduced through its own settings file.
        find="  return settings.perService[id] !== false;",
        replace="  return settings.perService[id] === true;  /* mutation: absent means off */",
        test=T_UNIT,
        expect="a service nobody has configured still alerts",
        guards="a new dependency must alert by default; opting out is a decision "
               "someone makes, not the state they inherit",
    ),
    Mutation(
        name="the outage email fires on every failure instead of once",
        path="backend/src/lib/upstreamHealth.ts",
        # The edge rule, per service. `>=` mails on every failure after the
        # third, which is how an alert becomes the noise that gets filtered.
        # The "once" rule moved from `=== brokenAfter` to a stored flag when the
        # quiet window arrived: the streak and the window can become true in
        # either order, so an equality can no longer express "exactly one mail".
        # Dropping the flag is the same bug in its new clothes.
        find="  const crossed = streak >= brokenAfter && quiet && !rec.downAlertedAt;",
        replace="  const crossed = streak >= brokenAfter && quiet;  /* mutation: mails on every failure */",
        test=T_UNIT,
        expect="the down alert fires once, at the crossing, not on every failure after it",
        guards="an alert that repeats is an alert that gets muted, and a muted "
               "alert is indistinguishable from the silence it replaced",
    ),
    Mutation(
        name="a failing service waits a full day to be re-checked",
        path="backend/src/lib/upstreamProbes.ts",
        # Removes the "confirm fast" half of "probe daily, confirm fast". With a
        # daily interval and a 3-failure threshold, a real outage would take
        # THREE DAYS to send one email - which is the season-scale blindness the
        # whole feature exists to end.
        find="  const wait = rec.consecutiveFailures > 0 ? CONFIRM_RETRY_MS : (spec.minProbeIntervalMs ?? DAY_MS);",
        replace="  const wait = spec.minProbeIntervalMs ?? DAY_MS;  /* mutation: no fast confirm */",
        test=T_UNIT,
        expect="a service that just failed is re-checked in minutes, not tomorrow",
        guards="probing daily is right because APIs break on a release cadence; it "
               "is only safe if a suspected break is confirmed in minutes",
    ),
    Mutation(
        name="a passive-only service gets probed anyway",
        path="backend/src/lib/upstreamProbes.ts",
        # YouTube is unprobed on purpose: its failure mode IS request volume,
        # so a synthetic request risks deepening the bot wall it exists to
        # detect. This is monitoring that causes the outage it watches for.
        find="  if (spec.passiveOnly) return false;",
        replace="  if (spec.passiveOnly && false) return false;  /* mutation: probe everything */",
        test=T_UNIT,
        expect="passive-only services are never due, and force cannot override that",
        guards="the one service whose failure mode IS request volume must never be "
               "probed; nothing else in the code stops a future edit adding one",
    ),
    Mutation(
        name="a service nobody set up is reported as broken",
        path="backend/src/lib/upstreamHealth.ts",
        # "Not set up" is a deliberate state. Painting it red puts a permanent
        # fault on the page for a service that does not exist, which trains the
        # reader to ignore the page - the same damage as painting it green.
        find="  if (rec.lastSkipped) return 'notConfigured';",
        replace="  if (rec.lastSkipped) return 'down';  /* mutation: unconfigured reads as broken */",
        test=T_STATUS,
        expect="a skipped service reads notConfigured, not down",
        guards="'nobody set this up', 'it is working' and 'it is broken' are three "
               "different answers; the whole page is about keeping them apart",
    ),
    Mutation(
        name="the status report drops its admin gate",
        path="backend/src/routes/status.ts",
        # The page names every service this deployment depends on, its failure
        # text and the addresses that get alerted. None of that is a viewer's
        # business, and a new router is exactly where a missing gate hides.
        find="router.get('/report', requireAuth, requireAdmin, async (_req: AuthRequest, res: Response) => {",
        replace="router.get('/report', requireAuth, async (_req: AuthRequest, res: Response) => {  /* mutation: no admin gate */",
        test=T_STATUS,
        expect="GET /report is 403 for a non-admin",
        guards="every route on this router is admin-only; the service topology and "
               "the alert recipient list are not viewer-facing",
    ),
    Mutation(
        name="the season premiere is skipped once the title already matched",
        path="backend/src/lib/remoteIdentity.ts",
        # The ordering bug, restored: rung A2 (`exact title`) short-circuited
        # past B0, so a date that agreed was never consulted. PSYREN and Sirotan
        # became Sonarr auto-add candidates graded `weak` while TVDB and AniList
        # agreed on the air date to the day.
        find="  if (input.tvdbSeasonDeltaMs != null && input.tvdbSeasonDeltaMs <= AIR_DATE_TOLERANCE_MS) {",
        replace="  if (!input.exact && input.tvdbSeasonDeltaMs != null && input.tvdbSeasonDeltaMs <= AIR_DATE_TOLERANCE_MS) {  /* mutation: title text wins again */",
        test=T_UNIT,
        expect="a season premiere outranks matching title text",
        guards="a date that agrees is the difference between dateVerified and weak, "
               "and weak is what keeps a correct match out of the Sonarr auto-add",
    ),
    Mutation(
        name="a split cour is demoted by its own Part 1 premiere",
        path="backend/src/lib/remoteIdentity.ts",
        # The tempting over-reach: let the season premiere REFUTE as well as
        # vouch. Measured over 8 aired seasons, all 27 known-correct entries it
        # would refute are sequels whose cour TVDB files as one season - Part 2
        # sits ~182d from its own Part 1. This mutant sends them to review.
        find="  if (input.exact && p == null) return { verdict: 'accept', rung: 'exact title' };",
        replace="  if (input.exact && p == null && input.tvdbSeasonDeltaMs == null) return { verdict: 'accept', rung: 'exact title' };  /* mutation: refutes too */",
        test=T_UNIT,
        expect="a season premiere that disagrees never demotes an exact title",
        guards="the rung may only upgrade; refuting costs 16% of correct sequels and "
               "buys nothing the audit could measure",
    ),
    Mutation(
        name="a re-decided row forgets whether its title matched exactly",
        path="backend/src/lib/remoteIdentity.ts",
        # The re-decide path recovers the row's own stored candidate instead of
        # re-searching for it. `exact` is the field that makes that safe: the
        # ladder branches on it, so losing it re-decides an exact-title accept
        # as something else entirely - silently, on a path built for speed.
        find="    exact: match.exact,",
        replace="    exact: false,  /* mutation: forgets the exact-title match */",
        test=T_UNIT,
        expect="the stored choice keeps `exact`, because the ladder branches on it",
        guards="a fast path that quietly decides differently from the slow one is "
               "worse than no fast path",
    ),
    Mutation(
        name="a sequel is judged by its parent series' air date",
        path="backend/src/lib/remoteIdentity.ts",
        # The original gate, restored: the lookup ran only when we HELD the
        # series and its episodes looked wrong, so a candidate about to accept on
        # title text alone never asked - the evidence existed upstream and was
        # simply never requested. The ladder cannot use what nobody fetched.
        find="  const needsSeasonDate = !dateAlreadyVouches;",
        replace="  const needsSeasonDate = false;  /* mutation: only rescues, never verifies */",
        test=T_UNIT,
        expect="the season premiere is FETCHED for a title-only accept",
        guards="the ladder half is useless without the fetch half; this is the one "
               "that actually reaches an unheld upcoming season",
    ),
    Mutation(
        name="a link is nested inside the match-control button",
        path="frontend/src/pages/AdminMatching.svelte",
        # Exactly how this shipped for a few hours: making stored ids verifiable
        # put an <a> inside the <button>. That is invalid HTML - an anchor is
        # interactive content and may not sit in a button - and it broke the
        # control for real, because the anchor's `stopPropagation` swallowed the
        # click. Pressing the middle of "change the match" opened TheTVDB in a
        # new tab instead of the picker. Nothing else catches it: the build was
        # clean, svelte-check was clean, and the id rendered correctly.
        find="                    {:else if selected[r.mediaId]?.tvdbId}TVDB {selected[r.mediaId]?.tvdbId}\n                    {:else if selected[r.mediaId]?.tmdbId}",
        replace="                    {:else if selected[r.mediaId]?.tvdbId}<ExternalIdLink id={selected[r.mediaId]?.tvdbId} label={`TVDB ${selected[r.mediaId]?.tvdbId}`} />\n                    {:else if selected[r.mediaId]?.tmdbId}",
        test=T_UI,
        flows=("remote accept visible",),
        expect="waiting for locator(\"[data-match-dropdown]\")",
        guards="an admin cannot change a wrong match at all, and the failure "
               "looks like a dead button rather than an error",
    ),
    Mutation(
        name="a bot wall is retried instead of aborting",
        path="backend/scripts/translate_stream.py",
        # The dangerous direction of the 403 retry, which is the one worth
        # guarding: retrying a bot wall deepens the exact block that aborting
        # exists to escape, and retrying a dead video spends a request that can
        # never succeed. The retry is narrow ON PURPOSE - `forbidden` only, one
        # extra attempt - because request volume is what tripped YouTube's IP
        # block before, and that block then prevents verifying anything.
        find='    return classify_error(msg) == "forbidden"',
        replace="    return True  # mutation: retry every failure kind",
        test=T_VERDICT,
        expect="FAIL: a bot wall is not retried",
        guards="doubling the requests made during a bot wall is how a soft "
               "block becomes a hard one",
    ),
    Mutation(
        name="a dead video counts as the download path breaking",
        path="backend/src/lib/downloadHealth.ts",
        # Measured on a real run: SUMMER 2026 failed FIVE trailers back to back,
        # every one `Video unavailable` - old trailers taken down - against a
        # BROKEN_AFTER of 3. That would mail "the download path is broken" while
        # the same run downloaded 51 other trailers. A video that no longer
        # exists is a fact about that video, not about us.
        find="  return kind !== 'unavailable';",
        replace="  return true;  /* mutation: a dead video breaks the path */",
        test=T_UNIT,
        expect="a dead video is not evidence that downloading is broken",
        guards="an old season is enough to cry wolf, which is how a real "
               "download outage gets ignored when it finally arrives",
    ),
    Mutation(
        name="the red badge ignores the rule the email obeys",
        path="backend/src/lib/upstreamHealth.ts",
        # How the quiet window shipped: the ALERT gained it and `stateOf` kept
        # the streak-alone rule, so /admin/status painted a red Down badge for a
        # service the system had deliberately decided was fine and mailed
        # nothing about - skyhook, 66 ok and 16 failures in one evening, all
        # 500s. Two of this page's five states exist purely so a reader is never
        # misled; that was the page misleading them, and it contradicted the
        # guide's own "the page and the email cannot disagree".
        find="  if (rec.consecutiveFailures >= brokenAfter && noRecentSuccess(rec.lastOkAt, nowIso)) {",
        replace="  if (rec.consecutiveFailures >= brokenAfter) {  /* mutation: badge ignores the window */",
        test=T_UNIT,
        expect="the BADGE means what the EMAIL means",
        guards="a red badge nobody was emailed about sends an admin hunting an "
               "outage that is not happening",
    ),
    Mutation(
        name="a burst of failures is called an outage",
        path="backend/src/lib/upstreamHealth.ts",
        # How it shipped: `crossed: streak === brokenAfter`, with no notion of
        # time. skyhook answered 66 calls and failed 16 in one evening - 19.5%,
        # every one a 500, while working fine - and the resolver drains at 300 ms
        # a call, so three in a row is 0.9 SECONDS. It mailed "not responding"
        # and "working again" one minute apart. Raising the threshold 3 -> 6 was
        # tuning; what separates flaky from dead is whether anything succeeded
        # recently.
        # Anchored on the ALERT's use of the shared rule; the badge's use is a
        # separate row, because the two sites failed independently once already.
        find="  const quiet = noRecentSuccess(rec.lastOkAt, nowIso);",
        replace="  const quiet = true;  /* mutation: a streak is always an outage */",
        test=T_UNIT,
        expect="a burst of failures is not an outage while something just worked",
        guards="an alert that cries wolf during every drain is the alert that "
               "gets filtered into a folder nobody opens",
    ),
    Mutation(
        name="recovery is announced for an outage nobody was told about",
        path="backend/src/lib/upstreamHealth.ts",
        # The pairing. Once "down" is no longer a single equality, reading
        # recovery off the streak announces "working again" for an outage that
        # was never reported - which is worse than silence, because it implies
        # the reader missed a first mail.
        find="    recovered: !!rec.downAlertedAt,",
        replace="    recovered: rec.consecutiveFailures >= brokenAfter,",
        test=T_UNIT,
        expect="recovery is announced only for an outage we actually reported",
        guards="an unpaired recovery mail reads as a missed outage mail",
    ),
    Mutation(
        name="the alert master switch governs nothing",
        path="backend/src/lib/subtitleAlerts.ts",
        # How the page actually shipped: /admin/status offered a master switch
        # and `alertAdmins` - the one funnel every alert goes through - never
        # read it. Switching alerts off kept mailing, which is worse than having
        # no switch: someone who turns it off and still receives mail cannot
        # tell a broken control from a broken service. Found when the deploy
        # gate's fake Sunday verdict landed in the owner's real inbox.
        find="    if (!(await (deps.settings ?? readAlertSettings)()).masterEnabled) {",
        replace="    if (false) {  /* mutation: the switch governs nothing */",
        test=T_UNIT,
        expect="the master switch on /admin/status actually stops the mail",
        guards="a setting that silently does nothing is believed, so the page "
               "would lie about who is being emailed",
    ),
    Mutation(
        name="an undated sibling counts as refuted",
        path="backend/src/lib/seriesIdentity.ts",
        # The tempting simplification: treat a candidate with no premiere date
        # as one the date rules out, so the row settles anyway. `Cyborg 009:
        # Nemesis` exists TWICE in TVDB with one copy undated - nothing proves
        # they are the same show, which is why the resolver refuses to merge
        # them. "We do not know when it aired" is not evidence against it, the
        # same mistake as reading `unknown` availability as "not in the library".
        find="    if (!Number.isFinite(prem)) return false;",
        replace="    if (!Number.isFinite(prem)) continue;  /* mutation: undated means refuted */",
        test=T_UNIT,
        expect="an undated sibling settles nothing - the Cyborg 009: Nemesis shape",
        guards="a duplicate TVDB record would be silently pinned as the match, "
               "undoing the merge rule by a side door",
    ),
    Mutation(
        name="the queue settles a row whose stored pick the date refutes",
        path="backend/src/lib/seriesIdentity.ts",
        # Measured: 1 of 146 otherwise-separable rows had stored a candidate the
        # date refutes. Without this check that row leaves the review queue
        # looking settled, which is worse than looking unverified - nothing
        # downstream would ever question it again.
        find="  return (!!stored.tvdbId && winner.tvdbId === stored.tvdbId)",
        replace="  return true || (!!stored.tvdbId && winner.tvdbId === stored.tvdbId)",
        test=T_UNIT,
        expect="a stored pick the date REFUTES is never settled",
        guards="settling a row on evidence that points at a DIFFERENT candidate "
               "pins a match its own date disagrees with",
    ),
    Mutation(
        name="a TMDB-only candidate can never be dated",
        path="backend/src/lib/remoteIdentity.ts",
        # The gate as it stood after the sequel fix: the season lookup needed a
        # TVDB id on the candidate itself, and half the search results carry only
        # a TMDB one. completeIdentityIds cross-walks them AFTER the verdict, so
        # the stored row showed a TVDB id the ladder was never allowed to use -
        # which reads as "TVDB does not know this season" rather than "we never
        # asked". Kizu darake Seijo S2 sat unverified while TVDB agreed to the day.
        find="    ?? crosswalkIds({ tmdbId: hit.tmdbId, tmdbKind: hit.tmdbKind })?.tvdbId",
        # A no-op operand rather than a deletion: the mutant must type-check,
        # or the row audits the compiler instead of the guard.
        replace="    ?? null  /* mutation: TMDB-only candidates stay undated */",
        test=T_UNIT,
        expect="a TMDB-only candidate is dated through the id cross-walk",
        guards="half of every search's results reach the season rung only through "
               "the cross-walk; without it they are decided on title text",
    ),
    Mutation(
        name="the cross-walk hands a film a TV series' seasons",
        path="backend/src/lib/anilistTvdbMap.ts",
        # TMDB numbers films and shows independently, so the same integer is two
        # different works. Dropping the namespace check dates a movie candidate
        # against a TV series' season premiere - a confident wrong answer, and the
        # same class as parsing themoviedb_id as a scalar.
        find="      if (input.tmdbKind && ref.kind !== input.tmdbKind) continue;",
        replace="      /* mutation: ignore the namespace */",
        test=T_UNIT,
        expect="a movie id must not borrow a TV series TVDB id",
        guards="a film dated against a series premiere is accepted as fact and "
               "never looks wrong on the page",
    ),
    Mutation(
        name="the CC check calls every failure a definitive no",
        path="backend/scripts/translate_stream.py",
        # The original bug, restored: check_subtitles swallowed every exception
        # as hasEnglish=False, and each write site pinned that as a verdict for
        # seven days - so one transient IP block sent a video WITH English CC
        # down the download path for a week.
        find="    return False if names & set(DEFINITIVE_NO_CC) else None",
        replace="    return False  # mutation: every failure is a verdict",
        test=T_VERDICT,
        expect="FAIL: an IP block is not a verdict",
        guards="the third answer is the whole fix; without it a blocked check is "
               "indistinguishable from a checked video with no CC",
    ),
    Mutation(
        name="the Python model rank drifts from the TypeScript one",
        path="backend/scripts/translate_stream.py",
        # The drift the consolidation exists to make impossible: three hand-synced
        # copies, one missing or mis-ranking large-v3-split, and that path treats
        # champion output as a downgrade target and reprocesses a season for nothing.
        find='    "large-v3-split": 6,',
        replace='    "large-v3-split": 5,  # mutation: ties plain large-v3',
        test=T_VERDICT,
        expect="FAIL: Python MODEL_RANK equals the TypeScript copy",
        guards="one definition per language, and a test that says when the two "
               "disagree, is the only thing standing between a Sunday upload and a "
               "Wednesday re-transcription of the same season",
    ),
    Mutation(
        name="an old pip's unknown-option refusal is accepted as a failed update",
        path="backend/scripts/translate_stream.py",
        # pip < 23 exits 2 on --break-system-packages. "Failing gracefully" here
        # means staying on the stale yt-dlp forever, which is the outage.
        find='        if r.returncode != 0 and "no such option" in (r.stderr or r.stdout).lower():',
        replace='        if r.returncode != 0 and "no such option" in "":  # mutation: never retries',
        test=T_VERDICT,
        expect="FAIL: an old pip's 'no such option' triggers exactly one retry without the flag",
        guards="the self-upgrade is what reaches the Sunday PC; a pip that refuses the "
               "flag would otherwise leave it stale with a polite log line",
    ),
    Mutation(
        name="the guard's pre-filter check says every command is reachable",
        path="tools/yt_guard.py",
        # The tautology, restored in a new costume: the first --selftest compared
        # samples against this file's own token list and stayed green while four
        # invocation patterns were unreachable by the real settings.json grep.
        find="    return pat.search(sample) is not None",
        replace='    return True  # mutation: every sample "reaches"',
        test=T_YTGUARD,
        expect="FAIL: the shipped pre-filter could not reach local_translate.py",
        guards="the pre-filter is hand-maintained in a gitignored file; this check is "
               "the only thing that notices when it and the matcher drift apart",
    ),
    Mutation(
        name="reordering My List silently does nothing",
        path="frontend/src/components/WatchListSidebar.svelte",
        # The app's core action, and until this flow existed every test SEEDED an
        # order over the API and only read it back - so a drag that moved nothing
        # would have been invisible. `move()` returning early is the whole bug:
        # no error, no request, and the row snaps back as if the drag missed.
        find="    if (from === to || from < 0 || from >= list.length) return;",
        replace="    if (from === to || from < 0 || from >= list.length || true) return;  /* mutation */",
        flows=("my list reorder",),
        test=T_UI,
        expect="on screen the order is",
        guards="reordering is the one thing this app is for; nothing else in the "
               "suite performs the drag a user performs",
    ),
    Mutation(
        name="a nickname is dropped on the way to the server",
        path="frontend/src/pages/Home.svelte",
        # Saving a nickname re-PUTs the WHOLE list, so dropping the field still
        # returns 200 and still renders correctly until the page is reloaded -
        # the shape that hides best. Asserting on the request body is the only
        # way to see it at the moment it happens.
        find="    const payload = watchList.map(({ mediaId, customName, watchedAt }) => ({ mediaId, customName, watchedAt }));",
        replace="    const payload = watchList.map(({ mediaId, watchedAt }) => ({ mediaId, watchedAt }));  /* mutation */",
        flows=("nicknames set and shown",),
        test=T_UI,
        expect="customName was dropped on the way out",
        guards="nicknames are the only user-authored text in the product, and the "
               "write is a whole-list replace that succeeds either way",
    ),
    Mutation(
        name="the last admin can be demoted from the page",
        path="frontend/src/pages/AdminUsers.svelte",
        # The backend still refuses (LAST_ADMIN), so this cannot actually lock
        # anyone out - which is exactly why it would go unnoticed. What it
        # destroys is the page's promise that a disabled control with a reason
        # beats an error after the click.
        # No trailing `/* mutation */` here, unlike the rows that edit a
        # `<script>` block: inside an element's attribute list Svelte is parsing
        # MARKUP, not JS, so a comment there is a syntax error. The component
        # then fails to compile, the page renders nothing, and the row "fails"
        # on a missing-selector timeout without ever exercising the guard.
        find="                    disabled={busy[row.id] || adminCount <= 1}",
        replace="                    disabled={busy[row.id]}",
        flows=("admin users page",),
        test=T_UI,
        expect="the only admin could be demoted",
        guards="the admin floor is the one mis-click that cannot be undone from "
               "inside the app; the UI is meant to prevent it being attempted",
    ),
    Mutation(
        name="Compare's share can no longer resolve toJpeg",
        path="frontend/src/pages/Compare.svelte",
        # The same mutation the Home share row uses, on the OTHER share function.
        # CLAUDE.md names both as brittle and says to verify them by hand; only
        # `shareMyList` was ever automated, so this half failed silently inside
        # its own try/catch with nothing watching.
        find="      const toJpeg = (mod.toJpeg ?? mod.default?.toJpeg) as (",
        replace="      const toJpeg = (mod.nope ?? mod.default?.nope) as (  /* mutation */",
        flows=("compare share image",),
        test=T_UI,
        expect="Compare share produced nothing",
        guards="Share fails silently by construction; the Compare half was the "
               "untested one of a pair the docs call brittle",
    ),
    Mutation(
        name="a coded account is offered the open reset form",
        path="frontend/src/pages/ResetPassword.svelte",
        # The server still refuses with CODE_REQUIRED, so nothing is actually
        # reset - but the page would be inviting anyone who knows a username to
        # try, and reporting the refusal as an error on a form that can never
        # succeed. That is the dead end this step exists to prevent.
        find="      if (data.codeRequired) {",
        replace="      if (false && data.codeRequired) {  /* mutation */",
        flows=("password reset journey",),
        test=T_UI,
        expect="a coded account was handed the open reset form",
        guards="the reset page is the whole recovery path for a locked-out user, "
               "and no test loaded it at all before this flow",
    ),
    Mutation(
        name="fullscreen is gated on YouTube CC again",
        path="frontend/src/components/AnimeGridTranslate.svelte",
        # The regression this session shipped and an audit caught: the fullscreen
        # button sat inside `{#if !hasEnglishSubs}`, and with `allowfullscreen`
        # gone from the iframe that left YouTube-CC trailers with no fullscreen
        # at all. An inline style reproduces exactly that for the same viewers.
        #
        # The control is now an INVISIBLE COVER over YouTube's own fullscreen
        # button rather than a drawn one, so the anchor moved to the line that
        # positions it. The invariant is unchanged and so is the mutant: hide it
        # when YouTube has CC, and those viewers lose fullscreen entirely -
        # ours does nothing and theirs fullscreens the iframe, where our cues
        # and controls cannot be clicked.
        #
        # NOT `hidden={hasEnglishSubs}`, which was tried first and SURVIVED: the
        # UA stylesheet's `[hidden] { display: none }` loses to Tailwind's
        # `.flex { display: flex }` on the button itself, so the attribute was
        # set and the button stayed on screen. A mutant has to be watched fail.
        find='        style="right: 24px; bottom: 80px;"',
        replace='        style="right: 24px; bottom: 80px; {hasEnglishSubs ? \'display:none\' : \'\'}"',
        test=T_SUBS,
        expect="FAIL [B] - fullscreen button missing",
        guards="fullscreen is player chrome, not a subtitle control; Path A is the "
               "path with the most trailers on it and the one nothing else exercises",
    ),
    Mutation(
        name="our cue is not painted while fullscreen",
        path="frontend/src/components/AnimeGridTranslate.svelte",
        # The half Path B structurally cannot see: its trailer has YouTube CC, so
        # there is no cue of ours to lose. On the Whisper path the cue IS ours,
        # and this is where it vanished repeatedly - the iframe winning the
        # fullscreen takeover leaves it unpainted, because only the fullscreen
        # element is rendered. Hiding the layer under `:fullscreen` reproduces
        # exactly what a viewer saw, and nothing else in the suite notices.
        find="  .sc-player:fullscreen iframe {",
        replace="  .sc-player:fullscreen .sc-cue-layer { display: none; }\n"
                "  .sc-player:fullscreen iframe {",
        test=T_SUBS,
        expect="our subtitle cue disappeared in fullscreen",
        guards="subtitles surviving fullscreen is the whole point of the takeover; "
               "windowed rendering passing says nothing about the fullscreen case",
    ),
    Mutation(
        name="the CC toggle goes dead while fullscreen",
        path="frontend/src/components/AnimeGridTranslate.svelte",
        # The failure that cost the most to find, because every cheap check calls
        # it a pass: with YouTube's iframe fullscreen our controls were painted
        # above it and took no input, and BOTH a screenshot and
        # `document.elementFromPoint` reported them fine. Only clicking and
        # watching the cue move tells the two apart - so the mutant is a handler
        # that runs and does nothing, not a hidden or covered button.
        find="              subtitlesVisible = !subtitlesVisible;",
        replace="              if (isFullscreen) return;\n"
                "              subtitlesVisible = !subtitlesVisible;",
        test=T_SUBS,
        expect="CC toggle did nothing in fullscreen",
        guards="a control that is visible but inert is the exact bug this session "
               "shipped twice; visibility assertions are blind to it",
    ),
    Mutation(
        name="the rank write matches nothing",
        path="backend/src/routes/list.ts",
        # `PATCH /rank` answers {ok:true} whether or not it updated a row, so a
        # `where` that matches nothing is invisible from the response, from the
        # network tab, and from the screen - the page has already moved the row
        # locally. Only reading the ranks back can see it, which is why the flow
        # does not stop at asserting the request.
        find="      where: { userId: req.userId!, season, year: numericYear, mediaId, watched: true },",
        replace="      where: { userId: req.userId!, season, year: numericYear, mediaId: -1, watched: true },  // mutation",
        flows=("watched rank reorder",),
        test=T_UI,
        expect="watchedRank did not move",
        guards="a write that reports success and changes nothing is the worst "
               "shape of bug this codebase has; the route cannot report it",
    ),
    Mutation(
        name="a wobbling service is called Down again",
        path="backend/src/lib/upstreamHealth.ts",
        # Restores the bug this session fixed, from the page's side: skyhook
        # failing 16 of 66 calls in an evening while plainly working painted a
        # red Down badge and sent no email, so the page contradicted its own
        # alert. The route test cannot see it - only a rendered badge can.
        find="  if (rec.consecutiveFailures >= brokenAfter && noRecentSuccess(rec.lastOkAt, nowIso)) {",
        replace="  if (rec.consecutiveFailures >= brokenAfter) {  // mutation",
        flows=("admin status badges",),
        test=T_UI,
        expect="reads state 'down', expected 'failing'",
        guards="Down and Failing are the difference between 'go look now' and "
               "'it is coping'; the page and the alert must never disagree",
    ),
    Mutation(
        name="the YouTube guard goes back to substring matching",
        path="tools/yt_guard.py",
        # The original bug, restored: matching the WORD anywhere blocked fetching
        # yt-dlp's own docs from GitHub and `echo "yt-dlp wiki FAQ"`. A guard that
        # blocks reading about itself gets routed around, and then protects nothing.
        find="    return bool(_HOST_RE.search(cmd) or _INVOKE_RE.search(cmd))",
        replace='    return "yt-dlp" in cmd.lower() or bool(_HOST_RE.search(cmd) or _INVOKE_RE.search(cmd))  # mutation',
        test=T_YTGUARD,
        expect="FAIL: matcher negative: GitHub docs about yt-dlp",
        guards="precision is what makes the guard survivable; every false positive it "
               "shipped with was found by blocking a person mid-work",
    ),
    Mutation(
        name="a plain 403 starts holding downloads like a bot wall",
        path="backend/src/lib/downloadHealth.ts",
        # The asymmetry is the design: a bot wall is YouTube saying "you", a 403
        # is the stale-yt-dlp signature that the daily updater may fix any minute.
        # Holding on a 403 would hide the recovery the health record exists to show.
        find="  if (h.lastFailKind !== 'botwall' || !h.lastFailAt) return null;",
        replace="  if (!h.lastFailAt) return null; /* mutation: every failure kind holds */",
        test=T_UNIT,
        expect="a forbidden (403) failure never holds downloads",
        guards="the 2026-09 outage was a 403; under this mutant the fix would have "
               "deployed and the site would have kept refusing viewers for 15 minutes "
               "after every failed attempt, indistinguishable from still-broken",
    ),
    Mutation(
        name="/stream ignores the bot-wall hold",
        path="backend/src/routes/translate.ts",
        # `hold.hold && !hold.hold` is always false and type-checks; `false &&`
        # would narrow and risk an unreachable-code diagnostic (the compiler
        # trap the account-security rows hit). Under this mutant the request falls
        # through to the daemon, which tries the fake id - one harmless YouTube
        # "unavailable" - so the row is also cheap to watch fail.
        find="  if (hold.hold) {",
        replace="  if (hold.hold && !hold.hold) { /* mutation: hold never applies */",
        test=T_HOLD,
        expect="FAIL: stream refused while holding",
        guards="without the gate every viewer who opens a trailer during a block "
               "sends one more request at a blocked IP - the production twin of the "
               "hand-retry loop tools/yt_guard.py exists to stop",
    ),
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
        # through TMDB - measured: step 6 still found id matches, and the
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
        guards="a new work resolves to its franchise parent - Pokemon Concierge "
               "played episode 109 of season 20 of Pokemon",
    ),
    Mutation(
        name="a guessed id gains negative-evidence power",
        path=BACKEND_MATCH,
        # Resolver ids must be positive-only. Granting them both directions lets
        # an unverified TMDB guess delete a working title match - the same
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
        name="the Sonarr list stops excluding unverified (pending) identities",
        path=BACKEND_SONARR,
        # Everywhere else a resolver guess is positive-only because a bad one
        # costs a Watch button that doesn't work. On this path it costs a whole
        # season of the wrong series on disk, so this is the ONE place the
        # identity filter is stricter than the site's.
        find="  if (!identity || identity.pending || identity.rejected) return null;",
        replace="  if (!identity || identity.rejected) return null; /* mutation */",
        test=T_UNIT,
        expect="an unverified guess must not download a season of the wrong series",
        guards="Sonarr grabs ~4.6 GB of a series we only guessed at, and nothing "
               "on the list says which rows were guesses",
    ),
    Mutation(
        name="the Sonarr list's scope filter is replaced by the site's sequel predicate",
        path=BACKEND_SONARR,
        # The exact 'correction' a future contributor is most likely to make:
        # three other files in this repo test "has ANY of SEQUEL/PREQUEL/
        # SIDE_STORY", and reusing one here looks like removing a duplicate. It
        # silently shrinks the list to shows nobody ever continued, which no
        # count assertion would catch - the list just gets quietly smaller.
        find="    if (t === 'PREQUEL' || t === 'PARENT') return false;",
        replace="    if (t === 'PREQUEL' || t === 'PARENT' || t === 'SEQUEL' || t === 'SIDE_STORY') return false; /* mutation */",
        test=T_UNIT,
        expect="a first season that later got a sequel must still be auto-added",
        guards="every first season that has since spawned a sequel stops being "
               "auto-added - the majority of what the list exists to catch",
    ),
    Mutation(
        name="the Sonarr list stops deduping by tvdbId",
        path=BACKEND_SONARR,
        # Seasons and split cours of one series share a TVDB id and
        # resolveIdentity does not dedupe. There were no live collisions when
        # this was measured, so only a prospective assertion can catch it.
        find="""    if (seen.has(tvdbId)) {
      drop('duplicateTvdbId');
      continue;
    }""",
        replace="    /* mutation: dedupe disabled */",
        test=T_UNIT,
        expect="a tvdbId must appear at most once in the list",
        guards="Sonarr is handed the same series twice in one list",
    ),
    Mutation(
        name="a series we already added is offered again once it is deleted",
        path=BACKEND_SONARR_PUSH,
        # The entire feature in one branch. Without the terminal check a series
        # deleted from Sonarr - by Maintainerr, by a human, for any reason -
        # becomes a candidate again on the next run and is re-added. That is the
        # re-add loop the Custom List had, rebuilt inside the push.
        find="""  if (prior && isTerminal(prior.status)) {
    return { action: 'skip', reason: prior.status === 'pushed' ? 'alreadyPushed' : 'alreadyHeld' };
  }""",
        replace="  /* mutation: push history ignored */",
        test=T_UNIT,
        expect="a series we already pushed is never pushed again",
        guards="every series you delete comes back on the next run, forever",
    ),
    Mutation(
        name="Sonarr saying the series already exists is recorded as a failure",
        path=BACKEND_SONARR_PUSH,
        # The held set comes from a cached snapshot, so a series added between
        # snapshots answers 400 "already been added". Filed as a failure it stays
        # retryable and is retried on every run for ever - the same infinite loop
        # arriving through the error path instead of the happy one.
        find=r"""  if (sonarrValidationMessages(res.body).some((m) => /already\s*(been\s*)?(added|exists)/i.test(m))) {
    return 'alreadyExists';
  }""",
        replace="  /* mutation: already-exists is just another failure */",
        test=T_UNIT,
        expect="Sonarr saying the series has already been added is not a failure",
        guards="a series Sonarr already holds is retried on every run for ever",
    ),
    Mutation(
        name="every skip is recorded, not just the ones Sonarr already holds",
        path=BACKEND_SONARR_PUSH,
        # Recording an EXCLUSION as terminal would outlive the decision behind
        # it: a Sonarr Import List Exclusion can be lifted there, and a row here
        # would keep refusing the series long after someone changed their mind.
        find="    if (s.reason !== 'alreadyHeld') continue;",
        replace="    /* mutation: every skip recorded */",
        test=T_UNIT,
        expect="a terminal row would outlive the human decision behind it",
        guards="lifting an exclusion in Sonarr silently does nothing, because we "
               "pinned our own permanent refusal the first time we saw it",
    ),
    Mutation(
        name="a series Sonarr no longer holds is still reported as an orphan",
        path=BACKEND_SONARR_PUSH,
        # An orphan is a deletion to make BY HAND - we have no delete verb. One
        # named for a series that is already gone asks someone to act on nothing,
        # which is how a real orphan later gets ignored.
        find="    if (!held.has(row.tvdbId)) continue;",
        replace="    /* mutation: gone series still count */",
        test=T_UNIT,
        expect="only a series still held can need deleting",
        guards="the page tells you to delete series that are not there, and the "
               "real ones stop being believed",
    ),
    Mutation(
        name="the run cap discards its overflow instead of deferring it",
        path=BACKEND_SONARR_PUSH,
        # `slice(0, 100)` on a 128-entry season once made a review page report
        # "nothing needs review" for a third of it. Same shape: a truncated plan
        # that reads as a complete one, so "all done" and "10 still waiting"
        # become indistinguishable.
        find="""    } else {
      plan.deferred.push(candidate);
    }""",
        replace="    }",
        test=T_UNIT,
        expect="the rest are deferred, not discarded",
        guards="anything past the cap vanishes silently and the page reports the "
               "run as complete",
    ),
    Mutation(
        name="the ours count includes every tagged series, not just our marker",
        path=BACKEND_SONARR_ROUTE,
        # The exact "simplification" the data invites, and the Custom List
        # version of this line really did make the mistake: it counted rows a
        # snapshot had merely observed, which on a library owned for months
        # claimed the whole thing. Only a 201 from Sonarr writes a `pushed` row,
        # and that is the only thing "we added N" may ever count.
        find="""            markerId === null
              ? []
              : snapshot.series.filter((s) => s.tags.includes(markerId)).map((s) => s.tvdbId),""",
        replace="""            snapshot.series.filter((s) => s.tags.length > 0).map((s) => s.tvdbId), /* mutation */""",
        test=T_SONARR,
        expect="only the marker tag may count, never a shared one",
        guards="the page claims credit for every series you already owned - `anime` "
               "alone is on 692 of them here, and two shows owned for years really "
               "did render as ours",
    ),
    Mutation(
        name="a Sonarr table row loses a cell and every value shifts a column",
        path=ADMIN_SONARR,
        # The bug as it happened: a stray <td> put 8 cells in a 7-column table,
        # so titles rendered under TVDB and dates under Eps. tsc, svelte-check
        # and the API tests were all green - it was found by a human looking at
        # the screen, which is why this page needed a browser flow at all.
        find="""                      </span>
                    </td>
                    <td></td>""",
        replace="""                      </span>
                    </td>""",
        test=T_UI,
        flows=("sonarr page renders",),
        expect="values render under the wrong headings",
        guards="every column on the Sonarr page reads one cell off, so the ids, "
               "dates and states shown belong to the wrong field",
    ),
    Mutation(
        name="a force-include stops checking whether the identity is verified",
        path=BACKEND_SONARR,
        # This is the hole as it actually existed: the forced branch skipped
        # usableTvdbId entirely, so `tvdbId && !pending && !rejected` never
        # applied to overrides. 22 candidates carried a pending identity when it
        # was measured, among them Echo - offered a namesake 1,012 days from the
        # entry's premiere. Row 39 guards the automatic path and passes; this
        # guards the override, which is where the gap was.
        find="""      } else if (unverified && !forced.acknowledgedUnverified) {
        drop('unverifiedNotAcknowledged');""",
        replace="""      } else if (false) { /* mutation: unverified overrides wave through */
        drop('unverifiedNotAcknowledged');""",
        test=T_UNIT,
        expect="an unverified identity must not be force-included blindly",
        guards="one click on Include downloads a whole season of a series we only "
               "guessed at, with nothing on screen saying it was a guess",
    ),
    Mutation(
        name="the include endpoint stops refusing an unverified match",
        path=BACKEND_SONARR_ROUTE,
        # The server-side half. The UI asking is a courtesy; this 409 is the
        # guard, and it has to hold for a curl or a stale page too.
        find="  if (unverified && !acknowledge) {",
        replace="  if (false) { /* mutation: never ask */",
        test=T_SONARR,
        expect="expected 409 UNVERIFIED_MATCH",
        guards="any caller can pin an unverified identity onto the list without "
               "ever being told it was unverified",
    ),
    Mutation(
        name="the Sonarr push runs without being switched on",
        path=BACKEND_SONARR_ROUTE,
        # The master switch is the only thing between this feature and someone
        # else's disk. The test pauses explicitly and then checks the push ROWS,
        # not the response body - a guard that wrote first and reported "paused"
        # afterwards would sail through a body-only check.
        find="  return row?.value === 'true';",
        replace="  return true; /* mutation: always on */",
        test=T_SONARR,
        expect="the master switch ignored an explicit pause",
        guards="a deployment that was never switched on starts adding a season's "
               "worth of series to Sonarr on its own",
    ),
    Mutation(
        name="the admin gate comes off the Sonarr report",
        path=BACKEND_SONARR_ROUTE,
        # This router serves exactly ONE public route. /report carries what
        # Sonarr holds and excludes, which is not a viewer's business - and a
        # public router that grows admin data is precisely the trap the file's
        # docstring warns about.
        find="router.get('/report', requireAuth, requireAdmin, async (req, res) => {",
        replace="router.get('/report', async (req, res) => { /* mutation */",
        test=T_SONARR,
        expect="expected 401 unauthenticated",
        guards="the whole Sonarr library and exclusion list are served to anyone "
               "who asks",
    ),
    Mutation(
        name="the Sonarr list's next season stops rolling into the next year",
        path=BACKEND_SONARR,
        # FALL -> WINTER is the only season step that changes the year, so this
        # is invisible for nine months and then serves WINTER of the year that
        # has already happened - an empty or stale second season, every Q4. The
        # same test pins the UTC-vs-local half of this function, which is what
        # caught the original bug.
        find="    year: nextIdx === 0 ? current.year + 1 : current.year,",
        replace="    year: current.year, /* mutation */",
        test=T_UNIT,
        expect="FALL is followed by WINTER of the NEXT year",
        guards="from October onwards the list's second season is the wrong year, "
               "so nothing upcoming is ever proposed",
    ),
    Mutation(
        name="a film we don't hold falls back to matching TV series",
        path=BACKEND_JF,
        # Restoring the category error: without the early return, a film id that
        # isn't in the film index drops through to title-matching a series-only
        # list. Measured at 26 wrong matches against 1 real one.
        find="""      if (!film) {
        const data = { available: false, matchedBy: 'id', idConfident };
        rememberAvailability(mediaId, data, 10 * 60 * 1000);
        return data;
      }""",
        replace="      if (!film) { /* mutation: fall through to series */ } else {",
        also=[("      rememberAvailability(mediaId, data, 60 * 60 * 1000);\n      return data;\n    }\n\n    const entry = {",
               "      rememberAvailability(mediaId, data, 60 * 60 * 1000);\n      return data;\n      }\n    }\n\n    const entry = {")],
        test=T_JELLYFIN,
        expect="fell through to a SERIES title match",
        guards="a film resolves to the television series of the same name - "
               "The Last Blossom played House",
    ),
    Mutation(
        name="an explicit rejection no longer suppresses the title match",
        path=BACKEND_JF,
        # This shipped broken and no test caught it: a rejection carries no ids,
        # so without the short-circuit it falls through to the title tier - the
        # very match being rejected. It looked fixed on screen (the row leaves
        # the review list) while the Watch button stayed.
        find="    if (identity.rejected) {",
        replace="    if (false) { /* mutation */",
        test=T_JELLYFIN,
        expect="a rejection with no ids",
        guards="Reject on /admin/matching saves a row, drops the entry from the "
               "list, and leaves the wrong Watch button on screen",
    ),
    Mutation(
        name="a recorded miss shadows the community map",
        path=BACKEND_IDENTITY,
        # Both halves of "check again later" were broken by the same bookkeeping
        # row. This half meant a pair added upstream could never take effect:
        # once we had looked and failed, our empty row answered first, forever.
        # Nothing observable goes wrong - the system just silently stops
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
               "at Jellyfin - the stampede class this codebase keeps relearning",
    ),
    Mutation(
        name="a same-day double premiere opens on whichever episode came last",
        path="backend/src/lib/episodeMatch.ts",
        find="    if (delta < bestDelta || (delta === bestDelta && best !== null && earlier(e, best))) {",
        replace="    if (delta < bestDelta) { /* mutation: first-seen wins ties */",
        test=T_UNIT,
        expect="ties must go to the earlier episode even when",
        guards="Watch opens episode 2 of a double premiere whenever Jellyfin "
               "happens to list it first - order the API never promised",
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
        flows=("check-batch chunked",),
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
        find="          showTranslationError(withHoldHint(data.error, data.holdUntil));",
        replace="          /* mutation: console-only again */",
        flows=("translation error visible",),
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
        flows=("phone sidebar collapsed",),
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
        flows=("phone sidebar collapsed",),
        test=T_UI,
        expect="covers the viewport centre on a 375px phone load",
        guards="anyone who ever opened Home on a desktop gets the full-screen "
               "sidebar back on every phone load, stored as their own choice",
    ),
    Mutation(
        name="a guest's options stop reaching localStorage",
        path="frontend/src/stores/options.ts",
        # The raw `localStorage.setItem` this used to anchor became `writeMirror`
        # when the load path started needing the same write. Anchored on the
        # *persist* call specifically - `writeMirror(resolved)` in the load path is
        # a different guard with its own row.
        find="    writeMirror(value);",
        replace="    /* mutation: guests lose options on reload */",
        flows=("guest options + compare warning",),
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
        flows=("guest options + compare warning",),
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
        # The hide action itself filters notAired, so this lies without acting -
        # which is why only the button-state assertion can see it.
        find="          if (!info.unknown && !info.notAired) recordAvailability(mediaId, info.available);",
        replace="          if (!info.unknown) recordAvailability(mediaId, info.available); /* mutation */",
        flows=("unaired not looked up",),
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
        # every id-bearing confirm as source:'manual', note:null - wiping the
        # provenance the server-side merge exists to preserve. This recreates
        # that: an untouched confirm is dressed up as a manual correction.
        find="                  const changed = !sameIdentity(sel, baseline[r.mediaId] ?? null);",
        replace="                  const changed = !!sel; /* mutation: any selection reads as a correction */",
        flows=("remote accept visible",),
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
        # test file as ERR_TEST_FAILURE without running one assertion - red for
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
               "arrived in - corrections quietly lose their redundancy",
    ),
    Mutation(
        name="a title-text remote accept is invisible to review again",
        path="frontend/src/pages/AdminMatching.svelte",
        # The resolver accepts an exact title without any air date vouching for
        # it, stored pending=false - this clause is the only one that lists such
        # a row. Neutering it recreates the hole: a wrong exact-title collision
        # (two works genuinely sharing a name) becomes permanent, and the empty
        # state says nothing needs review.
        find="""  const resolverAccept = (r: Row) =>
    !r.confirmed && r.source === 'remote' && !r.pending &&""",
        replace="""  const resolverAccept = (r: Row) =>
    false && !r.confirmed && r.source === 'remote' && !r.pending && /* mutation */""",
        flows=("remote accept visible",),
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
        # unknown upstream has been unknown its whole life - without this line
        # every permanent residue entry burns a lookup a month, forever.
        find="  if (startYear < thisYear - 2) return Infinity;",
        replace="  /* mutation: never retire */",
        test=T_UNIT,
        expect="must be retired",
        guards="the sweep budget is spent re-asking about lost causes monthly, "
               "and the status line's retired count silently reads zero",
    ),
    Mutation(
        name="a stored row is re-graded forever, or never",
        path=BACKEND_IDENTITY,
        # The version stamp is what makes a matcher fix reach rows already
        # decided AND stop once it has. Dropping the comparison re-resolves
        # every row on every sweep - unbounded provider traffic that never
        # converges - and is indistinguishable from working, since the rows do
        # get re-graded.
        find="  return (row.resolverVersion ?? 0) < currentVersion;",
        replace="  return true; /* mutation: always stale */",
        test=T_UNIT,
        expect="that is what makes the pass self-terminating",
        guards="every stored row is re-resolved on every sweep, forever, "
               "spending the whole budget re-deciding settled entries",
    ),
    Mutation(
        name="candidates merge on a matching title instead of an id cross-reference",
        path=BACKEND_REMOTE,
        # The guard, not the feature: merging the same show found in both
        # providers is right, but only on skyhook's own tmdbId cross-reference.
        # Collapsing same-titled candidates would fuse Echo's three different
        # films into one entity and destroy the date evidence that picks the
        # right one.
        find="""    const xref = c.tvdbId && !c.tmdbId ? tmdbForTvdb.get(String(c.tvdbId)) : undefined;
    if (!xref) {
      out.push(c);
      return;
    }
    const j = cands.findIndex(
      (o, k) => k !== i && !absorbed.has(k) && !o.tvdbId && o.tmdbId && String(o.tmdbId) === xref
    );""",
        replace="""    const j = cands.findIndex(
      (o, k) => k !== i && !absorbed.has(k) && o.matchedTitle === c.matchedTitle
    ); /* mutation: merge on title text */""",
        test=T_UNIT,
        expect="different works and must all survive",
        guards="two different works that share a title are fused into one "
               "candidate, taking the wrong id and the wrong date with it",
    ),
    Mutation(
        name="an unheld film falls back to title-matching TV series",
        path=BACKEND_MATCH,
        # classifyMatch is the one definition the admin panel's per-season row
        # and the sweep's all-seasons tally both count. Letting a film fall
        # through to the series list is the "The Last Blossom -> House"
        # category error, measured at 26 wrong matches against 1 right one.
        find="""  if (entry.tmdbKind === 'movie' && entry.tmdbId) {
    return heldFilmTmdbIds.has(String(entry.tmdbId)) ? 'id' : 'notHeld';
  }""",
        replace="  /* mutation: films fall through to the series list */",
        test=T_UNIT,
        expect="that is the House category error",
        guards="a film we don't hold is counted as a title match against an "
               "unrelated TV series, in both scopes of the admin panel",
    ),
    Mutation(
        name="provider popularity decides which candidate is offered",
        path=BACKEND_REMOTE,
        # The last rung of pickCandidate. Without date ordering here, TMDB's
        # popularity ranking picks the suggestion a human reviews - which is
        # how Echo was offered its 2023 namesake 1,012 days from the premiere
        # while the 2026 film 46 days away sat third in the list.
        find="    const dated = exacts.filter((c) => delta(c) != null).sort(byDelta);\n    return dated[0] ?? exacts[0];",
        replace="    return exacts[0]; /* mutation: provider order decides */",
        test=T_UNIT,
        expect="days from the premiere must be offered",
        guards="the review queue suggests whichever same-titled work is most "
               "popular rather than the one that could actually be it",
    ),
    Mutation(
        name="the manual drain obeys retry cooldowns like a scheduled run",
        path=BACKEND_REMOTE,
        # planSweep's one override: a human pressing Run sweep now is not the
        # daily budget. Without it the button is a no-op on exactly the state
        # it exists for - a backlog whose rows were all asked about recently.
        find="    cooldown++;\n    return !!opts?.ignoreCooldown;",
        replace="    cooldown++;\n    return false; /* mutation: drain obeys cooldown */",
        test=T_UNIT,
        expect="an admin pressing the button is not the daily budget",
        guards="the drain button silently skips every cooling entry, which after "
               "one sweep is the whole queue",
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
        name="Enter in the library search marks the show watched",
        path="frontend/src/pages/Randomize.svelte",
        # handleModalKey is a WINDOW listener, so the pop-up's Enter = "mark
        # watched" fires wherever the keystroke came from - including a text
        # box the viewer is typing a search into. The player already guards
        # against this; pick mode reached the same trap from another direction,
        # and it was found by using the feature, not by any test.
        find="  if (pickOpen) {",
        replace="  if (false) { /* mutation: modal keys ignore pick mode */",
        flows=("viewer picks the right show",),
        test=T_UI,
        expect="closed the picker",
        guards="typing a query and pressing Enter marks the very show being "
               "corrected as watched and closes the pop-up",
    ),
    Mutation(
        name="title text counts as date evidence",
        path=BACKEND_IDENTITY,
        # The rung list decides which resolver ids are settled enough to hide
        # the viewer's correction picker. Widening it to any accepted rung
        # would hide the control on exact-title and release-year accepts -
        # the Echo class, and the coincidental-sibling class - which are
        # precisely the rows a human should be able to correct.
        find="const DATE_RUNGS = ['remote: air date', 'remote: premiere date', 'remote: tvdb season premiere'];",
        replace="const DATE_RUNGS = ['remote: '];",
        test=T_UNIT,
        expect="isDateVerified",
        guards="a match accepted on title text alone is presented as settled, "
               "so no viewer is offered the chance to correct it",
    ),
    Mutation(
        name="a viewer can clear an admin's decision",
        path=BACKEND_JF,
        # The undo half of the same rule. Split from the pick row because
        # the two guards are separate code that can regress separately -
        # and because one shared anchor silently audited only this one.
        find="""  if (existing?.confirmed || existing?.rejected) {
    return res.status(409).json({
      error: 'An admin has already settled this entry',
      code: 'ALREADY_SETTLED',
    });
  }
  // Nothing stored is not an error""",
        replace="  // Nothing stored is not an error",
        test=T_JELLYFIN,
        expect="a viewer cleared an admin's rejection",
        guards="any signed-up user can wipe an admin's Reject from the Watch "
               "pop-up, putting the wrong Watch button back for everyone",
    ),
    Mutation(
        name="a viewer pick can overwrite an admin's decision",
        path=BACKEND_JF,
        # The only identity endpoint any logged-in user can reach. Nothing else
        # guards confirmed/rejected rows - setIdentityOverride upserts
        # unconditionally, and before this endpoint existed only admin-gating
        # stood between a viewer and a deliberate Reject.
        # ANCHORED PAST THE GUARD on purpose: /identity/unpick carries a
        # byte-identical block, and the bare line matched THAT one - so this
        # row spent a run proving the unpick guard while its name claimed
        # pick, leaving pick unaudited. The audit found it; nothing else
        # could have.
        find="""  if (existing?.confirmed || existing?.rejected) {
    return res.status(409).json({
      error: 'An admin has already settled this entry',
      code: 'ALREADY_SETTLED',
    });
  }
  try {""",
        replace="  try {",
        test=T_JELLYFIN,
        expect="a viewer overwrote an admin-confirmed row",
        guards="any signed-up user can silently undo an admin's Confirm or "
               "Reject from the Watch pop-up",
    ),
    Mutation(
        name="the picker offers library items that cannot be pinned",
        path=BACKEND_LIBPICK,
        # A pick is stored as an identity override and resolved by id, so a
        # library item carrying neither id cannot be pinned at all. Offering it
        # is a menu entry that silently changes nothing when clicked.
        find="    if (!s.tvdbId && !s.tmdbId) continue;",
        replace="    /* mutation: offer id-less items too */",
        test=T_UNIT,
        expect="must never be offered",
        guards="the viewer picker lists shows whose selection cannot take "
               "effect, so the correction appears to work and does nothing",
    ),
    Mutation(
        name="an unverifiable suggestion gives no reason on screen",
        path=ADMIN_MATCHING,
        # The reviewer is asked to judge a match with the evidence that decided
        # it. Dropping the reason restores the bare word "unverified", which is
        # what the page said while 81 rows were ALSO being told, wrongly, that
        # they matched on an exact title.
        #
        # This guards the branch the harness can reach: an unheld pending row.
        # The sibling wording on HELD rows (the Bananya case) renders only for
        # a row whose id the library carries, which this test cannot seed -
        # stated so the gap isn't mistaken for coverage.
        find="      return { verdict: 'Needs review', detail: `auto-search found a likely match - ${unverifiedBecause(r)}`, cls: 'badge-warning', options };",
        replace="      return { verdict: 'Needs review', detail: 'auto-search found a likely match - unverified', cls: 'badge-warning', options };",
        flows=("remote accept visible",),
        test=T_UI,
        expect="gives no reason at all",
        guards="the page states a reason the match never used, which is the one "
               "thing its state column promises never to do",
    ),
    Mutation(
        name="the stats block silently disappears",
        path=ADMIN_MATCHING,
        # The tiles are the page's answer to "how much of this season is
        # actually handled" - a markup regression that drops them leaves the
        # page functional-looking and the question unanswerable.
        find='<div class="overflow-x-auto -my-1" data-matching-stats>',
        replace='<div class="hidden" data-matching-stats-mutated>',
        flows=("remote accept visible",),
        test=T_UI,
        expect="no stats block",
        guards="the season-health and auto-search-queue tiles can vanish "
               "without any test noticing",
    ),
    Mutation(
        name="the sweep trigger endpoint loses its admin gate",
        path=BACKEND_JF,
        # The manual sweep starts real provider traffic (skyhook + TMDB via
        # Jellyfin) - ungated, any logged-in user can drain someone else's
        # budget. NOTE: the mutant run really does 202 a sweep on the dev
        # backend; the revert's restart kills it within seconds, and the dev
        # DB's eligible queue is near-empty, so the leaked traffic is a few
        # calls at most.
        find="router.post('/identity/sweep', jellyfinLimiter, requireAuth, requireAdmin, async (_req, res) => {",
        replace="router.post('/identity/sweep', jellyfinLimiter, requireAuth, async (_req, res) => { /* mutation */",
        test=T_JELLYFIN,
        expect="identity/sweep: expected 403 ADMIN_REQUIRED",
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
        flows=("remote accept visible",),
        test=T_UI,
        expect="did not enter its running state",
        guards="the admin's only manual sweep control can break without any "
               "test noticing - a dead button still looks clickable",
    ),
    Mutation(
        name="the release-year rung accepts TV candidates again",
        path=BACKEND_REMOTE,
        # The year rung exists because a film has no episodes to date. For a
        # series the year is nearly free - TMDB's Year-filtered search returns
        # same-year works - so ungating it writes a coincidental TV sibling
        # into the identity table as accepted fact, no human in the loop.
        find="  if (input.kind === 'movie' && input.yearDelta != null && input.yearDelta <= 1) {",
        replace="  if (input.yearDelta != null && input.yearDelta <= 1) { /* mutation */",
        test=T_UNIT,
        expect="year rung is for films only",
        guards="a same-year TV franchise sibling we don't hold becomes a stored "
               "id that is never re-examined - the air-date gate's failure "
               "class, minus the air date",
    ),
    Mutation(
        name="an exact title blind-accepts against a refuting premiere date",
        path=BACKEND_REMOTE,
        # The Echo bug restored: rung A2 used to be the whole of rung A - an
        # exact title accepted unconditionally, so TMDB's "Echo" (2023) was
        # written as fact for an anime premiering 2026-07-19, with the day that
        # refuted it (1,012d) sitting unread in the same search response.
        find="  if (input.exact && p == null) return { verdict: 'accept', rung: 'exact title' };",
        replace="  if (input.exact) return { verdict: 'accept', rung: 'exact title' }; /* mutation */",
        test=T_UNIT,
        expect="must not blind-accept",
        guards="a same-titled work years from the entry's premiere is stored as "
               "an accepted match - the Echo class",
    ),
    Mutation(
        name="a dated localized-title match stays queued forever",
        path=BACKEND_REMOTE,
        # Rung D0 is what resolves the queue rows title text never could: TMDB
        # holds the work under its localized English title, 0 days from the
        # AniList premiere. Neutering it re-strands all 14 measured cases.
        # `p <= -1` and not `if (false)`: p is an absolute delta so it can never
        # fire, but the branch stays reachable - TS drops null-narrowing inside
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
        # premiere date vouches for - DIVE IN! shipped its 167d sibling while
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
        # straight to "Mission" - which TMDB answered with Mission: Impossible -
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
        # "Mission" a legitimate variant) - without the length floor a short
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
        # has SOME episode within days of any date - the first pass of the
        # measurement 'verified' Natsume S7 against a Lego Friends mid-run
        # episode exactly this way.
        find="    if (e.seasonNumber <= 0 || e.episodeNumber !== 1 || !e.airDate) continue;",
        replace="    if (e.seasonNumber <= 0 || !e.airDate) continue; /* mutation */",
        test=T_UNIT,
        expect="must not verify",
        guards="any currently-airing series on TVDB date-verifies against any "
               "seasonal entry - the Lego Friends confound",
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
               "series' about its own parent - the Frieren S3 class",
    ),
    Mutation(
        name="identity writes tell no one - the availability cache goes stale",
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
        # The in-memory delete alone looked correct in every live check - the
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
        guards="boot restore resurrects the pre-correction verdict from disk - "
               "the exact failure the identity cache-bust exists to prevent",
    ),
    Mutation(
        name="Confirm wipes provenance again",
        path=BACKEND_IDENTITY,
        # The PUT handler merges onto the stored row so that confirming a
        # resolver suggestion keeps its source/note/candidates. Nulling the note
        # on every write is exactly what the handler used to do - one click of
        # Confirm erased which rung of the ladder accepted the id and relabelled
        # it a human decision.
        find="    note: patch.note !== undefined ? patch.note : existing.note,",
        replace="    note: patch.note ?? null, /* mutation */",
        test=T_UNIT,
        expect="Confirm must not wipe provenance",
        guards="the review page destroys its own evidence - every confirmed row "
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
        expect="a correction saved on",
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
               "then errors anyway - the exact bug this replaced",
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
        # which drops `unknown` before any page sees it - so the old row, which
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
        # same client cache - leaving it intact lets a pop-up refill the cache
        # with a definite answer and mask the mutation.
        also=[("      if (!data.unknown) _availabilityCache.set(mediaId, data);",
               "      _availabilityCache.set(mediaId, data); /* mutation */")],
        # And the page checks again on the way in. That second guard is real
        # defence in depth, not redundancy to be deleted - but it does mean the
        # store guard alone is unreachable: an `unknown` that gets past the
        # store is filtered here instead, so the wheel behaves correctly and the
        # mutation survives having changed nothing. Both layers have to go for
        # the invariant to be exercised at all.
        extra=[("frontend/src/pages/Randomize.svelte",
                "          if (!info.unknown && !info.notAired) recordAvailability(mediaId, info.available);",
                "          if (!info.notAired) recordAvailability(mediaId, info.available); /* mutation */")],
        flows=("unknown never hides",),
        test=T_UI,
        # The failure text, not the pass text - 'unknown verdicts' appears only
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
        flows=("share as image",),
        test=T_UI,
        expect="Share produced nothing",
        guards="Share silently does nothing - the failure is swallowed by its own "
               "try/catch, the same shape that downgraded every ASS release to WebVTT",
    ),
    Mutation(
        name="the Compare user search stops querying the backend",
        path="frontend/src/pages/Compare.svelte",
        find="          bind:filterText={otherInput}",
        replace="          bind:searchText={otherInput}",
        flows=("compare 2 users",),
        test=T_UI,
        # Was `never offered by the picker`, the flow's general "it worked out"
        # assertion - which a full audit watched this mutation SURVIVE, because
        # `cleanup_users` leaves the seeded user inside the unfiltered
        # `/api/users` slice and the picker finds it without ever searching.
        # The request-level assertion cannot be satisfied by a small database.
        expect="never queried /api/users with what was typed",
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
        flows=("hung backend reported",),
        test=T_UI,
        expect="hung availability request left the page waiting",
        guards="a hung backend hangs the page indefinitely - no error, no timeout, "
               "nothing to catch, which is the failure mode with no upper bound",
    ),
    Mutation(
        name="a failed hide write no longer reverts",
        path="frontend/src/pages/Randomize.svelte",
        # Break the state revert only, leaving the message. Removing the whole
        # `revertHidden` call also removes the warning, so the test died waiting
        # for that instead of reaching the assertion about UI/server agreement -
        # red, but for the wrong reason, which proves nothing about the guard.
        find="    watchList = watchList.map((e) => (undo.has(e.mediaId) ? { ...e, hidden: back } : e));",
        replace="    /* mutation: no revert */",
        flows=("failed hide write reverts",),
        test=T_UI,
        expect="UI and server have diverged",
        guards="the screen shows shows as hidden while the server disagrees, so a "
               "reload silently undoes what the user just did - data loss, not "
               "just a missing message",
    ),
    Mutation(
        name="a failed single-show hide stops reverting",
        path="frontend/src/pages/Randomize.svelte",
        # The per-row eye toggle had its own fire-and-forget fetch for months
        # after the bulk paths gained the rollback - one shared revert helper
        # is not one shared guarantee, so this path gets its own row. The
        # mutant is type-valid on purpose (see row: half-filled identities -
        # a mutant that fails to compile audits the compiler).
        find="""    const failed = await writeHidden([item.id], targetHidden);
    if (failed.length) revertHidden(failed, !targetHidden, 1);""",
        replace="    void writeHidden([item.id], targetHidden); /* mutation: no single revert */",
        flows=("failed hide write reverts",),
        test=T_UI,
        expect="the eye toggle is the one hide path",
        guards="hiding one show from the list or pop-up looks applied, the server "
               "never saved it, and the next reload silently undoes it",
    ),
    Mutation(
        name="a failed library lookup goes back to being silent",
        path="frontend/src/stores/jellyfin.ts",
        find="  libraryStatus.set(failedChunks ? 'unreachable' : 'ok');",
        replace="  libraryStatus.set('ok'); /* mutation */",
        flows=("library unreachable visible",),
        test=T_UI,
        expect="the page said nothing",
        guards="a failed availability lookup renders exactly like a healthy library "
               "with nothing missing - the state a real outage was reported in, "
               "which cost four wrong theories and was never explained",
    ),
    Mutation(
        name="unaired series are looked up in the library again",
        path="frontend/src/stores/jellyfin.ts",
        find="  if (info.status) return info.status === 'NOT_YET_RELEASED';",
        replace="  if (info.status) return false; /* mutation */",
        flows=("unaired not looked up",),
        test=T_UI,
        expect="availability lookup(s) fired for a NOT_YET_RELEASED season",
        guards="every match on the default (unaired) season falls through to fuzzy "
               "titles against a library that cannot hold the show - measured 7/7 "
               "wrong, offering 'Firefly' for 'Firefly Wedding'",
    ),
    Mutation(
        name="Escape stops closing the trailer modal",
        path="frontend/src/components/AnimeGridTranslate.svelte",
        find="    if (modal && e.key === 'Escape' && !document.fullscreenElement) closeModal();",
        replace="    /* mutation: escape disabled */",
        flows=("trailer modal esc",),
        test=T_UI,
        expect="Escape did not close the trailer modal",
        guards="the only remaining exit is the backdrop, which is a thin strip on a "
               "phone - and the test that was meant to catch this used to fall back "
               "to a backdrop click and assert on that instead",
    ),
    Mutation(
        name="the trailer modal loses its close button",
        path="frontend/src/components/AnimeGridTranslate.svelte",
        find='        aria-label="Close trailer"',
        replace='        aria-label="Close trailer mutated"',
        flows=("trailer modal esc",),
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
        flows=("no-results message",),
        test=T_UI,
        expect="no-match search rendered nothing at all",
        guards="searching for a show that isn't in this season shows a blank page, "
               "which reads as a broken site rather than an empty result",
    ),
    Mutation(
        name="the stored theme stops covering the gap before /api/options answers",
        path="frontend/src/stores/options.ts",
        # The mirror exists for exactly this, and only the *guest* branch ever read
        # it - so a logged-in user's first paint used `defaultOptions` and the real
        # theme arrived when the fetch did. Measured as a 504 ms white flash with a
        # 300 ms server, i.e. it scales with latency.
        find="    if (mirrored) options.set(mirrored);",
        replace="    /* mutation: no synchronous seed */",
        flows=("theme survives signup",),
        test=T_UI,
        expect="painted the wrong theme before /api/options answered",
        guards="every dark-theme user gets a white flash on every page load, as "
               "long as the server takes any time at all to answer",
    ),
    Mutation(
        name="the server's options stop being written back to localStorage",
        path="frontend/src/stores/options.ts",
        # The other half. Without it the stored copy never reconciles with the
        # account, so it stays whatever was last written as a guest - and the guest
        # branch reads it on logout, which is what flipped the site's theme.
        find="      writeMirror(resolved);",
        replace="      /* mutation: mirror left stale */",
        flows=("theme survives signup",),
        test=T_UI,
        expect="the stored copy still disagrees with the account",
        guards="localStorage drifts from the account for good, the two disagree "
               "silently, and logging out flips the site to the stale value",
    ),
    Mutation(
        name="signing up discards the theme chosen as a guest",
        path="frontend/src/pages/SignUp.svelte",
        # A brand-new account has no preferences, so "the server wins" - right for a
        # login on a new device - hands the user defaults nobody picked, and the
        # stored copy then disagrees with the server permanently.
        find="        body: JSON.stringify(get(options))",
        replace="        body: JSON.stringify({}) /* mutation */",
        flows=("theme survives signup",),
        test=T_UI,
        expect="did not survive signing up",
        guards="anyone who sets up the site the way they like it before making an "
               "account has those choices thrown away the moment they sign up",
    ),
    Mutation(
        name="the Compare user dropdown falls back to svelte-select's wording",
        path="frontend/src/pages/Compare.svelte",
        # `noOptionsMessage="No users found"` sat here for a long time and is not
        # a prop of svelte-select 5 - the console said "created with unknown prop"
        # and the list rendered the library's own default "No options". The empty
        # state is a slot in v5.
        find='            <div class="empty" data-no-users-found>No users found</div>',
        replace='            <div class="empty">No options</div> <!-- mutation -->',
        flows=("guest options + compare warning",),
        test=T_UI,
        expect="fell back to svelte-select's default empty text",
        guards="a viewer searching for a teammate is told 'No options' by a "
               "library instead of being told no such user exists",
    ),
    Mutation(
        name="an explicit sidebar collapse stops being recorded",
        path="frontend/src/pages/Home.svelte",
        # The third door onto pass 1's full-screen-sidebar bug. `sidebarChoiceMade`
        # used to be inferred by diffing `sidebarCollapsed` in a reactive block
        # that runs before loadPrefs, so a stored value disagreeing with the width
        # default made the inference wrong and a dismissal was never persisted.
        # It is recorded at the click now.
        find="    sidebarChoiceMade = true;\n    savePrefs($userName);",
        replace="    savePrefs($userName); /* mutation: choice not recorded */",
        flows=("phone sidebar collapsed",),
        test=T_UI,
        expect="opening the sidebar was not recorded as a choice",
        guards="dismissing the full-screen sidebar on a phone stops sticking, so "
               "every load buries the grid again",
    ),
    Mutation(
        name="an oversized wheel image throws inside the update flush again",
        path="frontend/src/pages/Randomize.svelte",
        # The throw is the bug, not the lost image: it happens inside a Svelte
        # update flush, so the rest of the flush never runs and
        # `showImageUploadModal = false` stops reaching the DOM - Done, the X and
        # Escape all dead, whole viewport covered, until a reload.
        # Caught by the flow's message assertion (step 3). Its step-4 "the modal
        # must still close" check is defence for a partial fix - a catch that
        # rethrows, or one that guards only one of the two keys - and this mutant
        # never reaches it.
        find="""    try {
      if (value) sessionStorage.setItem(key, value);
      else sessionStorage.removeItem(key);
      return true;
    } catch (err) {
      console.warn(`[randomize] could not store ${key}:`, err);
      return false;
    }""",
        replace="""    if (value) sessionStorage.setItem(key, value);
    else sessionStorage.removeItem(key);
    return true; /* mutation: unguarded */""",
        flows=("wheel image quota",),
        test=T_UI,
        expect="an image too large to store failed silently",
        guards="picking a large photo silently keeps nothing, says nothing, and "
               "wedges the Randomize page behind a modal that no longer closes",
    ),
    Mutation(
        name="Escape stops closing the image upload modal",
        path="frontend/src/pages/Randomize.svelte",
        # It is a `<dialog open>`, not `showModal()`, so it has no native Escape
        # behaviour while its `.modal` backdrop still covers the viewport. Pass 1
        # fixed Escape on the trailer modal and the spin pop-up and missed this
        # third one entirely.
        find="  if (showImageUploadModal) {",
        replace="  if (showImageUploadModal && false) { /* mutation */",
        flows=("wheel image quota",),
        test=T_UI,
        expect="Escape did not close the image upload modal",
        guards="the one modal where being stuck matters most goes back to having "
               "exactly one way out, inconsistent with every other modal here",
    ),
    Mutation(
        name="an un-watched entry keeps its watchedRank",
        path=BACKEND_LIST,
        # Nothing else can clear it: the follow-up /rank PATCH filters on
        # `watched: true` and its `ids` array excludes the row just un-watched.
        # The stale value then wins the `watchedRank: null` guard on the next
        # re-watch. Pass 1 saw this state, failed to reproduce it, and withdrew
        # it as a harness artifact - it is reachable by one click.
        find="        watchedRank: isWatched ? undefined : null",
        replace="        watchedRank: undefined /* mutation */",
        test=T_SMOKE,
        expect="un-watching left watchedRank set on an unwatched row",
        guards="a re-watched show revives the rank it held last time instead of "
               "being appended, so `Add Watched to` is silently ignored and two "
               "entries can share a rank",
    ),
    Mutation(
        name="un-watching leaves a hole in the ranking",
        path=BACKEND_LIST,
        # The other half: clearing the rank is not enough, because the append
        # computes `watchedCount - 1`, which is only sound while the surviving
        # ranks are dense. Un-watch the row at 0 without compacting and the next
        # mark-watched collides with the survivor still holding 1.
        find="    if (updated.count > 0 && !isWatched) {",
        replace="    if (updated.count > 0 && !isWatched && false) { /* mutation */",
        test=T_SMOKE,
        expect="two watched entries share a watchedRank",
        guards="two watched rows hold one rank, after which the ranking "
               "sidebar's comparator returns 0 for the pair and falls back to "
               "pre-watch order - the user's chosen ranking, silently replaced",
    ),
    # The contributor guide is three files now: the root, plus a nested guide
    # per service that Claude Code loads only when the work touches that
    # directory. That bought every session ~8k tokens and created one new way
    # to be wrong - a section moved out with no pointer left behind, or a
    # pointer to a file nobody created - which nothing but this would catch.
    #
    # Three of `check_guide_pointers`' checks have NO row here, deliberately.
    # The size budget and the stub-ratio check are thresholds, and no small
    # find/replace can cross either (growing the root past 45,000 characters
    # would mean a ~7,000-character `replace`). The gitignore check needs an
    # edit to `.gitignore` itself, which is not the file the row would name.
    # All three were proven by simulation instead - lower the constant, paste
    # filler under a stub, or drop the `!.claude/rules/` negation, and watch
    # the check fire. Say so rather than leaving them looking merely forgotten.
    Mutation(
        name="a moved section loses its pointer in the root guide",
        path="CLAUDE.md",
        find="### Database schema",
        replace="### Database schema (mutation)",
        test=T_ANCHORS,
        expect="no pointer in the root",
        guards="a subsystem's documentation is unreachable from the guide every "
               "session reads - it still exists, but only someone who already "
               "knew where to look would ever find it",
        settle=0.0,
    ),
    Mutation(
        name="the root guide points at a nested guide that does not exist",
        path="CLAUDE.md",
        find="`tvshow.nfo` rather than folder names are all in **`backend/CLAUDE.md`**.",
        # The name must still end in `CLAUDE.md`: the checker only treats a
        # citation as a guide pointer when it matches that suffix, so an
        # earlier `backend/GONE.md` was simply not seen as a pointer at all.
        replace="`tvshow.nfo` rather than folder names are all in **`backend/GONE-CLAUDE.md`**.",
        test=T_ANCHORS,
        expect="which is not in the repo",
        guards="a pointer to a missing file reads as 'this is documented "
               "elsewhere' and sends the reader looking for something that was "
               "never written - worse than no pointer at all",
        settle=0.0,
    ),
    Mutation(
        name="a path-scoped rule loses the frontmatter that scopes it",
        path=".claude/rules/tools.md",
        find='paths:\n  - "tools/**/*"',
        # Must not contain the literal `paths:` - an earlier replacement read
        # "# paths: removed by mutation", which left the string the check looks
        # for sitting in the frontmatter, so the check passed and the row
        # scored as not-caught.
        replace="# scope removed by mutation",
        test=T_ANCHORS,
        expect="no `paths:` frontmatter",
        guards="the rule loads in every session instead of only under tools/, "
               "which is the exact cost the move existed to avoid - and it "
               "fails silently, because a rule that loads too often still works",
        settle=0.0,
    ),
    Mutation(
        name="YouTube English CC stops outranking our own segments",
        path=BACKEND_SUBS,
        # Drop the rung and a trailer YouTube already captions falls through to
        # `translated` - or, with no segments cached, all the way to
        # `checkedNoSubs`, i.e. into the backlog. 83 of this deployment's 423
        # tracked trailers have English CC, so the admin page would invent
        # roughly that much work and someone would go re-translating videos the
        # pipeline deliberately skips.
        find="  if (row.hasEnglishSubs) return 'youtubeCc';",
        replace="  /* mutation: CC no longer outranks our segments */",
        test=T_UNIT,
        expect="reports youtubeCc, not backlog",
        guards="trailers YouTube already captions are counted as untranslated "
               "work, which is the one misreading that costs GPU hours",
    ),
    Mutation(
        name="a row with no English-CC verdict claims to have been checked",
        path=BACKEND_SUBS,
        # `never` is about evidence, not about a row existing. `PATCH /dismiss`
        # upserts, so /admin/subtitles' own "turn our subs off" button creates a
        # row carrying nothing but that toggle - found by driving the real page,
        # not by any test. Without this rung it renders as "checked, no YouTube
        # CC", which claims a check nobody ran.
        find="  if (row.hasEnglishSubs === null || row.hasEnglishSubs === undefined) return 'never';",
        replace="  /* mutation: a row existing counts as having been checked */",
        test=T_UNIT,
        expect="has never been checked",
        guards="the page claims a trailer was checked for English captions when "
               "nothing ever checked it - and its own subs toggle is what "
               "manufactures those rows",
    ),

    # ---------------------------------------------------------------------
    # Account security. These guard the chain that made a public deployment
    # dangerous: reset the admin's password with one unauthenticated POST,
    # log in, then read the stored Jellyfin key back out through
    # PUT /api/jellyfin/config + POST /config/test. Every row below is a
    # refusal, so a survivor means something is being ALLOWED.
    # ---------------------------------------------------------------------
    Mutation(
        name="an admin with no email falls back to the open reset",
        path=BACKEND_AUTHCODES,
        # The branch that makes the deploy close the hole on its own. Without
        # it, nothing changes until somebody remembers to configure an address -
        # and if they never do, never.
        find="  if (user.isAdmin) return 'adminNoAddress';",
        replace="  /* mutation: admins fall through to the open reset */",
        test=T_UNIT,
        expect="fell back to the OPEN reset",
        guards="anyone on the internet can reset the admin password, log in, and "
               "exfiltrate the Jellyfin API key via /config/test",
    ),
    Mutation(
        name="the unauthenticated reset stops refusing protected accounts",
        path=BACKEND_AUTH_ROUTE,
        # The pure predicate is tested above; this is the endpoint actually
        # calling it. Both matter - a correct rule nobody consults is not a rule.
        find="  if (!mayResetOpenly(user)) {",
        replace="  if (!mayResetOpenly(user) && !!process.env.MUTATION_OFF) {",
        # `&& !!process.env.MUTATION_OFF` rather than `&& false`: rows aimed at
        # test_account_security compile the backend for real, and TypeScript
        # marks a statically-false branch unreachable - which DISCARDS the
        # narrowing from the `if (!target) return` above it, so the build fails
        # with "possibly null" instead of the guard being removed. A build
        # failure is not this invariant going unnoticed. An env var the
        # compiler cannot fold keeps narrowing and never fires at runtime.
        test=T_ACCTSEC,
        expect="anonymous request reset an ADMIN password",
        guards="the takeover hole is reopened at the endpoint even though the "
               "rule that forbids it is still correct",
    ),
    Mutation(
        name="requireAdmin stops reading the isAdmin column",
        path=BACKEND_MIDDLEWARE,
        # Admin-ness moved from an env id to a column. If this check degrades to
        # 'is authenticated', every admin route opens to every signed-up user -
        # and signup is open to the internet.
        find="  if (!req.user?.isAdmin) {",
        replace="  if (false) { /* mutation */",
        test=T_NEGATIVE,
        # Anchored on step 10, not on the later /api/admin/users check, because
        # step 10 fires FIRST and `fail()` exits - so the specific assertion
        # never ran and this row graded WRONG REASON. Step 10 is the better
        # anchor anyway: it sweeps the four `translate` routes converted from
        # inline id comparisons to this middleware, which is the half of that
        # change most likely to be wrong.
        expect="as non-admin: expected 403",
        guards="every admin route - Jellyfin config, Sonarr push, the user list, "
               "the translate batch and cache - is reachable by anyone who signs up",
    ),
    Mutation(
        name="the last admin can be demoted",
        path=BACKEND_ADMIN_USERS,
        # There is no root account by design (admins are peers), so this floor
        # is the only thing between a mis-click and an admin panel nobody can
        # open. The comment above the count is what makes this find unique - the
        # delete path below has a textually identical guard.
        find="        // Counted here, inside the transaction, against the live table.\n"
             "        const admins = await tx.user.count({ where: { isAdmin: true } });\n"
             "        if (admins <= 1) {",
        replace="        const admins = 99; /* mutation */\n        if (false) {",
        test=T_ACCTSEC,
        expect="the only admin was demoted",
        guards="the site is left with no admin at all, and no way back in short "
               "of editing the database by hand",
    ),
    Mutation(
        name="promotion no longer requires a verified email",
        path=BACKEND_ADMIN_USERS,
        # This is what makes "every admin is email-protected" true by
        # construction. Without it a promoted account can use neither the open
        # reset (admins are refused) nor the coded one (no address).
        find="        if (!target.emailVerifiedAt) {",
        replace="        if (!target.emailVerifiedAt && !!process.env.MUTATION_OFF) {",
        # `&& !!process.env.MUTATION_OFF` rather than `&& false`: rows aimed at
        # test_account_security compile the backend for real, and TypeScript
        # marks a statically-false branch unreachable - which DISCARDS the
        # narrowing from the `if (!target) return` above it, so the build fails
        # with "possibly null" instead of the guard being removed. A build
        # failure is not this invariant going unnoticed. An env var the
        # compiler cannot fold keeps narrowing and never fires at runtime.
        test=T_ACCTSEC,
        expect="was promoted to admin",
        guards="an admin is created who cannot recover their own account by any "
               "route, and only another admin can rescue them",
    ),
    Mutation(
        name="clearing an admin's email strands the account",
        path=BACKEND_ADMIN_USERS,
        # Four spaces, not six: the delete handler has a textually similar guard
        # one level deeper inside its transaction. Nothing here ever SETS a
        # credential - both admin actions clear one - so the only refusals worth
        # guarding are the two that would leave an account with no route back in.
        # Two-line: `if (target.isAdmin) {` appears twice in this file, and a
        # bare `str.replace` would mutate BOTH guards at once - passing for a
        # reason nobody chose. The second line pins the one this row is about.
        find="    if (target.isAdmin) {\n      return res.status(409).json({",
        replace="    if (target.isAdmin && !!process.env.MUTATION_OFF) {\n      return res.status(409).json({",
        # `&& !!process.env.MUTATION_OFF` rather than `&& false`: rows aimed at
        # test_account_security compile the backend for real, and TypeScript
        # marks a statically-false branch unreachable - which DISCARDS the
        # narrowing from the `if (!target) return` above it, so the build fails
        # with "possibly null" instead of the guard being removed. A build
        # failure is not this invariant going unnoticed. An env var the
        # compiler cannot fold keeps narrowing and never fires at runtime.
        test=T_ACCTSEC,
        expect="an admin's email was cleared",
        guards="an admin loses the address they recover through, and is blocked "
               "from the open reset as well, so the account cannot be entered again",
    ),
    Mutation(
        name="changing a password leaves other sessions alive",
        path=BACKEND_MIDDLEWARE,
        # Tokens live 7 days in localStorage and there is no revocation list, so
        # this comparison IS the logout. A missing `v` claim reads as 0 on
        # purpose - the five scripts in tools/ sign bare `{ id }` tokens.
        find="  if (payload.v !== undefined && payload.v !== user.tokenVersion) {",
        replace="  if (false) { /* mutation */",
        test=T_ACCTSEC,
        expect="minted before the password change still works",
        guards="resetting a compromised password does not evict the attacker - "
               "their token keeps working for up to a week",
    ),
    Mutation(
        name="a verification code is not bound to the address it was sent to",
        path=BACKEND_AUTH_ROUTE,
        # The address rides on the code row, never on the request. Untie them and
        # the code stops being evidence about any particular address: anyone could
        # have one mailed to an inbox they own and submit it alongside a different
        # address, stamping emailVerifiedAt on something nobody can read - the
        # typo-lockout verification exists to prevent. It also erases the pending
        # state, so closing the modal loses a half-finished change silently.
        find="      sentTo: bindTo ?? null,",
        replace="      sentTo: null, /* mutation */",
        test=T_ACCTSEC,
        expect="no pending address reported",
        guards="an address can be marked verified without anyone proving they can "
               "read it, which is how a typo becomes a permanent lockout",
    ),
    Mutation(
        name="reset codes never expire",
        path=BACKEND_AUTHCODES,
        find="  if (now.getTime() >= row.expiresAt.getTime()) return 'expired';",
        replace="  /* mutation: codes live forever */",
        test=T_UNIT,
        expect="was still accepted",
        guards="a code read over someone's shoulder, or left in an old email, "
               "works for ever instead of ten minutes",
    ),
    Mutation(
        name="wrong guesses are unlimited",
        path=BACKEND_AUTHCODES,
        # The number that makes six digits defensible at all: five attempts per
        # issued code, and three codes an hour. Remove the cap and the whole
        # million-value space is reachable against one code.
        find="  if (row.attempts >= MAX_ATTEMPTS) return 'exhausted';",
        replace="  /* mutation: guess as often as you like */",
        test=T_UNIT,
        expect="wrong-guess cap was still accepted",
        guards="a six-digit reset code is brute-forced against a single issued "
               "code instead of costing a fresh request every five guesses",
    ),
]


# Grouped by the file each row edits, so the audit stops bouncing between the
# backend and frontend dev servers - every switch back to a backend file costs a
# ts-node-dev restart. Enforced by sorting rather than by hand-ordering the list
# above, so adding a row in the wrong place cannot quietly undo it. Sorting by
# path also puts all `backend/` rows first, which is where the restarts are.
MUTATIONS.sort(key=lambda m: m.path)


def git(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=REPO, capture_output=True, text=True)


def dirty_paths() -> list[str]:
    """Repo-relative paths with uncommitted changes.

    Do NOT strip the output. Porcelain lines are `XY PATH`, and an unstaged
    modification is `" M path"` - a leading space. Stripping the whole blob
    removes it from the *first* line only, so `l[3:]` then eats a character of
    that path: `backend/...` became `ackend/...`, matched nothing, and the
    dirty-tree guard silently stopped protecting whichever file sorted first.
    That is not hypothetical - it reverted uncommitted work in
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

#: How many consecutive timeouts mean the backend is DEAD rather than slow.
#:
#: Each row waits twice - once after apply, once after revert - so a single
#: genuinely slow row produces two. Three means the next row is failing too,
#: which is no longer transient. Measured on the run that motivated this: the
#: backend died at row 34 and every backend row after it reported
#: `WRONG REASON: backend unreachable`, so the run spent ~20 more minutes
#: manufacturing ~50 coverage holes that did not exist. At 3 it stops two rows
#: in.
MAX_CONSECUTIVE_WEDGES = 3
_consecutive_wedges = 0
#: Set once the abort has been decided. `restore()` waits for the backend too,
#: and it runs from a `finally`, so without this the abort raises a SECOND time
#: from inside that finally - which replaces the original exception with a copy
#: of itself and waits another 90s on a server already known to be gone.
_aborting = False


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
    burns the whole timeout and proceeds anyway - which is how an audit run
    reported 7/14 with `test_jellyfin` exiting in one second against a backend
    that was not up.

    So this asks the question that actually matters - "is it serving?" - rather
    than a proxy for it. The grace period matters as much as the polling: without
    it we sample the *old* process, get a 200 immediately, and conclude all is
    well before the restart has even begun.
    """
    global _consecutive_wedges, _aborting
    # The abort is already in flight; cleanup still needs its `git checkout --`,
    # but not another 90s wait on a server we know is gone.
    if _aborting:
        return
    time.sleep(WATCHER_GRACE_S)
    deadline = time.time() + timeout
    healthy_in_a_row = 0
    while time.time() < deadline:
        healthy_in_a_row = healthy_in_a_row + 1 if _healthy() else 0
        if healthy_in_a_row >= STABLE_POLLS:
            _consecutive_wedges = 0
            return
        time.sleep(0.5)

    # One timeout does NOT abort: a backend that came back slowly is a finding
    # the row's own test reports far more usefully than a crash here would.
    _consecutive_wedges += 1
    print(f"      (warning: backend did not come back within {timeout:.0f}s "
          f"- the next result may be unreliable)", flush=True)

    # Several in a row is a different thing entirely - the server is gone, not
    # slow, and every remaining row would be graded against nothing. That run
    # does not produce weak evidence, it produces CONFIDENT WRONG evidence: a
    # wall of `WRONG REASON: backend unreachable` that reads like a coverage
    # catastrophe. Stopping is the honest outcome, and `finally` still restores
    # every mutated file on the way out.
    if _consecutive_wedges >= MAX_CONSECUTIVE_WEDGES:
        _aborting = True
        raise SystemExit(
            f"\nABORTING: the backend has not answered for "
            f"{_consecutive_wedges} consecutive waits (~"
            f"{_consecutive_wedges * timeout / 60:.0f} min).\n"
            f"It is down, not slow, so every remaining row would report "
            f"WRONG REASON against a dead server.\n"
            f"Mutated files are restored. Fix the backend "
            f"(`npm run dev` in backend/, check for a wedged ts-node-dev pair) "
            f"and re-run.")


#: Tests that read the mutated file off disk and compile it themselves, never
#: talking to :3000. `npm run test:unit` is node --test over the .test.ts files;
#: the replay is pure and makes zero HTTP calls (asserted: no requests import).
OFFLINE_TESTS = (T_UNIT, T_REPLAY, T_YTGUARD, T_VERDICT)


def _is_offline(m: Mutation) -> bool:
    return any(m.test is t for t in OFFLINE_TESTS)


#: Set when a backend file was written or reverted and nobody waited for
#: ts-node-dev to come back. The wait is not skipped, it is DEFERRED to the next
#: row whose test actually needs the server - which is what makes it safe.
#:
#: Measured: 30 of 74 rows run an offline test against a backend file, and each
#: was paying ~7 s (a wait after apply and another after revert) for a restart
#: nothing in that row would ever read - 3.4 min of a 47 min audit. Skipping the
#: wait outright would be the old bug back (a row testing against a backend
#: that is still booting), hence the flag rather than a plain early return.
_backend_pending = False


def settle_after_edit(m: Mutation) -> None:
    """Wait for whichever dev server this row's TEST is about to talk to."""
    global _backend_pending
    edits_backend = any(p.startswith("backend/") for p in m.paths)
    if _is_offline(m):
        # Nothing this row runs reads the dev server, so the restart it just
        # triggered is somebody else's problem - recorded, not waited on.
        if edits_backend:
            _backend_pending = True
        return
    if not m.settle:
        return
    # `_backend_pending` matters even for a frontend-only mutation: a UI flow
    # talks to :3000 whatever file the row edited, so an offline row's deferred
    # restart has to be collected here or it lands mid-test.
    if edits_backend or _backend_pending:
        wait_for_backend()
        _backend_pending = False
    else:
        # Vite HMR keeps the same process and reloads far quicker than a
        # ts-node-dev restart, so a short sleep is honest here.
        time.sleep(m.settle)


def restore(m: Mutation, wait: bool = True) -> None:
    """Put every file this mutation touched back. `wait` is False for cleanup.

    Mid-run the wait is load-bearing - it stops one row's revert bleeding into
    the next row's test. In the final sweep nothing runs afterwards, so waiting
    there only adds a settle per file to the end of every audit.
    """
    global _backend_pending
    git("checkout", "--", *m.paths)
    if not any(p.startswith("backend/") for p in m.paths):
        return
    if wait and m.settle and not _is_offline(m):
        wait_for_backend()
    else:
        _backend_pending = True


def _describe(m: Mutation) -> str:
    """What this row is actually running, short enough for the status bar.

    The heartbeat used to read `test running 100s...`, which answers neither
    question a reader has at that moment: what is taking 100 seconds, and is
    100 the elapsed time or a limit. A player row legitimately sits there for
    two minutes doing real transcodes; a UI flow at 100 s is stuck.
    """
    if m.test is T_UNIT:
        return "backend unit suite"
    if m.test is T_JELLYFIN:
        return "jellyfin, 13 live steps"
    if m.test is T_REPLAY:
        return "match replay (offline)"
    if m.test is T_NEGATIVE:
        return "api negative paths"
    if m.test is T_UI:
        return f"ui flow {m.flows[0]!r}" if m.flows else "ui, ALL flows (no `flows=` on this row)"
    if "test_player.py" in " ".join(m.test):
        steps = m.test[-1] if "--only-steps" in m.test else "all"
        return f"player, steps {steps} (real transcodes)"
    return Path(m.test[-1]).name


def run_test(m: Mutation, ctx: str = "") -> tuple[bool, str]:
    """True when the test PASSED (i.e. the mutation went unnoticed).

    The child's output is a diagnostic to scan afterwards, never progress to
    show - but a silent 110s child is a frozen status line (the status bar
    shows the last line of output, and a UI-suite row prints nothing for two
    minutes). So the child writes to a temp file and a heartbeat ticks here,
    carrying the row context because a bare "still running" is meaningless as
    the one visible line.
    """
    cwd = REPO / "backend" if m.test is T_UNIT else REPO
    cmd = list(m.test)
    if m.flows:
        cmd += ["--only-flows", ",".join(m.flows)]
    what = _describe(m)
    shell = sys.platform == "win32" and m.test[0] in ("npm", "npx")
    with tempfile.TemporaryFile(mode="w+", encoding="utf-8", errors="replace") as sink:
        p = subprocess.Popen(cmd, cwd=cwd, stdout=sink, stderr=subprocess.STDOUT,
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
                say(f"{ctx} {what} - {elapsed:.0f}s elapsed")
        sink.seek(0)
        return rc == 0, sink.read()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="run selected mutations by number: 3, or 3,7,12")
    ap.add_argument("--list", action="store_true", help="show the table and exit")
    args = ap.parse_args()

    if args.list:
        for i, m in enumerate(MUTATIONS, 1):
            say(f"{i:>2}. {m.name}\n     guards: {m.guards}")
        return 0

    # A mutation is reverted with `git checkout --`, which would also throw away
    # uncommitted work in the same file. Refuse rather than risk it.
    #
    # A LIST, not one number: the documented workflow is "--only N for the
    # affected rows" after touching code a row anchors to, and a change that
    # lands across several modules affects dozens. One row per invocation meant
    # re-warming the season cache and re-checking the tree for each, so the
    # practical choice became "one row or all of them". Validate before indexing -
    # the single-int version raised IndexError on an out-of-range number
    # before its own bounds check ran.
    chosen = MUTATIONS
    # The row NUMBERS behind `chosen`, so a partial run can still say which row
    # it is on. `--only` used to be printed verbatim in place of the number,
    # which was fine while it took one value and turned every progress line of
    # a multi-row run into `[1,2,3,4,55,61,.../74]` - unreadable in the one-line
    # status bar those labels exist for.
    chosen_nums = list(range(1, len(MUTATIONS) + 1))
    if args.only:
        try:
            idxs = [int(x) for x in args.only.split(",") if x.strip()]
        except ValueError:
            say("--only takes numbers: 3, or 3,7,12")
            return 2
        bad = [i for i in idxs if not (1 <= i <= len(MUTATIONS))]
        if bad or not idxs:
            say(f"--only must be 1..{len(MUTATIONS)} (got {bad or 'nothing'})")
            return 2
        chosen = [MUTATIONS[i - 1] for i in idxs]
        chosen_nums = idxs

    # Only the files this run will actually revert. Checking every row's target
    # blocked `--only 9` because some unrelated file had edits in it, which is a
    # guard being unhelpful rather than safe.
    dirty = dirty_paths()
    targets = {p for m in chosen for p in m.paths}
    clash = sorted(targets & set(dirty))
    if clash:
        say("Refusing to run: these files have uncommitted changes and would be "
            "reverted by this audit -")
        for c in clash:
            say(f"   {c}")
        say("\nCommit or stash them first.")
        return 2

    say(f"Mutation audit - {len(chosen)} mutation(s), each must be CAUGHT by its test")
    say("Servers must be running, same as the suite this audits.\n")

    # The run times itself so nobody has to estimate. Both docs carried a
    # figure for years - ~35 min in CLAUDE.md, ~118 min in the tests README -
    # and neither had ever been measured; one was true at 18 rows and the other
    # was arithmetic. A number a tool prints about itself cannot go stale.
    run_started = time.time()
    survived: list[str] = []
    # Warm before touching anything. The audit restarts the backend twice per
    # row, and a stale season key would re-fetch on the first request after each
    # restart - dozens of cold AniList fetches across a run, which is what kept
    # tripping the 30/min limit and made rows fail for reasons unrelated to the
    # invariant they were testing.
    #
    # INVARIANT: the audit's whole runtime must fit inside the season-cache TTL
    # (6 h, routes/anime.ts), because this warm happens ONCE. The runtime grows
    # every time a row is added, and this assumption has already broken
    # silently: 18 rows (~35 min) fit the old 1 h TTL, 57 rows (~90 min) did
    # not, and the last half hour of that run fired a stale background refresh
    # per restart into AniList's shared ~30/min budget - nothing failed, the
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
        for pos, (n, m) in enumerate(zip(chosen_nums, chosen), 1):
            # Every line below carries this: the status bar shows exactly one
            # line, and "caught in 112s" with no row number tells a reader
            # nothing about where the run is. A partial run needs both - which
            # row this is, and how far through the selection.
            ctx = (f"[{n}/{len(MUTATIONS)}]" if len(chosen) == len(MUTATIONS)
                   else f"[{n}/{len(MUTATIONS)} - {pos} of {len(chosen)}]")
            say(f"{ctx} {m.name}")
            if not apply(m):
                say(f"      {ctx} SKIP - anchor text not found; the code moved, update this row\n")
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
                say(f"      {ctx} SURVIVED in {took:.0f}s - nothing caught it")
                say(f"      would ship: {m.guards}\n")
                survived.append(m.name)
            elif m.expect and m.expect.lower() not in out.lower():
                # Red is not the same as covered, and conflating the two is the
                # exact mistake this audit exists to catch: a leaked credential
                # once turned a test red with the message "video never advanced"
                # - a real failure pointing at the wrong subsystem, which nobody
                # would have traced back. If no assertion names this invariant,
                # it is still a hole, however red the run looks.
                why = next((l for l in out.splitlines() if "FAIL" in l), "").strip()
                # Distinguish "the test asserted something else" from "the test
                # never got to assert at all". Both used to print
                # `(no FAIL line)`, which reads like a coverage hole and hides a
                # broken harness - five player rows were reported as holes for a
                # week because `--only-steps` skipped a step they depended on and
                # the run died on an UnboundLocalError.
                if not why and "Traceback (most recent call last)" in out:
                    crash = next((l.strip() for l in reversed(out.splitlines())
                                  if l.strip() and not l.startswith((" ", "\t"))), "")
                    why = f"CRASHED before asserting - {crash[:100]}"
                say(f"      {ctx} WRONG REASON in {took:.0f}s - red, but not because of "
                    f"this invariant")
                say(f"      expected to see: {m.expect!r}")
                say(f"      actually failed: {why[:140] or '(no FAIL line)'}")
                say(f"      still unguarded: {m.guards}\n")
                survived.append(f"{m.name}  [red for an unrelated reason]")
            else:
                hit = next((l for l in out.splitlines()
                            if m.expect.lower() in l.lower()), "").strip()
                say(f"      {ctx} caught in {took:.0f}s - {hit[:130]}\n")
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
    mins = (time.time() - run_started) / 60
    say(f"Done: {total - len(survived)}/{total} caught"
        + (f", {len(skipped)} skipped" if skipped else "")
        + f" - {len(chosen)} row(s) in {mins:.0f} min"
        + (" (full run)" if len(chosen) == len(MUTATIONS) else ""))
    if len(chosen) == len(MUTATIONS):
        # The only figure either doc should quote, and it re-measures itself
        # every time - see the note at run_started.
        say(f"   Quote this for a full audit: {len(chosen)} rows, {mins:.0f} min, "
            f"measured {datetime.date.today().isoformat()}.")
    for s in survived:
        say(f"   COVERAGE HOLE: {s}")
    return 1 if survived else 0


if __name__ == "__main__":
    sys.exit(main())
