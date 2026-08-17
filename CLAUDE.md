# CLAUDE.md - SaltyChart contributor guide

SaltyChart is a two-service web app for discovering seasonal anime, viewing
summaries and trailers, and letting authenticated users build and share custom
rankings. This is the canonical guide for Claude Code sessions (and any other
agent) working in the repo - working conventions, architecture, API surface,
schema. Start here.

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

**What the split is worth, measured 2026-08-06** against the 86,952-character
single file: a session that touches neither service loads 56% less, a frontend
session 42% less, a **backend session only 6% less**, and one touching both
services **8% more** - pointers, preambles and the deliberately duplicated
prohibitions cost about 7,000 characters in total. The win is real but uneven,
so don't split further expecting a uniform saving. `test_audit_anchors.py`
enforces the root's budget.

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
  **and** the schema bullets in `backend/CLAUDE.md`. Production does **not**
  run `prisma migrate`; the raw-SQL path is authoritative at runtime.
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
  section of `backend/CLAUDE.md`. Everything in that table caches an upstream
  answer, and the reason each one is persisted (restarts are what generate the
  load) belongs with it.
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

**6. A warning is not a bug until a number moves.** The backend's constant
`MaxListenersExceededWarning` is benign - **don't re-investigate unless RSS
stops being flat.** Measured twice (dismissed at 74 occurrences, re-measured
2026-08-06 at 204) so a third pass doesn't re-derive the same verdict: it is
**always exactly `11 error listeners`** across 204 occurrences and 71 PIDs,
never 12, never 50, ~2.9 per process lifetime - a real leak would climb. Under
180 requests (150 cached, 30 `fresh`) RSS went 124.8 -> 124.5 MB, handles 277
-> 277, 0 new warnings. Almost certainly >10 requests queued on one keep-alive
socket, each attaching an `error` listener while queued: that matches "always
11" exactly. **Not established** - it could not be reproduced on demand, so
that cause is inference rather than a traced stack. To settle it, run the dev
backend once under `NODE_OPTIONS=--trace-warnings` during an audit.

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
  ~6 min with `--skip-burned-in` (measured 2026-08-06) and starts real
  transcodes on the box that
  also serves Plex and Jellyfin.
- **`mutation_audit.py` is NOT a gate.** It edits tracked source, restarts the
  backend twice per row and starts real transcodes. Run it when you changed a
  test or the code a row points at - `--only 3,7,12` (one comma-separated list;
  repeating the flag silently keeps only the last) makes checking a few cheap.
  Last measured: **86 rows in 21 min** (2026-08-06), a full run of the whole
  table.
- **Restart the dev backend before an audit run, and again after one.** Its
  `git checkout --` restore replaces the file, and ts-node-dev's watcher on
  Windows loses track of it - the process then serves whatever it last compiled
  no matter what is on disk. This cost two false results in one session: a row
  reported `SURVIVED` while the backend had never run the mutation at all (read
  as a security hole in the admin gate; it was caught in 3 s after a restart),
  and a later test failed on a *clean* tree because the process was still
  running the previous row's mutation. **A `SURVIVED` on a backend row is not a
  finding until you have re-run it against a freshly started backend.**
- **A test run must never provoke a live AniList 429.** The 429/backoff logic is
  unit-tested off the network. Warm the cache first; both runners do it
  automatically and refuse to start if a season key can't be fetched, because a
  missing season makes the suite pass *vacuously* rather than fail.
- **Add a mutation row whenever you add a test**, and watch it fail AND pass. A
  test nobody has watched fail is a test nobody should trust.
- **Never wipe `SeasonCache`** more than once or twice an hour.
- **Two scripts in `tools/` bite hard** - `bench_player.py` fills the transcode
  cache, and parallel YouTube downloads trip a bot wall. Details in
  `.claude/rules/tools.md`, which loads when you work in `tools/`.


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

`backend/` - Express + TypeScript + Prisma/SQLite, entry `src/index.ts`.

- Dev: `npm install && npm run dev` (hot reload via ts-node-dev)
- Build: `npm run build`, Start: `npm run start`
- Env variables:
  - `JWT_SECRET` (required for auth token signing). In production the server
    **fails fast at startup** (`[FATAL]`, `process.exit(1)`) if it's unset or
    left as the insecure `'dev-secret'` default. Supplied via an untracked
    `.env` (`JWT_SECRET: ${JWT_SECRET}` in the compose files), never committed.
  - `DATABASE_URL` (defaults to `file:./prisma/data.db` in production)

### API routes mounted under `/api/*`

`/api/health`, `/api/auth`, `/api/list`, `/api/public-list`, `/api/users`,
`/api/options` do what their names say - read `backend/src/routes/`. The three
that don't:

- `/api/anime` - AniList GraphQL proxy + cache; page 1 reveals `lastPage`, then
  pages 2..N are fetched with a concurrency-3 pool - a mid-season cold load is
  6-12 pages and sequential round trips dominated its latency. Concurrent cold
  requests for the same season are coalesced, and an **expired `SeasonCache`
  row is served stale while a background refresh runs** - only a never-fetched
  season blocks on AniList.
- `/api/jellyfin` - availability, playback, streaming; contracts in
  `backend/CLAUDE.md`.
- `/api/sonarr` - the Sonarr auto-add. **Admin-only throughout** (there is no
  public route; the Custom List that needed one is gone), and the **only place
  in this codebase that writes to Sonarr**. It must never trigger a cold AniList
  fetch. Contract in `backend/CLAUDE.md`; the argument for every predicate is
  the docstring of `backend/src/routes/sonarr.ts`.

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

### Sonarr auto-add (`/api/sonarr`)

The contract is in **`backend/CLAUDE.md`**; the argument behind every predicate
is the docstring of `backend/src/routes/sonarr.ts`. Three rules stay here, because
both bind from outside `backend/`:

- **One add per series, ever.** A terminal `SonarrPush` row (`pushed` or
  `alreadyHeld`) means that tvdbId is never considered again, so a deletion by
  Maintainerr or by hand is permanent *without us having to observe it*. The
  only intended second attempt is a **different** tvdbId arriving from a
  corrected identity. Do not add a "re-add if missing" path; that is the loop
  this design exists to remove.
- **The scope filter uses relations; the matcher must not.**
  `lib/sonarrSelect.ts` drops entries with a `PREQUEL`/`PARENT` edge to decide
  *what we auto-add* - this is not licence to reintroduce a relation heuristic
  into *identity*, where it was measured, found wrong, and removed (see *Measure
  before claiming*).
- **It must never trigger a cold AniList fetch.** It reads `SeasonCache` and
  serves a stale row happily; AniList's ~30/min budget is shared with every
  viewer.

Before turning it on, run `tools/sonarr_dryrun.py` (read-only, needs a local
admin token, no Sonarr credentials) or open **`/admin/sonarr`**, which adds what
Sonarr actually holds. Config lives in `AppConfig` (`sonarrUrl`, `sonarrApiKey`,
`sonarrTags`, `sonarrMarkerTag`, `sonarrRootFolder`, `sonarrQualityProfileId`,
`sonarrSeriesType`, `sonarrSeasonFolder`, `sonarrPushEnabled`). The client (`lib/sonarrApi.ts`)
exports exactly **one write verb, `addSeries`** - no delete, no update, no
exclusion write. We never remove anything; Maintainerr owns cleanup.

**Why this is a push and not the Custom List it used to be.** A Custom List is a
declarative set that Sonarr reconciles every ~5 minutes, so anything deleted
from Sonarr came straight back for as long as its season stayed in scope, and no
achievable snapshot interval could catch it. Retiring entries from the list
instead would have been worse: Sonarr's global `listSyncLevel` unmonitors
library series that fall off every import list, so correctness would have hinged
on a setting we do not own. The full argument is `lib/sonarrPush.ts`.

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

The mechanism behind these rules - the resolver, its search ladder, the sweep
and its pacing - is in **`backend/CLAUDE.md`**. Four rules stay here, because
each one binds from outside `backend/`:

- **Bump `RESOLVER_VERSION` whenever a change would decide a stored row
  differently.** That is the entire trigger for re-grading rows already stored;
  without it a matcher fix heals only new lookups and every old suggestion
  stands as it was.
- **Don't reintroduce a title or relation heuristic without re-measuring.** The
  `isRelation` guard was built from four eyeballed samples and would have
  rejected a correct match - the story is in *Measure before claiming* above.
- **skyhook is someone else's free service.** Calls are paced, bounded per run,
  degrade to the Jellyfin path, and **never appear on a viewer's request
  path**.
- **A human decision - confirmed or rejected - wins over everything**, so a
  mistaken Reject is permanent until cleared on `/admin/matching`.

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

#### Matching internals - how identities get made

The resolver (`lib/remoteIdentity.ts`), the film index that keeps films from
being matched against TV series, and why identification comes from
`tvshow.nfo` rather than folder names are all in **`backend/CLAUDE.md`**.

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
bursts - it must not eat the general budget). `/api/sonarr` deliberately adds
**no** limiter of its own and inherits `generalLimiter`, which is now trivially
sufficient: nothing polls it. It was sized against Sonarr's hardcoded ~5-minute
Import List Sync (Sonarr#5927 - **not** the 6 hours an even earlier version
claimed); with the list replaced by a daily push and an admin page, the traffic
is a handful of requests a day.

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

Every table and column, and why each cached row is persisted, is in
**`backend/CLAUDE.md`**. Two rules stay here, because both bind from outside
`backend/`:

- Production does **not** run `prisma migrate`. The raw SQL in
  `ensureDatabaseSchema()` (`backend/src/index.ts`) is authoritative at
  runtime, so a new column has to land there as well as in
  `backend/prisma/schema.prisma`.
- The `SubtitleCache.modelName` rank table lives in **three** places -
  `backend/src/lib/subtitleReport.ts` (the one TS copy, imported by
  `routes/translate.ts`), `backend/scripts/batch_translate.py` and
  `tools/local_translate.py`. A missing `large-v3-split` in any one makes that
  path treat champion output as rank 0 and reprocess it for nothing.

## Frontend Service

`frontend/` - Svelte 4 + Vite + TypeScript + Tailwind (DaisyUI), entry
`src/main.ts` -> `App.svelte` (client-side router).

- Dev: `npm install && npm run dev` (Vite dev server on port 5173)
- Build: `npm run build` (static assets), Preview: `npm run preview`
- Pages (lazy-loaded in `App.svelte`): Home, Login, SignUp, ResetPassword,
  Randomize, Compare, and **four admin pages** - Admin (`/admin`, Connection),
  AdminMatching (`/admin/matching`), AdminSonarr (`/admin/sonarr`),
  AdminSubtitles (`/admin/subtitles`).
  **All four render inside `components/AdminShell.svelte`**, which owns the
  `<main>`, the `Admin` heading, the tab strip and the admin gate (the `isAdmin`
  flag on `/api/jellyfin/status`, `stores/jellyfin.ts`). Put page-specific
  chrome in the page and shared chrome in the shell: the three had drifted into
  three different widths and one of them had no heading or gate at all, which
  read as three separate areas of the app.
  **`/admin/matching`** is the human end of the matching pipeline;
  **`/admin/sonarr`** is the human end of the Sonarr auto-add;
  **`/admin/subtitles`** reports the trailer subtitle pipeline (trailers only -
  Jellyfin episode subtitles are not covered). What each shows and why is in
  `frontend/CLAUDE.md`.
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
  challenge** - both batch translators download serially and abort on a
  challenge. Full rule in `.claude/rules/tools.md`.

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
