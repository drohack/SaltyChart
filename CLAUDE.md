# CLAUDE.md - SaltyChart contributor guide

This is the canonical project guide for Claude Code sessions (and any other
agent) working in this repo. It covers working conventions, architecture,
API surface, and schema. Start here.

---

## Rules (read before making changes)

### Keep docs and comments in sync with code

Docs drift is a real bug - it misleads the next contributor. **Before
finishing a task, update the docs and comments your change makes stale.**

**Three files, not one.** This root guide is loaded into *every* session, so it
holds what is cross-cutting or safety-critical. Subsystem reference material
lives in nested guides that Claude Code loads only when the work touches their
directory: **`backend/CLAUDE.md`** (the `/api/jellyfin` and `/api/translate`
routers) and **`frontend/CLAUDE.md`** (the per-surface UI detail). Put new
detail wherever the person who needs it will actually be working - but a
prohibition goes in the root regardless, because a rule that isn't loaded when
it matters is not a rule.

When your diff touches any of these, update the listed locations too:

- **New API endpoint** -> update the endpoint list in the *Backend Service*
  section below (include auth requirements + rate-limit tier). For a
  `/api/jellyfin/*` or `/api/translate/*` route the contract lives in
  `backend/CLAUDE.md` instead; the root keeps only the one-line router entry.
- **Removed / renamed endpoint** -> remove it from that list *and* from
  `backend/CLAUDE.md` if it was a Jellyfin or translate route; grep the
  frontend for callers and update them too.
- **New DB column / table / index** -> update `backend/prisma/schema.prisma`
  **and** the raw SQL in `ensureDatabaseSchema()` in `backend/src/index.ts`,
  **and** the schema bullets in the *Backend Service* section below.
  Production does **not** run `prisma migrate`; the raw-SQL path is
  authoritative at runtime.
- **New user-visible feature or page redesign** -> update `README.md`
  *Feature highlights* **and** the relevant page bullets - the page list is in
  the *Frontend Service* section below, the per-surface detail (Options modal,
  Randomize, the player, Compare) in `frontend/CLAUDE.md`.
- **Removed feature, dep, file, or component** -> grep repo-wide for its
  name; kill stale references in source comments, JSDoc, `README.md`, and
  this file.
- **Changed default behaviour** (default sort, theme, flag, etc.) -> search
  for docs or inline comments that named the old default.
- **New `AppConfig` key** -> add it to the `AppConfig` bullet in the schema
  section. Everything in that table caches an upstream answer, and the reason
  each one is persisted (restarts are what generate the load) belongs with it.
- **Changed matching behaviour** -> update *Matching AniList entries to the
  library*, re-run `check_match_corpus.py` (with `fresh` **and** `startDate`),
  and re-baseline the replay only after reading its diff. A matcher change that
  moves counts without a named cause is a regression until proven otherwise.
- **Quoted a measurement in prose** -> say what it was measured over and when it
  would stop being true. `~55% coverage` and `~836 series` both survived here for
  months as live facts and were wrong by 40 points and 3x respectively.
- **Fixed something an exploratory pass found** -> update
  `tools/tests/EXPLORATORY.md`. This file rots faster than any other doc here,
  because *fixing* a finding changes the behaviour the charter tells the next
  agent to expect - a pass-1 finding was withdrawn as a measurement error while
  the charter still instructed the reader to measure it that way, and a
  `file.svelte:36` reference was moved by its own fix within the hour. Past-tense
  the finding, say what the fix was, and correct any session step whose expected
  value changed (e.g. "availability calls must be exactly 1" became "1 on an
  aired season, 0 on an unaired one"). `test_audit_anchors.py` catches only the
  mechanical half - dead file paths and line-number references.

### Measure before claiming - and check what you measured

Every wrong conclusion in this repo's history has come from one of five shapes.
They are listed with the instance that produced them, because the abstract
version is easy to nod along to and ignore.

**1. A diagnostic that doesn't send what the real caller sends measures a
program you don't ship.** This has caused three separate wrong conclusions:

| omitted | what was actually being graded |
|---|---|
| `fresh` in `check_match_corpus.py` | the availability cache - a recording of an earlier run |
| `startDate` in the same tool | a build with the air-date guard *disabled* (20 false positives reported vs 12 real) |
| `tmdbId` in the replay fixture | half of `matchSeries`; the TMDB tier was never exercised |

Before trusting a number, diff your request against the real caller's.
`build_match_fixtures.py` now refuses to write a column that is empty on every
row, which is the general form of the fix.

**2. Repeating a documented figure is not measuring it.** `~55% id coverage`
(really 94% on TV) and `~836 series` (really 2271) were both quoted from this
file as live facts. A number in prose is a record of one past measurement, not a
property of the system. If a decision turns on it, re-measure it.

**3. "It can't be found / can't be done" needs a search behind it.** 292 entries
were called permanently unknowable; the upstream databases knew 284 of them, and
a base-title search resolved 211. The claim was never tested.

**4. Generalising from a handful of eyeballed cases produces guards that delete
correct behaviour.** An `isRelation` guard was built from four samples and would
have rejected `Bananya Around the World -> Bananya`, which is right (1 day off).
Season count "obviously" separating a spin-off from a sequel is false too -
Bleach at 26 seasons is a correct match, Pokémon at 23 is wrong. **Air date
separates them by three orders of magnitude; nothing else does.**

**5. A test that goes red has not necessarily caught anything.** Beyond the
`expect` substring rule in `mutation_audit.py`:
- Order assertions **specific-first**. A generic "it resolved anyway" check
  fired before the specific "it fell through to a series" one and caught its own
  mutation for the wrong reason.
- Assert on the surface that can actually be wrong. A hide-rollback test checked
  the *server*, which is trivially correct when every write fails.
- A row can go vacuous when unrelated code changes: nulling `tvdbId` stopped
  disabling the id tier once TMDB backed it up.

**6. A warning is not a bug until a number moves.** The backend logs
`MaxListenersExceededWarning` constantly. Re-measured 2026-08-06 at 204
occurrences, having been dismissed once at 74:

- **It is always exactly `11 error listeners`**, across 204 occurrences and 71
  distinct PIDs - never 12, never 50. Node emits this once per emitter on
  crossing the threshold, so a real leak would show climbing counts on
  long-lived emitters. It averages ~2.9 per process lifetime.
- **RSS and handles are flat.** Driven with 180 requests (150 cached, 30
  `fresh`): RSS 124.8 -> 124.5 MB, handles 277 -> 277, 0 new warnings.
- Most likely benign by construction: more than ten requests queued on one
  keep-alive agent socket, each attaching an `error` listener while queued and
  dropping it on completion. That matches "always 11" exactly.

**Not established: it could not be reproduced on demand**, so that cause is
inference, not a traced stack - it fires during the mutation audit and the full
suite, which do real Jellyfin and AniList work that `/availability/batch` alone
doesn't reach. To settle it, run the dev backend once with
`NODE_OPTIONS=--trace-warnings` during an audit. Worth doing only if RSS stops
being flat. A first measurement of this cost a round trip; a second one that
re-derives the same verdict costs another, so the numbers are here.

**And two habits that aren't about measurement:**

- **Never pipe a long-running command through `tail`/`head`/`grep`** - it
  silently discards the part of the output you didn't anticipate needing. A
  per-format table was lost this way.
- **Never truncate a collection silently.** `slice(0, 100)` on a 128-entry season
  made a review page report "nothing needs review" for a third of it. Chunk, or
  say what was dropped.

### Verify nearby comments when editing code

- Re-read function-level `/** JSDoc */` and header comments next to your
  change. If the body now contradicts them, fix the comment.
- When deleting code, grep for surviving comments referencing the deleted
  identifier, shape, or behaviour (e.g. "hides the 4-column grid" after
  moving to cards).
- Markdown bullets citing specific line numbers, class names, or file paths
  are the most rot-prone - verify each still matches reality.

### Secrets: the Jellyfin key leaves by more doors than you think

The API key is guarded carefully on the way to a browser - the stream proxy
**refuses** any manifest containing a credential, and `test_jellyfin` asserts it.
That guard exists because Jellyfin embeds the caller's key into HLS subtitle
rendition URIs, so **never send `subtitleMethod=Hls`**. It was written for one
door, and the key walked out of another: an axios error carries its request
`config`, so `console.warn('...', err)` printed `Token="..."` into the backend
log on any library-refresh timeout.

**Log `jellyfinErrorInfo(err)`, never the error object.** When adding a new
`catch`, ask where else the value could carry a header - logs, error responses,
telemetry, a message shown to a user.

Same instinct for **repo contents**: this repo is public. The match-replay
fixtures snapshot every title in the media library plus internal item ids, so
they are gitignored and built locally. Before committing generated data, ask what
it describes about the person running it.

### Style rules

- Comments explain *why*, not *what*. Delete redundant "increments X"
  comments when editing nearby code.
- Don't create new `*.md` files for ad-hoc notes unless the user explicitly
  asks. Canonical docs are `README.md` (user/deployer-facing) and the
  `CLAUDE.md` set (contributor/agent-facing): this root file plus the nested
  `backend/CLAUDE.md` and `frontend/CLAUDE.md`.
- Don't add date-stamped section headers ("Recent features (Month Year)")
  they stale fast. Use evergreen wording.
- UTF-8 / box-drawing chars are used throughout existing docs - match the
  surrounding style.

### Pre-completion sanity checks

1. `cd frontend && npm run build` -> zero a11y warnings, clean exit.
2. `cd backend && npx tsc --noEmit` -> clean exit.
3. **Before building Docker images for deploy**: run the full pre-deploy
   suite (`tools/tests/run_all.py`) - see *Testing* section below.
4. Skim `README.md` and this file for stale mentions of the old behaviour
   and update them - including any **number** your change invalidates (step
   counts, mutation-row counts, corpus sizes, coverage percentages).
5. If you touched `shareCompare()` in `Compare.svelte` or `shareMyList()`
   in `WatchListSidebar.svelte`, manually verify the share button still
   exports a reasonable image - both functions are DOM-clone-heavy and
   brittle to layout changes.
6. **Clean up Playwright screenshots** at the repo root:
   `rm compare-*.png randomize-*.png home-*.png home-desktop-after-gap-fix.png 2>/dev/null`

### Testing

A regression / smoke-test suite lives at `tools/tests/`. Run it before
building Docker images, after any change to a route, schema, store, or
translation pipeline. Documentation at `tools/tests/README.md`.

```bash
# 0. Kill stale ts-node-dev / vite processes (avoids port conflicts)
py -3.13 tools/tests/kill_stale.py

# 1. Backend dev on :3000, frontend dev on :5173 (Vite strictPort=true)
cd backend && npm run dev   # terminal 1
cd frontend && npm run dev  # terminal 2

# 2. Run the suite
py -3.13 -u tools/tests/run_all.py

# Skip the GPU-heavy burned-in detection test
py -3.13 -u tools/tests/run_all.py --skip-burned-in
```

The backend's `/api/auth/*` rate limiter (20 req/min in prod) is **disabled
when `NODE_ENV !== 'production'`** so rapid signups during tests don't trip it.

### Is the suite load-bearing? The mutation audit

Detail lives in the `testing` skill (`.claude/skills/testing/SKILL.md`), which
loads when you are actually running or changing tests: what each test file
covers, how to write a mutation row worth its cost, the AniList rate-limit
rules, and the measured costs. These rules are here because they must hold
whether or not that skill is loaded:

- **`run_all.py` is the deploy gate, not an end-of-task ritual.** Push to
  master builds and ships, so it runs once, immediately before a push. It takes
  ~4 min with `--skip-burned-in` and starts real transcodes on the box that
  also serves Plex and Jellyfin.
- **`mutation_audit.py` is NOT a gate.** It edits tracked source, restarts the
  backend twice per row and starts real transcodes. Run it when you changed a
  test or the code a row points at - `--only N` makes checking one cheap. Last
  measured: **74 rows in 19 min** (2026-08-05); the table is at **83** rows
  since, so re-time it rather than quoting that figure.
- **A test run must never provoke a live AniList 429.** The 429/backoff logic is
  unit-tested off the network. Warm the cache first; both runners do it
  automatically and refuse to start if a season key can't be fetched, because a
  missing season makes the suite pass *vacuously* rather than fail.
- **Add a mutation row whenever you add a test**, and watch it fail AND pass. A
  test nobody has watched fail is a test nobody should trust.
- **Never wipe `SeasonCache`** more than once or twice an hour.
- **`tools/bench_player.py` must not be run casually.** Every playback remuxes
  to disk, and nine cold runs once filled the transcode cache until Jellyfin
  served 0-byte segments - indistinguishable from an app bug. The mechanism is
  in `backend/CLAUDE.md`; the restraint has to be here, because the script is
  in `tools/` and nothing there loads that file.


## Project Overview

SaltyChart is a two-service web application for discovering seasonal anime,
viewing summaries & trailers, and enabling authenticated users to build
and share custom rankings.

## Monorepo Layout

`backend/` (Express + TypeScript), `frontend/` (Svelte 4 + Vite), `tools/`
(Python helpers, with the pre-deploy suite in `tools/tests/` and Unraid script
copies in `tools/unraid/`). Read the tree rather than a copy of it; each
`backend/src/lib/` module's job is its own header comment.

Two facts about `tools/` that reading the tree won't tell you: the benches are
composable (`bench_pipeline.py` provides swappable ASR/translate/align stages
to `benchmark_whisper_settings.py`), and `bench_transcode_cpu.py` measured
playback CPU at **5.9x realtime for burn-in (~1.5 cores) and 11.2x for remux**,
reading the server's CPU from the mirrored syslog.

## Backend Service

Path: `backend/`

- Tech: Node.js, Express, TypeScript, Prisma Client, SQLite
- Entry: `src/index.ts`
- Dev: `npm install && npm run dev` (hot reload via ts-node-dev)
- Build: `npm run build`
- Start: `npm run start`
- Env variables:
  - `JWT_SECRET` (required for auth token signing). In production the server
    **fails fast at startup** (`[FATAL]`, `process.exit(1)`) if it's unset or
    left as the insecure `'dev-secret'` default. Supplied via an untracked
    `.env` (`JWT_SECRET: ${JWT_SECRET}` in the compose files), never committed.
  - `DATABASE_URL` (defaults to `file:./prisma/data.db` in production)

### API routes mounted under `/api/*`

- `/api/health`          (health check)
- `/api/anime`           (AniList GraphQL proxy + cache; page 1 reveals
  `lastPage`, then pages 2..N are fetched with a concurrency-3 pool - a
  mid-season cold load is 6-12 pages and sequential round trips dominated
  its latency. Concurrent cold requests for the same season are coalesced,
  and an **expired `SeasonCache` row is served stale while a background
  refresh runs** - only a never-fetched season blocks on AniList)
- `/api/auth`            (login, signup, password reset, JWT issuance)
- `/api/list`            (user watchlist CRUD)
- `/api/public-list`     (public watchlist read-only)
- `/api/users`           (user management)
- `/api/options`         (per-user UI preferences)
- `/api/jellyfin`        (Jellyfin integration: availability, playback, streaming - contracts in `backend/CLAUDE.md`)

Routes inside existing routers:

- `PATCH /api/list/watched`   - toggle watched / unwatched and record timestamp
- `PATCH /api/list/rank`      - update per-season *watchedRank* ordering
- `PATCH /api/list/hidden`    - toggle *hidden* flag (excludes an entry from the Randomize wheel)
- `GET   /api/list/users-with-nicknames` - users with at least one custom nickname (**rate-limited**, 60/min)
- `GET   /api/list/users-with-ratings?season=&year=` - users with any entry for a season; powers Randomize's nickname auto-check (**rate-limited**)
- `GET   /api/list/user-ratings?username=&season=&year=` - mediaIds a user has in a season (**rate-limited**)
- `GET   /api/list/nicknames?mediaId=` - nicknames & ranks for a given series (**rate-limited**)
- `PUT   /api/list` - replace entire list for a season/year in one shot
- `POST  /api/auth/reset-password` - reset a user's password by username; no auth required (intentionally low-security - no email, small friend-group app)

### Jellyfin integration routes (`/api/jellyfin`)

Every route contract, the SDK's two packaging traps, the availability cache and
what "direct stream" really costs are in **`backend/CLAUDE.md`**, which loads
when you work under `backend/`.

### Matching AniList entries to the library

`backend/src/lib/animeMatch.ts` - pure, no I/O, unit-tested directly and
reusable. `backend/src/lib/anilistTvdbMap.ts` does the I/O half. The evidence
behind every rule below is preserved as comments at the guard it justifies -
this section states the rules and where each lives.

**Identity and availability are different questions**, and conflating them is
what made this code produce a new false positive every few weeks. Identity -
*which real series is this?* - is permanent; availability - *do we hold it
right now?* - changes on every grab or delete. `lib/seriesIdentity.ts` owns
the first; `resolveAvailability` (routes/jellyfin.ts) the second.

**Resolution order for identity: our override table -> the community map -> a
remote lookup we make ourselves -> nothing** - and only then may titles be
consulted. The override table is an *overlay*, not a copy: the map already
answers 94% of TV correctly, so rows exist only for corrections,
confirmations, and entries the map never covered. Written from
`/admin/matching`; loaded into memory at boot.

**A known id is authoritative in BOTH directions.** If an id is known and no
library series carries it, that is the answer - `matchSeries` returns null
rather than falling back to titles. Graded blind over 8 seasons / 945 entries:
title-prefix matching was 60% precise, and **all 12 failures were a new work
matching its franchise parent while its real TVDB id sat unheld** - we knew
the answer and let the fuzzy matcher overwrite it. Season counts and title
shape were both tested as separators and refuted (`animeMatch.ts` comments);
**air date separates right from wrong by three orders of magnitude and
nothing else does.** Residual risk: a *wrong* id plus the show held under a
different id reads as "not in library" - zero cases in the corpus, and an
override row is the permanent fix.

#### Making the links nobody else has - `lib/remoteIdentity.ts`

The community map answers 94% of TV and **0% of the 292-entry gap**; the
upstream anime databases know 284 of those 292 but none carries a TVDB/TMDB
id. So we make the links from two keyless sources: **series go to TVDB first**
via `lib/skyhookIdentity.ts` -> `skyhook.sonarr.tv` (Sonarr's own proxy: native
TVDB ids, plus per-episode air dates for seasons nobody holds yet - the
evidence class the held-library gate cannot produce); movies and skyhook
misses use Jellyfin's own TMDB remote search (Radarr's proxy was measured and
rescued zero movies, so no new dependency). skyhook is someone else's free
service: calls are paced, bounded per run, degrade to the Jellyfin path, and
**never appear on a viewer's request path**.

A sweep runs 90 s after boot and daily, reads entries from `SeasonCache`
(every cached season, however old - a first-ever lookup is made regardless of
age), and is bounded at **150 lookups per run** (the re-grade pass shares that
figure via `REGRADE_PER_RUN` - it carries correctness fixes now, not grooming,
and 40/day would take over a week to propagate one across a few hundred rows) - sized at ~one year's worth
of gap entries (measured: ~150 of a year's ~470 entries lack any map id), so
a season rollover clears in one run. The three maintenance passes
(legacy-row dating, `regradeStoredRows`, `fillTvdbGaps`) keep a smaller
40-per-run cap; they groom already-stored rows and nothing an admin waits on
depends on them. `POST /identity/sweep` (the *Run sweep now* button on
`/admin/matching`) runs the same sweep with **both the cap and the retry
cooldowns dropped** (`planSweep`'s `ignoreCooldown`) - a human pressing it is
not the daily budget, and without the override the button is a no-op on
exactly the state it exists for, since one sweep leaves every row cooling.
A drain also removes the re-grade cap, so one press propagates a matcher change
across every stored row. Retirement is *not* overridable: those entries aired
years ago and no upstream source has ever heard of them, so re-asking on every
press is the churn retirement removed. Pacing still applies; drain removes the truncation, not
the politeness. Cold starts once took eight container restarts at the old cap
of 40 - measured after: one click, 375 lookups, 11.5 min. Two selection rules were broken at first, invisibly
(the system just silently stops improving - both are commented at the code):

- A row recording *"we looked and found nothing"* must **not** shadow the
  community map - an id-less, unconfirmed, un-rejected row is bookkeeping,
  not an answer (`resolveIdentity`).
- The sweep selects on **`needsRemoteLookup`**, not "has an identity row" -
  the latter retired an entry on its first empty search and made the retry
  tiering dead code.

A human decision (confirmed or rejected) still wins over everything - so a
mistaken Reject is permanent until cleared on `/admin/matching`. Stored rows
are **completed in both id spaces** (`completeIdentityIds`: held item first,
community-map cross-walk second), because this server's remote search returns
TMDB only and a Sonarr user expects TVDB on series rows. Misses are recorded
and retried on a tier keyed to how close the entry is to airing (2 days
within +/-1 year, 30 days within +/-2, unknown year 14) - that is when records
actually appear. A miss whose entry aired **more than 2 years ago is retired**
(`retryAfterFor` returns Infinity, unit-tested): still unknown upstream after
that long means unknown for good, and re-asking monthly forever was budget
spent on lost causes. Retirement never blocks a *first* lookup, and a human
can still resolve a retired entry by hand on `/admin/matching`.

Three search rules, each measured (evidence in the module header):
**both search kinds are tried** (AniList's format does not predict how TMDB
files a work; +22 and it upgraded wrong matches to right ones); **the base
title is searched too** (+59 - and it also reaches *Babylon 5*, which is why
nothing is ever accepted on title alone; `baseTitles` strips season markers
before subtitles and only treats separator-looking separators as such -
`Re:Zero` must not collapse to `Re`); and **a guessed id is POSITIVE-ONLY**
(`idIsAuthoritative: false`) - it may add a Watch button, never remove one,
because many gap entries resolve by title today and a guess must not delete a
working match. The UI marks such matches `unverified`.

**Which candidate is offered is decided by air date too, not provider
relevance.** `pickCandidate`'s last rung sorts *exact* titles by premiere
distance rather than taking TMDB's first: Echo (premiering 2026-07-19) was
offered its 2023 namesake 1,012 days away while the 2026 film 46 days away sat
third in the list. Only the suggestion changes - nothing within tolerance
means the ladder still queues the row for review.

**A ladder or ranking change reaches rows already stored, via
`RESOLVER_VERSION`.** The sweep selects on `needsRemoteLookup`, so an entry
that already carries an id is never re-asked - which used to mean a matcher
fix healed only NEW lookups and left every old suggestion as it was (Echo kept
offering its 2023 namesake until its row was deleted by hand). Every write
stamps the resolver's version; `needsRegrade` selects machine-decided rows
carrying an id whose stamp is below the current one, and re-resolving stamps
them, so the pass drains and stops. **Bump `RESOLVER_VERSION` whenever a change
would decide a stored row differently** - that is the whole trigger. Human
decisions (confirmed/rejected/manual) are never re-graded, and id-less
bookkeeping rows belong to the main sweep's retry tier instead. Measured on a
deployment carrying 295 stale rows: one *Run sweep now* healed all of them in
~11 min and the next run selects none.

**Acceptance is decided by air date, not title confidence** (`verdictFor` -
the full ladder, its rungs, and the measured day-distance tables are its
JSDoc). The shape that matters: correct results land 0-31 days from the
AniList premiere, wrong ones 62-21,929, with nothing in between - and this
holds for library air dates, TVDB season premieres, and TMDB premiere dates
alike. Consequences encoded in the ladder:

- An exact title the premiere date *refutes* is never blind-accepted (the
  Echo bug: the refuting day sat unread in the same response for months).
- The TVDB season-premiere rung sits **above** the held-library rung: held
  episodes are stale by construction for a season nobody has grabbed yet
  (Ranma S3 rejected at 287 d while TVDB had S3E1 on the entry's premiere day).
- A held-library rejection softens to queue while TVDB lists an **undated
  future season** (the Frieren-S3 shape); One Piece Fan Letter and Babylon 5
  list none and still reject.
- A dated candidate beyond tolerance **queues, never rejects** (*cocoon* at
  523 d is the correct film - TMDB dates the theatrical release, AniList the
  broadcast).
- The release-year rung is **gated to movie-kind candidates in code** - for a
  series a +/-1 production year is nearly free and an ungated rung wrote
  coincidental TV siblings in as accepted fact.
- `pickCandidate` applies the same evidence to title collisions (dated-within
  exacts by distance first - DIVE IN! shipped its 167 d sibling while the
  16 d one sat second in TMDB's popularity order).
- There was an `isRelation` guard rejecting results related to the entry; it
  was wrong and was removed (sequel->parent is *correct* - TVDB/TMDB put
  seasons inside one series). Don't reintroduce a title or relation heuristic
  without re-measuring.

**A viewer can correct a match from the Watch pop-up**, and it is remembered
for everyone: the pop-up is where a wrong match is actually noticed, and
`/admin/matching` - where it could be fixed - is a page nobody visits. The
picker offers held library items only (a resolver candidate is usually
something we DON'T hold, which is why the row is unverified), the pick writes a
`manual` row carrying a `viewer:` note, and that note puts it in the admin
review queue as *Viewer pick* with Confirm/Reject. A human decision always
wins - see `POST /identity/pick`.

**The same show found in both providers becomes ONE candidate, merged on an
id cross-reference - never on a title.** TVDB and TMDB answer the search
separately, so a work both know arrived as two identical-looking options and
only one id was ever stored (`Chikyuu Daisuki! Kikkun`: TVDB undated, TMDB
dated on the entry's premiere day). skyhook's *show* record carries TVDB's own
`tmdbId`, and that request is already made for the season-premiere check - the
field was simply being discarded. `mergeCrossReferencedCandidates` collapses a
TVDB-only candidate into a TMDB-only one only when that reference points at it,
keeping the TVDB side as the base and taking the date. Measured after: Chikyuu
stores both ids, drops from two candidates to one, and leaves the review queue.
**Merging on matching titles would be actively wrong** - Echo's three
candidates are all titled exactly "Echo" and are three different films - and
the guard is a mutation row. A duplicate *within* one provider (Cyborg 009:
Nemesis exists twice in TVDB, one copy undated) is NOT merged: nothing proves
the two are the same show, so it stays in review.

**The top five candidates are kept, not just the winner** (TMDB orders by
relevance; the tail past five is noise - commented at the `slice` in
`searchOne`), stored as JSON on `SeriesIdentity.candidates`; `/admin/matching`
renders a picker defaulting to the resolver's choice, and a multi-candidate
row stays in review even when the air-date gate accepted it. Every resolver
row shows provenance - an `our lookup` badge plus the rung that accepted it -
because an id we guessed is not the same kind of fact as one from the map.
Accepts decided on title text or release year alone stay reachable behind the
"+ resolver accepts" filter (deliberately not in the default queue; their
being *invisible* was the audited bug). Rows stored before candidates carried
premiere dates are re-graded by a capped, self-terminating sweep pass
(`regradeStoredRows`); it never touches confirmed/rejected/manual rows.

#### Films are resolved against films - `jellyfinFilmIndex`

`getSeriesLibrary` fetches Series only, so a film's id could never match and
the lookup used to fall through to title-matching TV shows - measured: **26
category errors** (`The Last Blossom -> House`) against 1 lucky hit, and 7
held films unreachable. A `movie`-kind identity now resolves via a TMDB-id ->
item **index** (`lib/jellyfinFilmIndex.ts` -> `AppConfig.jellyfinFilmIndex`,
6 h TTL, persisted, stale-while-revalidate, warmed at boot). Deliberately an
index and not a second matchable corpus: films are only ever looked up by id,
so titles are never compared - the error class is removed, not re-tuned. Its
cold-path coalescing is unit-tested (check-and-set with nothing awaited
between; the first shape raced and was watched to fail). **When the film
isn't there, that is the answer** - no title fallback; `finishEpisode`
already returns the right shape for a movie item.

#### The two availability tiers - both permanent

1. **id** - AniList id -> TVDB id (community map from `Fribb/anime-lists`,
   ~7.2k pairs, cached in `AppConfig`) -> a library series carrying that id.
   **Nothing on the request path waits for the map**: it is refreshed at boot
   and daily with `If-None-Match` (usually a 304), never awaited by
   `resolveAvailability` - a viewer used to pay for the whole 7.5 MB download
   after a restart (fixed: 110 ms, id tier recovers ~8 s later in the
   background). `rememberAvailability` refuses to cache until
   `anilistTvdbMapReady()`, or a title-only answer computed before the map
   loaded gets pinned for an hour. **TMDB rides along**: `themoviedb_id` in
   the map is an object (`{"tv": N}` / `{"movie": N}`), never a scalar -
   parsing it as one stringifies to `"[object Object]"` and silently yields
   zero - and the kind is stored with the id (`tv:123`) because TMDB numbers
   films and shows independently. It adds only 3/945 TV matches but is the
   only usable id for movies, and it makes the id tier redundant to a single
   nulled column.

2. **title** - the Unicode-aware fuzzy matcher: NFKD, strip diacritics, keep
   letters/digits of **every** script, then exact > prefix with length/ratio
   guards. Consulted only when **no id is known at all** (65 of 945 corpus
   entries - nothing else could find them). Do not "simplify"
   `normalizeTitle` to `[a-z0-9]`: that reduced a native-script title to
   `"3"`, which matched *30 Rock*. **There is no contains-anywhere tier**:
   the one that existed fired 9 times over 6 seasons and was wrong all 9,
   structurally (no threshold separates the pairs - evidence and the four
   fixture pairs live in `animeMatch.test.ts`, watched to fail with the tier
   restored).

The id tier finds a strict **subset** of what titles find; its value is
**confidence**, not reach. Coverage is uneven by *format*, not season age:
94% of TV entries have a TVDB id (81% even mid-season) but ONA is 40%,
TV_SHORT 32%, MOVIE 3%, OVA 1%. The response says `matchedBy`; the pop-up
marks title-only matches unconfirmed; bulk actions refuse to act on them.

#### Jellyfin identification is controlled by `tvshow.nfo`, not folder names

The Anime library reads local metadata first (`LocalMetadataReaderOrder:
['Nfo']`, always on - the "Metadata savers" checkbox is the *opposite* thing:
it makes Jellyfin WRITE NFOs, which fights Sonarr; leave it empty), and its
remote fetchers are disabled, so the NFO is effectively the only source of
identification. Sonarr -> Settings -> Metadata -> **Kodi (XBMC) / Emby** writes
those files and refreshes them on its daily scan; Radarr ditto for movies.
Enabling it + Refresh Series backfilled 833/836 anime folders and dropped
stored-id/NFO disagreements from 46 to 0, fixing shows matched to entirely
wrong series. No folder renaming, no watched state touched.

Folder-name id tags are a red herring here, but the syntax differs by server
and is worth knowing: **Plex** reads `{tvdb-12345}` (curly, no `id`) plus
`.plexmatch`; **Jellyfin** reads `[tvdbid-12345]` (square, with `id`) and
ignores `.plexmatch`. This library's folders mostly carry `[tvdb-12345]`,
which matches *neither* - those tags do nothing on either server.

**When measuring any of this, compare ids (not names), scope to the seasons
the app shows, and send what the real caller sends.**
`tools/check_match_corpus.py` measures the thing that counts - how a real
season resolves end to end - and it sends `fresh: true` AND `startDate`
because each omission produced a wrong conclusion (the rows in *Measure
before claiming* above): without `fresh` it grades a recording of an earlier
run; without `startDate` the air-date tier is silently disabled and it
reports false positives the real frontend never shows (20 vs 12 measured).

### Rate limiting

A 120 req/min per-IP `generalLimiter` covers all routes. `/api/translate/*`
mounts before `compression()` (SSE can't be buffered), so the limiter is
applied explicitly on that mount - `app.use('/api/translate', generalLimiter,
translateRouter)` - rather than relying on the later global `app.use`.
`/api/auth/*` has a stricter 20 req/min limiter. The 4 unauthenticated
`/api/list/*` endpoints above additionally sit behind a 60 req/min
`publicListLimiter`. `/api/jellyfin` also mounts before `compression()` and so
carries its own limiters: 120 req/min for the JSON endpoints and a separate
**600 req/min** for `/api/jellyfin/stream/*`, `/subtitles` and `/attachments`
(HLS playback is a playlist refresh + a segment every few seconds plus seek
bursts - it must not eat the general budget).

### Error response shape

Every error is `{ error: 'human message', code: 'CODE_NAME' }`. Codes
include `BAD_REQUEST`, `UNAUTHORIZED`, `INVALID_CREDENTIALS`,
`INVALID_TOKEN`, `USER_NOT_FOUND`, `USER_EXISTS`, `ADMIN_REQUIRED`,
`BATCH_RUNNING`, `RATE_LIMITED`, `UPSTREAM_ERROR`, `SERVER_ERROR`.
Frontend code reads `data.error` (unchanged from before the unification)
and may branch on `data.code` for programmatic handling.

### Translation routes (`/api/translate`)

Every route contract, the Whisper pipeline, the benchmark findings behind the
production settings and the batch schedule are in **`backend/CLAUDE.md`**,
which loads when you work under `backend/`.

### Database schema

Auto-created / updated at startup via raw SQL in `ensureDatabaseSchema()`.
Production does **not** run `prisma migrate`; keep
`backend/prisma/schema.prisma` and the raw SQL in `backend/src/index.ts`
in sync when adding columns/tables/indexes.

Tables / columns:

- `Settings` - per-user record storing theme, title language, autoplay,
  hide-from-compare, JSON columns `nicknameUserSel` and `subtitlePrefs`,
  and `addWatchedTo`.
- `WatchList.watchedRank` - integer; 0-based rank assigned after a show is
  watched and ranked in the Randomize page.
- `WatchList.hidden` - boolean; when true the show is skipped by the
  Randomize wheel.
- `AppConfig` - server-wide key/value config (`key` TEXT PK, `value` TEXT).
  Holds `jellyfinUrl` / `jellyfinApiKey`, written by the admin `/admin` page
  via `PUT /api/jellyfin/config`, plus `anilistTmdbMap` (AniList -> `tv:N` /
  `movie:N`, the namespace kept because TMDB numbers films and shows
  independently), `anilistTvdbMap` / `anilistTvdbMapAt`
  (the cached AniList->TVDB id map, refreshed at boot and daily on a timer,
  conditionally via `If-None-Match`, never on the request path),
  `jellyfinLibrary` / `jellyfinLibraryAt` (the match corpus - 2271 series on this
  deployment; the "836" figure elsewhere in this file counts *anime folders*, not
  the library), `jellyfinFilmIndex` (TMDB film id -> item, so a film is never fuzzy-matched
  against TV series), and
  `anilistRateLimit` / `anilistBackoff` (the last observed AniList budget, and
  per-season cooldowns after a 429), `jellyfinAvailability` /
  `jellyfinSourceDims` (the two per-item caches), and `remoteSweepStatus` (the
  last identity sweep's summary - persisted because "did the background
  resolver run, and what did it do" must survive the restart that follows a
  deploy, which is exactly when someone wonders; its `remaining` counts only
  what future runs will actually process, `retired` the old misses no longer
  re-asked, and `tracked`/`unmatched`/`cooldown`/`never`/`ready` plus `tiers`
  the whole-cache counts behind the admin page's all-seasons row. `tiers`
  (`id`/`title`/`notHeld`/`noMatch`) comes from `classifyMatch`, the *same*
  classifier `/identity/resolve` reports per row - so the panel's two scopes
  reconcile instead of being two computations that drift. It costs no provider
  calls: the library, the film index and the id maps are all in memory by the
  time the sweep runs). Everything in this table that
  caches an upstream answer is persisted for the same reason as the library:
  the load it guards against is *caused* by restarts, so an in-memory-only copy
  is empty exactly when it is needed most.
  The library cache is persisted because it used to be in-memory only: every
  restart refetched all of it with `ProviderIds,OriginalTitle`, so each deploy
  made the first viewer pay for it, and a development session with frequent
  reloads ran it dozens of times an hour - most of what drove the Jellyfin
  server process to ~800% CPU. Refresh is incremental where it safely can be:
  a `TotalRecordCount` probe (`limit: 0`, so no items are serialised) detects
  additions and removals, and when the count is unchanged only items matching
  `minDateLastSaved` are refetched and merged. Jellyfin does not return
  `DateLastSaved` on items, so the watermark is our own fetch time with a few
  minutes of overlap. A full refresh runs weekly regardless, because an
  incremental fetch can never reveal a deletion.
- `SeriesIdentity` - our AniList->TVDB/TMDB **overrides**: `anilistId` INTEGER PK,
  `tvdbId`, `tmdbId`, `tmdbKind` (`tv`|`movie`), `source`, `confirmed`,
  `rejected`, `pending`, `resolverVersion` (which resolver decided the row -
  `RESOLVER_VERSION` in `seriesIdentity.ts`; rows below it are re-resolved by
  the sweep's re-grade pass, which is how a matcher change reaches rows already
  stored, and stamping on write is what makes that self-terminating),
  `matchedTitle`, `note`, `year` (release year from whatever source named the identity - display only, never matched on; the sweep stores it at accept time, dates legacy rows via a capped remote pass each run, and the admin lookup/Confirm carry it through), `updatedAt`. `pending` marks a
row the remote resolver could not verify - it still counts (resolver ids are
positive-only, so they can only help) but it is what `/admin/matching` lists for
review. **`rejected` has to be its own column** - it
  means "definitively not in the library" and must suppress the *title* fallback
  as well as the map. Inferring it from "confirmed with no ids" is ambiguous,
  because confirming a good title match also leaves the id boxes empty; that
  ambiguity shipped and made Reject a no-op that still looked like it worked. An overlay over the community map, not a copy of it - see
  *Matching AniList entries to the library*. Written from `/admin/matching`;
  loaded into memory at boot because it is read on every availability lookup.
  A rejection short-circuits *before* matching, since it carries no ids and would
  otherwise fall straight through to the title tier - i.e. to the very match
  being rejected.
- `SubtitleCache` - `videoId` unique, `mediaId`, `modelName`,
  `hasEnglishSubs`, `lastEnCheckAt`, `subtitlesDisabled`, `hasBurnedInSubs`,
  `segments` JSON, `createdAt`. Caches check results, translated segments, and
  user subtitle preferences per YouTube video. `modelName` rank order (upload
  only upgrades to an equal-or-higher rank): tiny < base < small < medium <
  large-v2 < large-v3 < **large-v3-split** (the local champion pipeline). The
  rank table lives in **three** places - `backend/src/routes/translate.ts`,
  `backend/scripts/batch_translate.py`, and `tools/local_translate.py` - keep
  all three in sync (a missing `large-v3-split` in any one makes that path treat
  the champion output as rank 0 and needlessly reprocess it).

Performance indexes (added via `CREATE INDEX IF NOT EXISTS` at startup):

- `WatchList_userId_idx` - speeds `findMany({ where: { userId } })`
- `WatchList_season_year_idx` - speeds `/users-with-ratings`
- `Settings_hideFromCompare_idx` - speeds `/api/users`

`ensureDatabaseSchema()` also drops the retired `PlexSubtitle` table (it
cached WebVTT extracted from Plex media parts; Jellyfin serves subtitle
tracks directly, so nothing extracts any more).

The bootstrap logic will automatically create tables, add missing columns,
back-fill default `Settings` rows for existing users, and build the indexes
above idempotently on every start-up.

## Frontend Service

Path: `frontend/`

- Tech: Svelte 4, Vite, TypeScript, TailwindCSS (DaisyUI)
- Entry: `src/main.ts` -> `App.svelte` (client-side router)
- Dev: `npm install && npm run dev` (Vite dev server on port 5173)
- Build: `npm run build` (produces static assets)
- Preview: `npm run preview`
- Pages (lazy-loaded in `App.svelte`): Home, Login, SignUp, ResetPassword, Randomize, Compare, Admin, AdminMatching (`/admin/matching`). The two admin pages share `components/AdminTabs.svelte`, gated to the admin user via the `isAdmin` flag on `/api/jellyfin/status` (`stores/jellyfin.ts`). **`/admin/matching`** is the human end of the matching pipeline - what needs review for a season, a per-row state verdict derived from the stored acceptance rung (so it can never contradict what verified the match), and a Sonarr-import-style match control where picking fills and only Confirm saves. Rows sort by display title (the API returns AniList id order, which reads as arbitrary), a *Run sweep now* button fires `POST /identity/sweep` and polls the sweep summary until the run finishes (status line only - rows never reload out from under a review), and the sweep status line reports `remaining`/`retired` honestly. A two-row table summarises at a glance - the season on screen and every cached season, sharing columns so the scopes are read by comparison and the numbers align by construction (two earlier tile layouts drifted out of alignment the moment one group gained a line the other lacked). Two header tiers because the data is two levels deep: `by id + by title + not in library + no match = entries`, and `never searched + ready to retry + on cooldown + retired = queued`. **`queued` is not a slice of the first four** - an entry with no id can title-match today and still be owed a lookup - and the legend under the table says so, because a reader asked which numbers were subsets of which and flat columns couldn't answer. Each unmatched row also captions its own standing ("auto-searched 2 d ago - retries in ~5 h"). Its full UI contract - filter modes, provenance rules, the changed-vs-untouched Confirm discriminator - is the header comment in `pages/AdminMatching.svelte`; the resolution rules it fronts are in *Matching AniList entries to the library* above.
- State: simple Svelte stores in `src/stores/` (e.g. `authToken`, `userName`)

#### Reading from the API - `src/lib/remote.ts`

**Every remote read goes through this.** Before it existed there were 23 silent
`catch {}` blocks and **zero** `AbortSignal` in the whole frontend, so any hang
was infinite by omission and any failure rendered as an empty page. That is what
made an outage impossible to diagnose: no timeout, no message, no retry, nothing
in the console. The audit that found it is worth repeating before adding a new
fetch - the question is not "does this work" but "what does the screen say when
it doesn't".

- `apiFetch(path, init?, { timeoutMs, retries, budgetMs, label })` - wraps
  `fetch` with `AbortSignal.timeout`, retries **network errors and 5xx only**,
  and `console.warn`s every failed attempt with its label. It **never retries a
  timeout**: retrying a slow-but-working server multiplies the wait, which turns
  one stall into three. `budgetMs` caps the total rather than letting attempts
  multiply worst-case.
- `apiJson<T>(...)` - the same, parsed.
- `createRemote<T>(label)` - `{ status, data, error, run, retry }` with the
  request-id staleness guard extracted from `Home.fetchMainSeason`, so a late
  response for a previous season can't overwrite a newer one.
- `ApiError { kind: 'timeout' | 'network' | 'http', status?, unreachable }` -
  callers need to tell "couldn't reach the server" apart from "the server said
  no", because they mean different things on screen. Compare's is the clearest
  case: a failed `/api/users` used to leave the picker empty *and* suppress the
  "No user named..." warning, so an unreachable backend was indistinguishable from
  a typo'd username.

**Timeouts are per call, never global.** A cold `/api/anime` was measured at
**186s** under AniList rate-limiting, so a blanket default would break season
loading; `SEASON` is 200s and `QUICK` (lists, options, users, availability) is
15s.

`Home.svelte` predates the helper and already does all of this correctly by
hand - it is the shape `createRemote` was extracted from. Converting it is a
later pass; it is the best-covered path in the suite and there is nothing to
gain tonight but consistency.

- The main anime grid (`AnimeGridTranslate.svelte`) handles trailer subtitles
  via `/api/translate`. If the video has YouTube English CC (checked via a
  batch pre-fetch on page load), YouTube CC is shown and no translation runs.
  Otherwise, Japanese CC is suppressed and Whisper-translated subtitles are
  overlaid. Subtitles sync to the YouTube iframe API's `currentTime` and
  support play/pause/scrub.

### Additional UI features (grouped by surface)

The per-surface detail - Options modal, season toolbar, anime grid, Randomize,
the Jellyfin player, Compare - is in **`frontend/CLAUDE.md`**, which loads when
you work under `frontend/`.

## Prisma

`backend/prisma/schema.prisma` lists the models and indexes; read it there.
What the schema can't tell you:

- **`SeasonCache` / `SubtitleCache` are created and patched only by the raw SQL
  in `index.ts`.** The Prisma models exist to mirror them, so `prisma migrate`
  doesn't flag drift and offer a reset that would drop every cached
  translation, and so the client is typed for them. Same for
  `Settings.nicknameUserSel` and `subtitlePrefs`, which `/api/options`
  reads and writes via raw SQL.
- **Indexes are also created at runtime** with `CREATE INDEX IF NOT EXISTS`,
  because production never runs `prisma migrate`.
- **Locally the real DB is at `backend/prisma/prisma/data.db`** - nested, not
  the path `DATABASE_URL` suggests. In the container it is `./prisma/data.db`.
- Run `npx prisma generate` after schema changes, and mirror any column or
  index work in the raw SQL in `backend/src/index.ts`.

## Docker Compose

Compose file: `docker-compose.yml` (mirrors the production compose on the
Unraid server at `/mnt/user/appdata/saltychart/docker-compose.yml`).

The file states the images, ports and health checks. What it can't:

- **The live DB is the bind mount at `/mnt/user/appdata/saltychart/prisma`.** A
  legacy `saltychart_db` named volume still exists on the server and has been
  stale since April 2026 - **never point anything at it.**
- `JWT_SECRET` comes from an untracked `.env`, hardcoded directly in the
  server's own compose copy.
- Locally, `docker compose pull && docker compose up -d` runs what CI
  published; build the images yourself only when testing a change to them.

## Deployment (CI/CD)

**Push to `master` = deploy.** No manual builds, transfers, or GUI steps.

- `.github/workflows/deploy.yml` - on every push to master (ignoring
  `**.md`, `docs/**`, `tools/**`): gates on backend `tsc --noEmit` +
  frontend `vite build`, then builds and pushes
  `ghcr.io/drohack/saltychart-{backend,frontend}` tagged `latest` +
  immutable `YYYYMMDD-<shortsha>`. Single job; both images push together
  atomically after both builds succeed.
- `.github/workflows/build-base.yml` - **manual dispatch only**, takes a
  `version` input. Builds `backend/Dockerfile.base` ->
  `ghcr.io/drohack/saltychart-backend-base:<version>` (~3.3 GB: python3,
  ffmpeg, pip deps, pre-downloaded Whisper small+medium).
- `backend/Dockerfile`'s runtime stage is `FROM` the **pinned** base tag, so
  routine deploys transfer only ~100 MB of app layers, never the models.
  **Rule: any edit to `backend/Dockerfile.base` requires dispatching
  `build-base` with a new version AND bumping the `FROM` tag in
  `backend/Dockerfile` to match** - the base is never rebuilt automatically.
- Pull side: Unraid User Script `update_saltychart` (cron `*/10`, reference
  copy `tools/unraid/update_saltychart.sh`) - `docker compose pull`; if a
  new image arrived it backs up the DB via the existing
  `backup_saltychart_db` script, then `docker compose up -d` + image prune,
  logging to `/mnt/user/appdata/saltychart/update.log`.
- The full pre-deploy suite (`tools/tests/run_all.py`) **cannot run in CI**
  (Playwright against live dev servers + GPU test) - run it locally before
  pushing to master (see *Testing* above).
- Data safety: the DB bind mount (`/mnt/user/appdata/saltychart/prisma`) is
  never touched by deploys, and every applied update is preceded by a DB
  backup. Backup/restore User Scripts snapshot the **live** DB via the
  SQLite online-backup API - reference copies in `tools/unraid/`. Rollback =
  pin compose to a previous `YYYYMMDD-<sha>` tag (+ `restore_saltychart_db`
  if needed).
- Design spec: `docs/superpowers/specs/2026-07-09-cicd-deployment-design.md`.
  README has the user-facing walkthrough incl. offline tar fallback.

## Common Workflows

`npm install` / `npm run dev` / `npm run build` in `backend/` and `frontend/`
behave as you'd expect; the manifests list the rest. Only the two one-time
steps are worth writing down, because nothing in the repo will tell you:

```bash
cp backend/.env.example backend/.env   # provides DATABASE_URL for ts-node-dev
pip install youtube-transcript-api     # without it, English CC detection
                                       # silently returns false for every video
```

## Technical rules (specific to this codebase)

- Always load environment variables (`dotenv.config()`) before importing
  the Prisma client.
- When modifying the DB schema, update both `schema.prisma` and raw SQL
  logic in `backend/src/index.ts` (or add Prisma migrations). This is
  especially important for the `Settings` table, which is created and
  patched via raw SQL, and for new preference columns that the frontend
  expects.
- Frontend routing is file-based in `src/pages`; lazy-loading requires
  updating the switch in `App.svelte`.
- Cache season data in `SeasonCache` table (SQLite) and in-memory LRU
  (`routes/anime.ts`), on a flat 6 h TTL (see the rationale in *Testing* -
  serve-stale hides the TTL from viewers; it only sets AniList refresh
  frequency).
- Respect rate limits for the AniList API - retry/backoff, global pacing, and
  season-aware TTLs. **Anything added to reduce AniList load must survive a
  process restart**, because restarts are what generate the load in the first
  place; an in-memory counter is zero on every fresh process. Never call
  AniList from the browser, where no backend throttle can see it.
- **Never parallelise YouTube downloads, and never retry through a bot
  challenge.** Both batch translators download serially behind a delay and
  abort the whole run on a challenge, because parallel downloads tripped the
  bot wall; `--download-workers` is accepted and ignored for that reason. The
  pipeline detail is in `backend/CLAUDE.md`, but this rule is here because
  `tools/local_translate.py` breaks it from a directory that never loads it.

## Troubleshooting

- If the DB schema is out of sync, inspect console logs from
  `ensureDatabaseSchema()`.
- For 429 errors from AniList, check retry headers and backoff code in
  `anime.ts`.
- For CORS or proxy issues, verify `vite.config.ts` proxy settings
  (frontend).
- If every trailer shows Whisper auto-translation instead of YouTube English CC
  locally, run `pip install youtube-transcript-api`. Without it the Python
  `check_subtitles()` silently returns `hasEnglish: false` for all videos.
  The backend ts-node-dev process must be restarted after installing.
- `npx prisma generate` failing with **EPERM renaming
  `query_engine-windows.dll.node`** means a running node process has the
  engine loaded. `kill_stale.py` only frees the *ports* - stale ts-node-dev
  pairs from old sessions accumulate invisibly (30 were found holding the DLL
  once) and every one blocks the rename. Kill all ts-node-dev processes except
  the pair owning :3000, then stop that pair too, generate (it takes ~100ms
  once unlocked), and restart the backend.
- If the backend starts but every request returns 500, `DATABASE_URL` is
  missing. The server now exits with `[FATAL]` on startup if it's not set.
  Fix: ensure `backend/.env` exists (copy from `backend/.env.example`).

## References

- Root `README.md`: high-level overview & quick start
- `backend/src/` for API logic and the raw-SQL schema bootstrap
- `backend/prisma/schema.prisma` for the declarative Prisma schema
- `frontend/src/` for UI components, pages, stores
- `tools/` for Python helper scripts (local GPU translation etc.)
