---
name: testing
description: Running SaltyChart's test suites - the pre-deploy gate (run_all.py), the mutation audit, AniList rate-limit rules while testing, what each test file covers, and how to write a mutation row worth its cost. Load before running or changing any test.
---

# Testing SaltyChart

The prohibitions that must hold whether or not this file is loaded are in the
root `CLAUDE.md`; everything below is the detail behind them.

### Is the suite load-bearing? `tools/tests/mutation_audit.py`

A passing suite says nothing about what it would *catch*. This breaks one
invariant at a time and checks that the test guarding it actually fails:

```bash
py -3.13 -u tools/tests/mutation_audit.py           # every mutation
py -3.13 -u tools/tests/mutation_audit.py --only 3  # one, while iterating
py -3.13 -u tools/tests/mutation_audit.py --list    # the table
```

**Not** part of `run_all.py` - it edits tracked source and is slow. It refuses
to start on a dirty tree (it reverts with `git checkout --`, which would
otherwise eat uncommitted work) and restores everything in a `finally`. A row
may edit several files (`extra`), because a guard can legitimately live at more
than one layer; all of them are reverted.

What it established, each the hard way:

- **Red is not the same as covered.** Its first version counted any failing test
  as a catch and reported 10/10 - while four mutations were failing at an
  unrelated step and one had no assertion guarding it at all. Every row now
  declares the substring its failure output must contain; a red run that doesn't
  name the invariant is `WRONG REASON` and counted as a hole.
- **Red for the right *words* is still not enough.** Row 7 once "caught" its
  mutation with `only 0 of 12 sampled frames changed` - which is exactly what
  the *unmutated* build produced, because step 8 was broken. A row is only
  meaningful if the test is also known to **pass on clean code**; verify both
  directions when adding or repairing one.
- **Two real holes existed.** The Jellyfin API key stopped being stripped from
  the URL handed to browsers (`test_jellyfin` passed 10/10), and the
  AniList->TVDB match tier was disabled so every match silently fell back to
  fuzzy titles (10/10 again). Both are failure classes that have already
  happened in this repo.
- **A mutant must type-check, or it audits the compiler.** `if (false &&
  library)` narrows `library` to `null` inside the dead block, ts-node refuses
  to compile the file (TS18047), and node --test reports the whole test file as
  `ERR_TEST_FAILURE` without running one assertion - red, wrong reason, and the
  guard itself never exercised. The fix was a mutant that compiles clean
  (`tvdbId = tvdbId ?? null`) and was watched to fail naming its invariant.
- **A test that infers "not applicable" from the screen will skip exactly when
  it matters.** The library-unreachable flow decided "Jellyfin isn't
  configured" from an empty DOM (no status chip, no Hide button) and skipped -
  but a slow or broken render on a *configured* backend looks identical, so the
  full-audit run watched its mutation survive while the 55 other rows caught.
  Skip decisions now ask `/api/jellyfin/status` directly; only the backend can
  say which kind of nothing the page is showing - the same lesson `unknown`
  availability already taught, one layer up.
- **Six of fourteen rows once audited nothing.** `--only-steps` was added to cut
  transcode cost and quietly hollowed out what it was optimising: steps other
  steps depend on sat inside `want()` blocks, so selecting a later step skipped
  its setup and the run died before asserting. Anything a later step needs must
  be on the unconditional path. A crash is now reported as `CRASHED before
  asserting - <exception>` rather than the ambiguous `(no FAIL line)`, which is
  the difference between "unguarded invariant" and "broken harness".
- **The dirty-tree guard was itself broken for a while.** `dirty_paths()`
  stripped the whole `git status --porcelain` output, which removes the leading
  space from the *first* line only - so `l[3:]` ate a character of that path and
  it matched nothing. Whichever file sorted first was silently unprotected, and
  it reverted uncommitted work in `jellyfin.ts`. Don't strip porcelain output.
- **Settling is health, not a sleep or a PID.** Editing a backend file restarts
  ts-node-dev and so does reverting it. A fixed sleep raced it; watching for a
  new PID was worse, because a revert landing mid-restart is folded into the
  same cycle and the PID never changes again. It now waits for consecutive
  healthy `/api/health` replies after a grace period.

- **An audit run can leave the dev backend serving a mutated build after the file
  is reverted.** Seen right after a 6-row run: `list.ts` was clean in git and on
  disk, both fixes present, `/api/health` 200 - and `test_api_smoke` still failed
  step 14 with the *pre-fix* behaviour. ts-node-dev had restarted 12 times and
  settled on a stale compile. Touching the file to force one more reload fixed it
  and the test went green with no source change. So when a test fails immediately
  after an audit, **check the process before believing the diff**: the same
  stale-backend shape the drain scripts produce.

**Add a row whenever you add a test.** A test nobody has watched fail is a test
nobody should trust - and one that has only been watched to fail, never to pass,
is barely better.

**Writing a row that is worth its cost.** The rule above says nothing about
price, so one session took the table from 58 rows to 73 by adding every row at
whatever layer its test happened to live. What that cost, and what to do about
it:

A row costs what its **mutant** run costs, which is not what the test costs
normally - and the two differ in opposite directions depending on the test.
`test_jellyfin` and `test_player` call `fail()`, which `sys.exit(1)`s at the
guarded step, so a caught row pays only as far as its own assertion.
`test_ui_interactions` catches per flow and **runs all 27 regardless**, so an
un-narrowed UI row pays the whole suite every time. That asymmetry, not the
nominal cost of each test, is why narrowing mattered enormously for UI rows and
not at all for Jellyfin ones. Measured per row on a full audit:

| test | per row (mutant run) | note |
|---|---|---|
| `T_UNIT` / `T_REPLAY` | ~2-6 s | offline - compiles the file itself, never waits on a dev server |
| `T_JELLYFIN` | ~13 s | exits at the guarded step; a *clean* 13-step run is 60-90 s |
| `T_UI` with `flows=(...)` | ~3-37 s | one self-sufficient flow - the only way to write a UI row |
| `T_NEGATIVE` | ~10-30 s | |
| `T_UI`, no `flows` | **~142 s** | all 27 flows; nothing stops early. No row does this any more |
| `player(...)` | minutes | real transcodes; keep the step list narrow |

- **Pin the invariant at the cheapest layer that can see it.** `classifyMatch`'s
  film rule is a unit row; the same rule at the route is a 90 s one. Guarding
  both needs a reason beyond "a guard can live at more than one layer".
- **Name the flow on a `T_UI` row** (`flows=("remote accept visible",)`). Only
  labels in that file's `SELECTABLE_FLOWS` are allowed, because a flow that
  inherits state from its predecessors passes alone while proving nothing.
  All 31 UI rows now name one; the un-narrowed default remains only so that
  forgetting is slow rather than wrong.
- **An inherited precondition is a bug in the flow, not a reason to keep it off
  the allowlist.** `phone sidebar collapsed` was the standing counter-example -
  green in isolation *with its mutation applied*, because the second half of the
  bug needs a desktop-width visit and it was relying on the desktop flows
  happening to run first. Giving it that visit of its own took its two rows from
  142 s each to 4 s and made the dependency explicit instead of ordinal. Ask
  which the flow is before excluding it.
- **`expect` must be producible by exactly one assertion in that test.** Three
  rows once shared `override did not change the verdict`, which the Jellyfin
  test prints from three different checks - any of them would have scored a
  catch. `test_audit_anchors.py` now fails on an ambiguous one.
- **Mutate the guard, not the feature.** The candidate-merge row first disabled
  merging outright; the mutation worth having is the *dangerous* direction
  (merge on title), because that is what the test forbids.
- **A mutant can survive because the fixture never reaches it.** The merge test
  passed an empty map and hit an early return, so the mutation sailed through
  green. Check the fixture actually exercises the line you changed.
- **A mutant can fail on the wrong assertion.** The unheld-film row failed on a
  happy-path check until its cases were reordered specific-first - red, and
  proving nothing about the guard.

A duplicate `expect` between two rows is a smell, not a verdict: two rows that
mutate *different* code and are caught by one detector are both pulling their
weight (the notify half and the persist half of the identity cache-bust). The
problem is a string so generic that the wrong assertion can satisfy it.

### How often to run what

| when | what | cost |
|---|---|---|
| every push to master | `run_all.py --skip-burned-in` | ~4 min |
| after touching `tools/tests/`, or the code a row anchors to | `mutation_audit.py --only N` for the affected rows | 1-3 min |
| monthly, or before a large release | full `mutation_audit.py` | the run prints its own time - see below |
| before subtitle work, when the GPU is free | `run_all.py` *with* burned-in | + GPU time |
| before a release, or after reworking Home/Randomize/Compare or a modal | an exploratory pass - `tools/tests/EXPLORATORY.md` | ~1 h, an agent in a browser |

The exploratory pass is the one that is **not** a script. Everything above
asserts a mechanism in isolation from a clean load, which is why the first pass
found a phone layout that hides the entire grid behind the My List panel, an
Escape key that closes nothing, and a "Server busy" message written for a human
that only ever reached the console. Its findings log doubles as the record of
what has already been looked at; anything it finds twice belongs in `run_all.py`
with a mutation row.

`run_all.py` is the deploy gate: push to master builds and ships, so it runs
every time. **That is a statement about pushes, not about work sessions - do
not run it as an end-of-task ritual.** A change is verified by its own
targeted tests plus the cheap static battery (tsc, frontend build,
svelte-check, `npm run test:unit`, `test_audit_anchors.py`); the full suite
runs once, immediately before a push. It takes ~15 minutes and `test_player`
starts real transcodes on the box that also serves Plex and Jellyfin - an
agent ran it three times in one evening during which nothing was deployed,
which is exactly the load this schedule exists to avoid. The audit is **not** a gate - it edits tracked source, restarts the
backend twice per row (86 rows) and starts real transcodes, which is not
something to do casually on a box that also serves Plex and Jellyfin. **It
times itself**: a full run ends with `N rows, M min, measured <date>`, and that
line is the only figure worth quoting. Last measured: **74 rows in 19 min**
(2026-08-05), down from 47 min at 73 rows on the same box the same night. The
table is at 86 rows now, so that 19 min is a floor rather than a measurement -
re-time it instead of quoting it.
Where those 28 minutes went, all of it measured rather than estimated:

| change | saved |
|---|---|
| the last 12 UI rows narrowed to one flow (142 s each to 3-37 s) | ~21 min |
| `phone sidebar collapsed` made self-sufficient, so its 2 rows narrow too | ~4.5 min |
| offline rows (unit + replay) no longer wait on a backend they never call | ~3.4 min |
| two `wait_for_timeout` sleeps replaced by condition polls | ~30 s |

Two hand-written estimates lived here
for months - ~35 min (true at 18 rows) and ~118 min (arithmetic, never a
stopwatch) - which is the "quoted a measurement in prose" rot this file warns
about, committed in this file. Measured on a full audit:
Jellyfin peaked at 314% CPU (ffmpeg, three cores) and the host at 45% of twelve.

The trigger for the audit is not a calendar, it is **"I changed a test, or the
code a row points at"** - that is exactly when a row rots, and `--only N` makes
checking one cheap. `test_audit_anchors.py` covers the rot that is detectable
without running anything, on every push; a real audit is still the only way to
find a row whose test has become vacuous.

**(!) AniList rate limit while testing.** Requests are **anonymous, so the limit
is per IP** - AniList documents 90 req/min but has been **degraded to 30** for a
long time, and the whole home network shares one public IP. There is no API key
to raise it; only an OAuth token would give a per-user budget, and nothing here
has one. Three facts from their docs that the code now depends on:

- `X-RateLimit-Limit` / `X-RateLimit-Remaining` come back on **every** response,
  not just 429s. That is the real budget, and it is what pacing decisions read.
- `Retry-After` (seconds) and `X-RateLimit-Reset` (Unix seconds) come back **on
  a 429**.
- Exceeding the limit earns a **one-minute timeout**. There is also a separate,
  undocumented **burst limiter**.

**The biggest cost by far was never the request cadence - it was that one
refresh cost 100 requests instead of 3.** `Page.pageInfo` does not describe the
*filtered* result set for this query. Measured against the live API for SPRING
2026, which really holds ~113 entries:

```
pageInfo: { total: 5000, lastPage: 100, hasNextPage: true, perPage: 50 }
media returned on page 1: 50
```

`fetchSeasonFromAniList` read `lastPage` and fetched **100 pages per season key
per refresh**, about 97 of them empty. Six cache keys is ~600 requests against a
shared 30/min budget, so a single honest "warm once at the start" could not
finish inside the limit, and a mutation audit logged **219 live 429s**. Every
earlier fix here - the TTL, the per-key cooldowns, the budget floor, persisting
the cache across restarts - was tuning the frequency of an operation that was
33x too expensive, which is why none of them ever ended the storm.

Paging now stops on a **short page** (fewer items than `perPage`), the only
signal that tracks the filtered set, with a 20-page cap so a wrong answer
upstream can never do this again. `hasNextPage` is deliberately not consulted:
it is true on page 1 of a 3-page season and stays true. **Don't reintroduce a
count-based stop condition without re-measuring `pageInfo` first.**

It stayed invisible for weeks because the log line said only `AniList 429
(attempt 1/2), waiting 60s`. Naming the key and page in that line
(`AniList 429 for SPRING-2026 p52`) made it obvious immediately - a season with
three pages has no page 52. **A progress line that can't identify what it is
about is not a progress line.**

**The bug that cost the most before that was retrying too soon, not asking too
often.** The backoff used to wait `15s * attempt` when a 429 carried no headers,
so all three attempts landed *inside* the 60 s lockout: the request spent 90 s
failing and returned an error anyway. A cold season load was measured hanging
over three minutes on a window that showed 13 of 30 requests still available.

Restarts are **not** the driver, and blaming them sent one session down the
wrong path. The season data persists in SQLite and the per-key cooldowns persist
in `AppConfig`, so a restart costs a SQLite read and nothing upstream. What
actually sets the floor is arithmetic: a stale row is due for revalidation on
every request, `markFailed` holds it off for `DEFAULT_LOCKOUT_MS` (60 s), so
**each stale key re-attempts once a minute for the whole run** regardless of how
many times the process restarted. Five stale keys across a 19-minute audit is
~95 refresh attempts. The budget floor cannot save you either:
`BUDGET_FRESH_MS` is 60 s, so any reading older than a minute is treated as "the
window rolled over, go ahead" - which is exactly the state each expired cooldown
lands in.

Rules of thumb:
- **Warm before a run, and *wait* for it.** `tools/tests/warm_cache.py` fetches
  the previous, current and next season in both format variants; `run_all.py`
  and `mutation_audit.py` both call it before their first test. A test run must
  never provoke a live AniList 429 - the 429/backoff logic is unit-tested
  (`anilistRateLimit`), off the network. warm_cache **retries rather than
  shrugging** - honouring `Retry-After`, up to `PER_KEY_BUDGET_S` (8 min) per
  key - and if a key still can't be fetched, **both runners refuse to start**.
  That is deliberate: a missing season doesn't make the suite fail, it makes it
  *pass vacuously*, because every fixture joins against an empty list and every
  assertion is trivially satisfied. That has already happened here once, when
  hardcoded fixture mediaIds aged out of the season and every seeded list
  silently matched nothing.
- **Warming reads `SeasonCache.updatedAt` from SQLite, and it has to.** The API
  cannot answer "is this fresh": `/api/anime` serves an expired row *instantly*
  while revalidating behind it, so a 200 in 40 ms means a row exists, not that
  it is warm. warm_cache used to time the response and call anything under
  0.5 s "already warm" - it reported six keys warm while two were 27 h past a
  6 h TTL, which is how a run that had supposedly warmed still spent its whole
  length refreshing.
- **Warming asks the backend's TTL question, not a stricter one.** A first
  attempt demanded every key stay fresh for the entire run (`age + headroom <
  TTL`). Nothing can deliver that: there is no force-refresh path on the route,
  and a row inside the TTL is never refreshed however often you GET it. Warming
  sat waiting 8 minutes for an event that could not happen. It now refreshes
  what the backend considers expired and merely *reports* a key that will
  expire mid-run, which since the paging fix costs one 3-request refresh.
- Don't wipe `SeasonCache` more than once or twice per hour.
- When a season request suddenly takes minutes, check the backend console for
  `AniList 429` lines before suspecting the code - each one names the wait and
  which header produced it. `curl -i` the endpoint and read `X-RateLimit-Remaining`
  rather than guessing.
- Remember `format=TV` is a **separate cache key** from no-format, so Home's
  leftovers call and its main call are two independent fetches per season.
- Controls in place, all of which survive a restart because restarts are what
  generate the load:
  - **Backoff that matches the lockout** (`lib/anilistRateLimit.ts`, unit
    tested): `Retry-After` first, `X-RateLimit-Reset` second with a floor so a
    past timestamp can't cause an instant retry, otherwise a flat 60 s. Attempts
    are capped at **2** - waits are a full window each now, so attempts multiply
    directly into how long a request hangs. Raising that cap without redoing the
    arithmetic re-creates the original bug.
  - **Budget-aware background refresh** - `AppConfig.anilistRateLimit` holds the
    last observed `remaining`; below a floor of 8, optional refreshes stand down.
    A stale row is already being served, so standing down costs a viewer nothing.
  - **Per-key failure cooldown** - `AppConfig.anilistBackoff` maps a season key
    to the time it may next be asked about. Without it a failed refresh re-fired
    on the very next request and on every restart, which is what turned one 429
    into a storm. A blocking fetch inside a cooldown returns `503 UPSTREAM_ERROR`
    immediately instead of holding the connection open.
  - Cold fetches coalesced per season; expired rows served stale while
    refreshing in the background.
- The TTL is a flat **6 hours**, bounded on both sides. Pinning a finished
  season for *days* on the grounds that it "cannot change" is a guess about
  AniList's data that is not ours to make - entries do get added and corrected
  after a season ends. But the original flat *hour* set the background-refresh
  frequency that fed every 429 storm here: the mutation audit grew from 18
  rows (~35 min, inside 1 h) to 57 (~90 min, outside it), and its last half
  hour re-fired a stale refresh on each of its ~114 backend restarts.
  Serve-stale means the TTL adds no viewer latency at any value - it only
  sets how often AniList gets asked - so 6 h buys ~6x less upstream traffic
  for one visible cost: a newly added show takes up to ~6 h to appear.
- **Nothing in the frontend may call `graphql.anilist.co`.** A request the
  backend never sees is invisible to every control above, so none of them apply
  to it. `stores/season.ts` used to export `getCurrentSeasonFromAPI()`, which
  did exactly that; it had no callers and a comment asking people not to wire it
  up, and it was deleted, because an unused hazard plus a warning is a weaker
  safeguard than no hazard. Route any future need through `/api/anime`;
  `computeInitialSeason()` derives the season from the browser clock with no
  network at all.

Suite includes:
| File | Covers |
|---|---|
| `test_season_lookahead.py` | 50-day next-season cutover logic (`LOOKAHEAD_DAYS`; regression for the "X days till" bug, and for the 76->50 move itself) |
| `test_api_smoke.py` | 14 happy-path API steps: health, auth, list CRUD (PUT/GET/watched/hidden/rank), anime + cache hit, public-list endpoints, options round-trip, /api/users, and that un-watching clears `watchedRank` so a re-watch appends rather than reviving it |
| `test_api_negative.py` | 11 negative paths: signup missing/dup, password reset round-trip, missing/malformed JWT, validation errors, /translate/check shape, admin endpoint auth gates, and a **correctly signed JWT carrying no `id`** - which used to hang the request forever instead of returning 401, so the short timeout *is* the assertion |
| `test_frontend_smoke.py` | 5 frontend routes render (Playwright) including auth-gated pages |
| `test_ui_interactions.py` | 27 flows: nine button-click smoke (login -> modal Escape), then one guard per silent-failure class found by the audits and exploratory passes - Compare ranks checked against seeded orders, no API key in /admin's DOM, `unknown`/`notAired` never hide, share-image has real content, per-section progressive loading, a visible unreachable-library / hung-backend / failed-hide-rollback, the /admin/matching resolver-accept + match-dropdown + Run-sweep-button contract, check-batch chunking, in-band translation errors, the phone sidebar default (and that a dismissal of it is remembered), guest options, an oversized wheel image warning instead of wedging the page, a theme choice surviving signup with no wrong-theme first paint, the viewer's library picker (its write stubbed - a real pick rewrites identity for everyone). Seeds from live season data. Every flow's history and the trap it was watched to fail on: the file's docstring |
| `test_subtitle_paths.py` | Subtitle Paths B/C/D - YouTube CC, Whisper overlay, CC toggle persistence |
| `test_burned_in_detection.py` | Whisper large-v3 + OCR burned-in detection (Eren=yes, Sparks=no) - needs GPU |
| `test_match_replay.py` | Replays the shipping `matchSeries` (community-map ids only) over a frozen 8-season corpus - 945 real AniList entries x a 2,271-series library snapshot - and diffs every verdict against a committed baseline, in seconds with no network. Twelve real false positives asserted by name, and a named assertion matching no corpus entry is itself a failure. Fixtures are gitignored (they inventory the media library; this repo is public), so the test SKIPs where they haven't been built. Scope, privacy, and the re-baseline procedure: the file's docstring |
| `test_jellyfin.py` | 13 steps: auth/admin gates, `?token=` paths, availability shape, stream proxy + manifest credential-leak assertion, subtitle fetch and caching headers, no credential in `transcodingUrl`, at least one `matchedBy == "id"` (the id tier proven alive), a two-path round trip through the override table (an unheld id AND an outright rejection both flip a show to unavailable, invalidation proven in the persisted blob), films never falling through to series titles, Confirm keeping provenance, the admin lookup returning named, cross-walked, natively-TVDB picks, and a viewer pick that corrects a match but is refused (409) over an admin's decision. Live steps auto-skip when Jellyfin is unconfigured; cleanup always in a `finally`. Step-by-step history: the file's docstring |
| `test_player.py` | 10 steps driving the real player: pre-warm without an early stream, playback advances, one subtitle menu with a plain-English default, `[`/`]` speed steps with the bar hidden, burned-in subtitles verified in the pixels, 480p in exactly one restart, Escape stopping the transcode. Steps 1/2/3/5 are unconditional setup, step 8 reloads before the subtitles-off pass, step 9 stubs an `AbortError` - why each rule exists is in the file's docstring. Auto-skips when Jellyfin is unconfigured or nothing in the season is in the library |
| `backend npm run test:unit` | Pure helpers via `node --test`: `jellyfinApi` (a logged axios error never carries the API key; the auth header's `DeviceId`; the ESM SDK loads under CommonJS; the typed `DeviceProfile` is byte-identical to the hand-written one), `remoteIdentity` (the acceptance ladder and `pickCandidate` against the real measured pairs, `baseTitles` ordering, defensive premiere parsing, the miss-retry tiers incl. the >2y retirement, `retryStateFor`'s cooldown flip, `planSweep`'s cap/cooldown/retired selection incl. the drain override), `seriesIdentity` (the precedence ladder, `needsRemoteLookup`, and `needsRegrade` - stale-by-version, never a human decision, self-terminating; `isDateVerified`'s rung list), `skyhookIdentity` (`titleRelated` floors, season-premiere-only verification, undated-future-season, degrade-to-empty), the cross-provider candidate merge (id reference only - the title-merge mutant was watched to fuse two of Echo's three films), `episodeMatch`, `jellyfinFilmIndex` (the coalescing raced and was watched to fail), `animeMatch` (Unicode guards, positive-only guessed ids, the removed contains-tier's four pairs, `classifyMatch`'s four-way partition incl. the unheld-film category error), `libraryPick` (the viewer picker's ranking, and that an id-less library item is never offered), `anilistRateLimit` (the 60 s lockout arithmetic - the headerless rung was watched to fail at 15 s). Every assertion's story is commented at the assertion in its `.test.ts` |
| `test_rate_limits.py` | Every limiter carries `skip: () => _isDev`, so **not one is exercised** by anything else here - a limiter set to `max: 1` would lock everyone out and the suite would stay green. Boots a second backend in production mode on :3999 with its own throwaway SQLite file (two backends on one DB caused real lock contention mid-suite), exceeds 20/min on `/api/auth/login`, and asserts `429` + `{ code: 'RATE_LIMITED' }` + `RateLimit-*` headers |
| `test_audit_anchors.py` | Two doc-rot checks, both cheap enough to run on every push. (1) **`EXPLORATORY.md` cites nothing dead** - every referenced file exists, and no `file.ext:NN` line references, which move silently (one did, within an hour of being written). It cannot check the prose, so a pass here does not mean the charter is accurate - see the doc-sync rule above. (2) Every `mutation_audit.py` row still matches its source. A row whose anchor text has moved reports `SKIP`, which is easy to lose in a 35-minute audit and means that invariant is silently unaudited - batching the availability lookups moved the `unknown`-never-hides guard into another file and its row went on pointing at code that no longer existed. Runs in ~1.5 s with no servers, so it sits on every push instead of waiting for the next audit. **Catches only the cheap half**: six rows were once vacuous while every anchor resolved perfectly, and only a real audit run finds that |
| `test_svelte_check.py` | **`vite build` does not type-check `.svelte` script blocks** - a reference to an identifier that no longer exists compiles and ships, then throws at runtime inside a `try/catch` that degrades quietly. That shipped three times in one day (a deleted `let preparing`; a `.default` unwrapped twice; a renamed `repaintJassub` - the last two silently downgraded every ASS release to WebVTT). `svelte-check` catches all three. A **ratchet**, not a clean gate: 7 pre-existing type errors remain in unrelated components, so it fails only when the count rises. Lower the baseline as they are fixed; never raise it. It has already paid for itself twice over: typing an `apiJson<string[]>` call in Compare made it notice that `suggestions` had been declared `string[]` while every write put `{ value, label }` in and every read used `.value` - declaring it honestly cleared the new error *and* the two standing ones |

Final line on success: `Pre-deploy: 16/16 passed - ready to build` (15/15 with
`--skip-burned-in`). On failure:
`Pre-deploy: FAILED at step X - DO NOT deploy`. A run that can't warm the season
cache stops before step 1 with
`Pre-deploy: FAILED before step 1 - ... the suite would test against missing data`,
and exits non-zero.

---
