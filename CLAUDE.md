# CLAUDE.md — SaltyChart contributor guide

This is the canonical project guide for Claude Code sessions (and any other
agent) working in this repo. It covers working conventions, architecture,
API surface, and schema. Start here.

---

## Rules (read before making changes)

### Keep docs and comments in sync with code

Docs drift is a real bug — it misleads the next contributor. **Before
finishing a task, update the docs and comments your change makes stale.**

When your diff touches any of these, update the listed locations too:

- **New API endpoint** → update the endpoint list in the *Backend Service*
  section below (include auth requirements + rate-limit tier).
- **Removed / renamed endpoint** → remove it from that list; grep the
  frontend for callers and update them too.
- **New DB column / table / index** → update `backend/prisma/schema.prisma`
  **and** the raw SQL in `ensureDatabaseSchema()` in `backend/src/index.ts`,
  **and** the schema bullets in the *Backend Service* section below.
  Production does **not** run `prisma migrate`; the raw-SQL path is
  authoritative at runtime.
- **New user-visible feature or page redesign** → update `README.md`
  *Feature highlights* **and** the relevant page bullets in the *Frontend
  Service* section below.
- **Removed feature, dep, file, or component** → grep repo-wide for its
  name; kill stale references in source comments, JSDoc, `README.md`, and
  this file.
- **Changed default behaviour** (default sort, theme, flag, etc.) → search
  for docs or inline comments that named the old default.
- **New `AppConfig` key** → add it to the `AppConfig` bullet in the schema
  section. Everything in that table caches an upstream answer, and the reason
  each one is persisted (restarts are what generate the load) belongs with it.
- **Changed matching behaviour** → update *Matching AniList entries to the
  library*, re-run `check_match_corpus.py` (with `fresh` **and** `startDate`),
  and re-baseline the replay only after reading its diff. A matcher change that
  moves counts without a named cause is a regression until proven otherwise.
- **Quoted a measurement in prose** → say what it was measured over and when it
  would stop being true. `~55% coverage` and `~836 series` both survived here for
  months as live facts and were wrong by 40 points and 3x respectively.
- **Fixed something an exploratory pass found** → update
  `tools/tests/EXPLORATORY.md`. This file rots faster than any other doc here,
  because *fixing* a finding changes the behaviour the charter tells the next
  agent to expect — a pass-1 finding was withdrawn as a measurement error while
  the charter still instructed the reader to measure it that way, and a
  `file.svelte:36` reference was moved by its own fix within the hour. Past-tense
  the finding, say what the fix was, and correct any session step whose expected
  value changed (e.g. "availability calls must be exactly 1" became "1 on an
  aired season, 0 on an unaired one"). `test_audit_anchors.py` catches only the
  mechanical half — dead file paths and line-number references.

### Measure before claiming — and check what you measured

Every wrong conclusion in this repo's history has come from one of five shapes.
They are listed with the instance that produced them, because the abstract
version is easy to nod along to and ignore.

**1. A diagnostic that doesn't send what the real caller sends measures a
program you don't ship.** This has caused three separate wrong conclusions:

| omitted | what was actually being graded |
|---|---|
| `fresh` in `check_match_corpus.py` | the availability cache — a recording of an earlier run |
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
have rejected `Bananya Around the World → Bananya`, which is right (1 day off).
Season count "obviously" separating a spin-off from a sequel is false too —
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

**And two habits that aren't about measurement:**

- **Never pipe a long-running command through `tail`/`head`/`grep`** — it
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
  are the most rot-prone — verify each still matches reality.

### Secrets: the Jellyfin key leaves by more doors than you think

The API key is guarded carefully on the way to a browser — the stream proxy
**refuses** any manifest containing a credential, and `test_jellyfin` asserts it.
That guard was written for one door, and the key walked out of another: an axios
error carries its request `config`, so `console.warn('…', err)` printed
`Token="…"` into the backend log on any library-refresh timeout.

**Log `jellyfinErrorInfo(err)`, never the error object.** When adding a new
`catch`, ask where else the value could carry a header — logs, error responses,
telemetry, a message shown to a user.

Same instinct for **repo contents**: this repo is public. The match-replay
fixtures snapshot every title in the media library plus internal item ids, so
they are gitignored and built locally. Before committing generated data, ask what
it describes about the person running it.

### Style rules

- Comments explain *why*, not *what*. Delete redundant "increments X"
  comments when editing nearby code.
- Don't create new `*.md` files for ad-hoc notes unless the user explicitly
  asks. Canonical docs are `README.md` (user/deployer-facing) and this
  `CLAUDE.md` (contributor/agent-facing).
- Don't add date-stamped section headers ("Recent features (Month Year)")
  — they stale fast. Use evergreen wording.
- UTF-8 / box-drawing chars are used throughout existing docs — match the
  surrounding style.

### Pre-completion sanity checks

1. `cd frontend && npm run build` → zero a11y warnings, clean exit.
2. `cd backend && npx tsc --noEmit` → clean exit.
3. **Before building Docker images for deploy**: run the full pre-deploy
   suite (`tools/tests/run_all.py`) — see *Testing* section below.
4. Skim `README.md` and this file for stale mentions of the old behaviour
   and update them — including any **number** your change invalidates (step
   counts, mutation-row counts, corpus sizes, coverage percentages).
5. If you touched `shareCompare()` in `Compare.svelte` or `shareMyList()`
   in `WatchListSidebar.svelte`, manually verify the share button still
   exports a reasonable image — both functions are DOM-clone-heavy and
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

### Is the suite load-bearing? `tools/tests/mutation_audit.py`

A passing suite says nothing about what it would *catch*. This breaks one
invariant at a time and checks that the test guarding it actually fails:

```bash
py -3.13 -u tools/tests/mutation_audit.py           # every mutation
py -3.13 -u tools/tests/mutation_audit.py --only 3  # one, while iterating
py -3.13 -u tools/tests/mutation_audit.py --list    # the table
```

**Not** part of `run_all.py` — it edits tracked source and is slow. It refuses
to start on a dirty tree (it reverts with `git checkout --`, which would
otherwise eat uncommitted work) and restores everything in a `finally`. A row
may edit several files (`extra`), because a guard can legitimately live at more
than one layer; all of them are reverted.

What it established, each the hard way:

- **Red is not the same as covered.** Its first version counted any failing test
  as a catch and reported 10/10 — while four mutations were failing at an
  unrelated step and one had no assertion guarding it at all. Every row now
  declares the substring its failure output must contain; a red run that doesn't
  name the invariant is `WRONG REASON` and counted as a hole.
- **Red for the right *words* is still not enough.** Row 7 once "caught" its
  mutation with `only 0 of 12 sampled frames changed` — which is exactly what
  the *unmutated* build produced, because step 8 was broken. A row is only
  meaningful if the test is also known to **pass on clean code**; verify both
  directions when adding or repairing one.
- **Two real holes existed.** The Jellyfin API key stopped being stripped from
  the URL handed to browsers (`test_jellyfin` passed 10/10), and the
  AniList→TVDB match tier was disabled so every match silently fell back to
  fuzzy titles (10/10 again). Both are failure classes that have already
  happened in this repo.
- **A mutant must type-check, or it audits the compiler.** `if (false &&
  library)` narrows `library` to `null` inside the dead block, ts-node refuses
  to compile the file (TS18047), and node --test reports the whole test file as
  `ERR_TEST_FAILURE` without running one assertion — red, wrong reason, and the
  guard itself never exercised. The fix was a mutant that compiles clean
  (`tvdbId = tvdbId ?? null`) and was watched to fail naming its invariant.
- **A test that infers "not applicable" from the screen will skip exactly when
  it matters.** The library-unreachable flow decided "Jellyfin isn't
  configured" from an empty DOM (no status chip, no Hide button) and skipped —
  but a slow or broken render on a *configured* backend looks identical, so the
  full-audit run watched its mutation survive while the 55 other rows caught.
  Skip decisions now ask `/api/jellyfin/status` directly; only the backend can
  say which kind of nothing the page is showing — the same lesson `unknown`
  availability already taught, one layer up.
- **Six of fourteen rows once audited nothing.** `--only-steps` was added to cut
  transcode cost and quietly hollowed out what it was optimising: steps other
  steps depend on sat inside `want()` blocks, so selecting a later step skipped
  its setup and the run died before asserting. Anything a later step needs must
  be on the unconditional path. A crash is now reported as `CRASHED before
  asserting — <exception>` rather than the ambiguous `(no FAIL line)`, which is
  the difference between "unguarded invariant" and "broken harness".
- **The dirty-tree guard was itself broken for a while.** `dirty_paths()`
  stripped the whole `git status --porcelain` output, which removes the leading
  space from the *first* line only — so `l[3:]` ate a character of that path and
  it matched nothing. Whichever file sorted first was silently unprotected, and
  it reverted uncommitted work in `jellyfin.ts`. Don't strip porcelain output.
- **Settling is health, not a sleep or a PID.** Editing a backend file restarts
  ts-node-dev and so does reverting it. A fixed sleep raced it; watching for a
  new PID was worse, because a revert landing mid-restart is folded into the
  same cycle and the PID never changes again. It now waits for consecutive
  healthy `/api/health` replies after a grace period.

**Add a row whenever you add a test.** A test nobody has watched fail is a test
nobody should trust — and one that has only been watched to fail, never to pass,
is barely better.

### How often to run what

| when | what | cost |
|---|---|---|
| every push to master | `run_all.py --skip-burned-in` | ~4 min |
| after touching `tools/tests/`, or the code a row anchors to | `mutation_audit.py --only N` for the affected rows | 1–3 min |
| monthly, or before a large release | full `mutation_audit.py` | ~35 min |
| before subtitle work, when the GPU is free | `run_all.py` *with* burned-in | + GPU time |
| before a release, or after reworking Home/Randomize/Compare or a modal | an exploratory pass — `tools/tests/EXPLORATORY.md` | ~1 h, an agent in a browser |

The exploratory pass is the one that is **not** a script. Everything above
asserts a mechanism in isolation from a clean load, which is why the first pass
found a phone layout that hides the entire grid behind the My List panel, an
Escape key that closes nothing, and a "Server busy" message written for a human
that only ever reached the console. Its findings log doubles as the record of
what has already been looked at; anything it finds twice belongs in `run_all.py`
with a mutation row.

`run_all.py` is the deploy gate: push to master builds and ships, so it runs
every time. **That is a statement about pushes, not about work sessions — do
not run it as an end-of-task ritual.** A change is verified by its own
targeted tests plus the cheap static battery (tsc, frontend build,
svelte-check, `npm run test:unit`, `test_audit_anchors.py`); the full suite
runs once, immediately before a push. It takes ~15 minutes and `test_player`
starts real transcodes on the box that also serves Plex and Jellyfin — an
agent ran it three times in one evening during which nothing was deployed,
which is exactly the load this schedule exists to avoid. The audit is **not** a gate — it edits tracked source, restarts the
backend ~146 times (two per row, 73 rows) and starts real transcodes, which is not something to do
casually on a box that also serves Plex and Jellyfin. Measured on a full audit:
Jellyfin peaked at 314% CPU (ffmpeg, three cores) and the host at 45% of twelve.

The trigger for the audit is not a calendar, it is **"I changed a test, or the
code a row points at"** — that is exactly when a row rots, and `--only N` makes
checking one cheap. `test_audit_anchors.py` covers the rot that is detectable
without running anything, on every push; a real audit is still the only way to
find a row whose test has become vacuous.

**⚠ AniList rate limit while testing.** Requests are **anonymous, so the limit
is per IP** — AniList documents 90 req/min but has been **degraded to 30** for a
long time, and the whole home network shares one public IP. There is no API key
to raise it; only an OAuth token would give a per-user budget, and nothing here
has one. Three facts from their docs that the code now depends on:

- `X-RateLimit-Limit` / `X-RateLimit-Remaining` come back on **every** response,
  not just 429s. That is the real budget, and it is what pacing decisions read.
- `Retry-After` (seconds) and `X-RateLimit-Reset` (Unix seconds) come back **on
  a 429**.
- Exceeding the limit earns a **one-minute timeout**. There is also a separate,
  undocumented **burst limiter**.

**The bug that cost the most was retrying too soon, not asking too often.** The
backoff used to wait `15s * attempt` when a 429 carried no headers, so all three
attempts landed *inside* the 60 s lockout: the request spent 90 s failing and
returned an error anyway. A cold season load was measured hanging over three
minutes on a window that showed 13 of 30 requests still available.

Load is amplified by restarts, because the LRU and the in-flight coalescing map
die with the process — that part is fine, since losing them costs a SQLite read.
What mattered is that a *stale* row re-triggers its refresh on the first request
after every restart, and the mutation audit restarts the backend ~96 times a
run.

Rules of thumb:
- **Warm before a run, and *wait* for it.** `tools/tests/warm_cache.py` fetches
  the previous, current and next season in both format variants; `run_all.py`
  and `mutation_audit.py` both call it before their first test. Warming once
  carries a whole run — **provided the run fits inside the 6 h season TTL**
  (the proviso broke silently once as the audit grew; story at the TTL bullet
  below). A test run must never provoke a live AniList 429 — the 429/backoff
  logic is unit-tested (`anilistRateLimit`), off the network. warm_cache
  **retries rather than shrugging** — honouring `Retry-After`, up to
  `PER_KEY_BUDGET_S` (8 min) per key — and if a key still can't be fetched,
  **both runners refuse to start**. That is deliberate: a missing season doesn't
  make the suite fail, it makes it *pass vacuously*, because every fixture joins
  against an empty list and every assertion is trivially satisfied. That has
  already happened here once, when hardcoded fixture mediaIds aged out of the
  season and every seeded list silently matched nothing.
- Don't wipe `SeasonCache` more than once or twice per hour.
- When a season request suddenly takes minutes, check the backend console for
  `AniList 429` lines before suspecting the code — each one names the wait and
  which header produced it. `curl -i` the endpoint and read `X-RateLimit-Remaining`
  rather than guessing.
- Remember `format=TV` is a **separate cache key** from no-format, so Home's
  leftovers call and its main call are two independent fetches per season.
- Controls in place, all of which survive a restart because restarts are what
  generate the load:
  - **Backoff that matches the lockout** (`lib/anilistRateLimit.ts`, unit
    tested): `Retry-After` first, `X-RateLimit-Reset` second with a floor so a
    past timestamp can't cause an instant retry, otherwise a flat 60 s. Attempts
    are capped at **2** — waits are a full window each now, so attempts multiply
    directly into how long a request hangs. Raising that cap without redoing the
    arithmetic re-creates the original bug.
  - **Budget-aware background refresh** — `AppConfig.anilistRateLimit` holds the
    last observed `remaining`; below a floor of 8, optional refreshes stand down.
    A stale row is already being served, so standing down costs a viewer nothing.
  - **Per-key failure cooldown** — `AppConfig.anilistBackoff` maps a season key
    to the time it may next be asked about. Without it a failed refresh re-fired
    on the very next request and on every restart, which is what turned one 429
    into a storm. A blocking fetch inside a cooldown returns `503 UPSTREAM_ERROR`
    immediately instead of holding the connection open.
  - Cold fetches coalesced per season; expired rows served stale while
    refreshing in the background.
- The TTL is a flat **6 hours**, bounded on both sides. Pinning a finished
  season for *days* on the grounds that it "cannot change" is a guess about
  AniList's data that is not ours to make — entries do get added and corrected
  after a season ends. But the original flat *hour* set the background-refresh
  frequency that fed every 429 storm here: the mutation audit grew from 18
  rows (~35 min, inside 1 h) to 57 (~90 min, outside it), and its last half
  hour re-fired a stale refresh on each of its ~114 backend restarts.
  Serve-stale means the TTL adds no viewer latency at any value — it only
  sets how often AniList gets asked — so 6 h buys ~6× less upstream traffic
  for one visible cost: a newly added show takes up to ~6 h to appear.
- `stores/season.ts` exports `getCurrentSeasonFromAPI()`, which calls
  `graphql.anilist.co` **directly from the browser** — invisible to every
  control above, because the backend never sees it. It currently has no callers.
  Don't wire it up; route it through `/api/anime` if the need returns.

Suite includes:
| File | Covers |
|---|---|
| `test_season_lookahead.py` | 50-day next-season cutover logic (`LOOKAHEAD_DAYS`; regression for the "X days till" bug, and for the 76→50 move itself) |
| `test_api_smoke.py` | 13 happy-path API steps: health, auth, list CRUD (PUT/GET/watched/hidden/rank), anime + cache hit, public-list endpoints, options round-trip, /api/users |
| `test_api_negative.py` | 11 negative paths: signup missing/dup, password reset round-trip, missing/malformed JWT, validation errors, /translate/check shape, admin endpoint auth gates, and a **correctly signed JWT carrying no `id`** — which used to hang the request forever instead of returning 401, so the short timeout *is* the assertion |
| `test_frontend_smoke.py` | 5 frontend routes render (Playwright) including auth-gated pages |
| `test_ui_interactions.py` | 25 flows: nine button-click smoke (login → modal Escape), then one guard per silent-failure class found by the audits and exploratory passes — Compare ranks checked against seeded orders, no API key in /admin's DOM, `unknown`/`notAired` never hide, share-image has real content, per-section progressive loading, a visible unreachable-library / hung-backend / failed-hide-rollback, the /admin/matching resolver-accept + match-dropdown + Run-sweep-button contract, check-batch chunking, in-band translation errors, the phone sidebar default, guest options, the viewer's library picker (its write stubbed — a real pick rewrites identity for everyone). Seeds from live season data. Every flow's history and the trap it was watched to fail on: the file's docstring |
| `test_subtitle_paths.py` | Subtitle Paths B/C/D — YouTube CC, Whisper overlay, CC toggle persistence |
| `test_burned_in_detection.py` | Whisper large-v3 + OCR burned-in detection (Eren=yes, Sparks=no) — needs GPU |
| `test_match_replay.py` | Replays the shipping `matchSeries` (community-map ids only) over a frozen 8-season corpus — 945 real AniList entries × a 2,271-series library snapshot — and diffs every verdict against a committed baseline, in seconds with no network. Twelve real false positives asserted by name, and a named assertion matching no corpus entry is itself a failure. Fixtures are gitignored (they inventory the media library; this repo is public), so the test SKIPs where they haven't been built. Scope, privacy, and the re-baseline procedure: the file's docstring |
| `test_jellyfin.py` | 13 steps: auth/admin gates, `?token=` paths, availability shape, stream proxy + manifest credential-leak assertion, subtitle fetch and caching headers, no credential in `transcodingUrl`, at least one `matchedBy == "id"` (the id tier proven alive), a two-path round trip through the override table (an unheld id AND an outright rejection both flip a show to unavailable, invalidation proven in the persisted blob), films never falling through to series titles, Confirm keeping provenance, the admin lookup returning named, cross-walked, natively-TVDB picks, and a viewer pick that corrects a match but is refused (409) over an admin's decision. Live steps auto-skip when Jellyfin is unconfigured; cleanup always in a `finally`. Step-by-step history: the file's docstring |
| `test_player.py` | 10 steps driving the real player: pre-warm without an early stream, playback advances, one subtitle menu with a plain-English default, `[`/`]` speed steps with the bar hidden, burned-in subtitles verified in the pixels, 480p in exactly one restart, Escape stopping the transcode. Steps 1/2/3/5 are unconditional setup, step 8 reloads before the subtitles-off pass, step 9 stubs an `AbortError` — why each rule exists is in the file's docstring. Auto-skips when Jellyfin is unconfigured or nothing in the season is in the library |
| `backend npm run test:unit` | Pure helpers via `node --test`: `jellyfinApi` (a logged axios error never carries the API key; the auth header's `DeviceId`; the ESM SDK loads under CommonJS; the typed `DeviceProfile` is byte-identical to the hand-written one), `remoteIdentity` (the acceptance ladder and `pickCandidate` against the real measured pairs, `baseTitles` ordering, defensive premiere parsing, the miss-retry tiers incl. the >2y retirement, `retryStateFor`'s cooldown flip, `planSweep`'s cap/cooldown/retired selection incl. the drain override), `seriesIdentity` (the precedence ladder, `needsRemoteLookup`, and `needsRegrade` — stale-by-version, never a human decision, self-terminating; `isDateVerified`'s rung list), `skyhookIdentity` (`titleRelated` floors, season-premiere-only verification, undated-future-season, degrade-to-empty), the cross-provider candidate merge (id reference only — the title-merge mutant was watched to fuse two of Echo's three films), `episodeMatch`, `jellyfinFilmIndex` (the coalescing raced and was watched to fail), `animeMatch` (Unicode guards, positive-only guessed ids, the removed contains-tier's four pairs, `classifyMatch`'s four-way partition incl. the unheld-film category error), `libraryPick` (the viewer picker's ranking, and that an id-less library item is never offered), `anilistRateLimit` (the 60 s lockout arithmetic — the headerless rung was watched to fail at 15 s). Every assertion's story is commented at the assertion in its `.test.ts` |
| `test_rate_limits.py` | Every limiter carries `skip: () => _isDev`, so **not one is exercised** by anything else here — a limiter set to `max: 1` would lock everyone out and the suite would stay green. Boots a second backend in production mode on :3999 with its own throwaway SQLite file (two backends on one DB caused real lock contention mid-suite), exceeds 20/min on `/api/auth/login`, and asserts `429` + `{ code: 'RATE_LIMITED' }` + `RateLimit-*` headers |
| `test_audit_anchors.py` | Two doc-rot checks, both cheap enough to run on every push. (1) **`EXPLORATORY.md` cites nothing dead** — every referenced file exists, and no `file.ext:NN` line references, which move silently (one did, within an hour of being written). It cannot check the prose, so a pass here does not mean the charter is accurate — see the doc-sync rule above. (2) Every `mutation_audit.py` row still matches its source. A row whose anchor text has moved reports `SKIP`, which is easy to lose in a 35-minute audit and means that invariant is silently unaudited — batching the availability lookups moved the `unknown`-never-hides guard into another file and its row went on pointing at code that no longer existed. Runs in ~1.5 s with no servers, so it sits on every push instead of waiting for the next audit. **Catches only the cheap half**: six rows were once vacuous while every anchor resolved perfectly, and only a real audit run finds that |
| `test_svelte_check.py` | **`vite build` does not type-check `.svelte` script blocks** — a reference to an identifier that no longer exists compiles and ships, then throws at runtime inside a `try/catch` that degrades quietly. That shipped three times in one day (a deleted `let preparing`; a `.default` unwrapped twice; a renamed `repaintJassub` — the last two silently downgraded every ASS release to WebVTT). `svelte-check` catches all three. A **ratchet**, not a clean gate: 8 pre-existing type errors remain in unrelated components, so it fails only when the count rises. Lower the baseline as they are fixed; never raise it. It has already paid for itself twice over: typing an `apiJson<string[]>` call in Compare made it notice that `suggestions` had been declared `string[]` while every write put `{ value, label }` in and every read used `.value` — declaring it honestly cleared the new error *and* the two standing ones |

Final line on success: `Pre-deploy: 16/16 passed — ready to build` (15/15 with
`--skip-burned-in`). On failure:
`Pre-deploy: FAILED at step X — DO NOT deploy`. A run that can't warm the season
cache stops before step 1 with
`Pre-deploy: FAILED before step 1 — … the suite would test against missing data`,
and exits non-zero.

---

## Project Overview

SaltyChart is a two-service web application for discovering seasonal anime,
viewing summaries & trailers, and enabling authenticated users to build
and share custom rankings.

## Monorepo Layout

```text
SaltyChart/
├── backend/          # Express + TypeScript REST API
│   ├── src/lib/      # Pure, unit-tested helpers: animeMatch, anilistTvdbMap,
│   │                 #   seriesIdentity (our AniList→TVDB/TMDB overrides),
│   │                 #   remoteIdentity (Jellyfin→TMDB lookups for the gap),
│   │                 #   episodeMatch (shared air-date arithmetic),
│   │                 #   jellyfinFilmIndex (TMDB film id → item, coalesced + persisted),
│   │                 #   jellyfinApi (the @jellyfin/sdk client + DeviceProfile)
│   └── prisma/       # Prisma schema + SQLite datasource (nested prisma/data.db)
├── frontend/         # Svelte 4 + Vite + Tailwind/DaisyUI single-page app
├── tools/            # Python helpers: local_translate.py, benchmark_whisper_settings.py
│   │                 #   + bench_pipeline.py (swappable ASR/translate/align stages)
│   │                 #   + bench_player.py (Jellyfin playback startup timings)
│   │                 #   + bench_transcode_cpu.py (per-condition playback CPU:
│   │                 #     burn-in 5.9x realtime ~1.5 cores, remux 11.2x — reads
│   │                 #     the server's CPU from the mirrored syslog; sessions
│   │                 #     torn down by playSessionId, atexit-registered)
│   │                 #   + check_match_corpus.py (real-data library matching check)
│   ├── tests/        # Pre-deploy smoke/regression suite (run_all.py)
│   └── unraid/       # Reference copy of the update_saltychart User Script
├── .github/workflows/ # CI: deploy.yml (push→GHCR), build-base.yml (manual)
├── docs/superpowers/specs/  # Design specs (e.g. CI/CD deployment)
├── docker-compose.yml
├── README.md         # High-level overview & quick-start instructions
└── CLAUDE.md         # this file — contributor/agent guide
```

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
  `lastPage`, then pages 2..N are fetched with a concurrency-3 pool — a
  mid-season cold load is 6–12 pages and sequential round trips dominated
  its latency. Concurrent cold requests for the same season are coalesced,
  and an **expired `SeasonCache` row is served stale while a background
  refresh runs** — only a never-fetched season blocks on AniList)
- `/api/auth`            (login, signup, password reset, JWT issuance)
- `/api/list`            (user watchlist CRUD)
- `/api/public-list`     (public watchlist read-only)
- `/api/users`           (user management)
- `/api/options`         (per-user UI preferences)
- `/api/jellyfin`        (Jellyfin integration: availability, playback, streaming — see below)

Routes inside existing routers:

- `PATCH /api/list/watched`   — toggle watched / unwatched and record timestamp
- `PATCH /api/list/rank`      — update per-season *watchedRank* ordering
- `PATCH /api/list/hidden`    — toggle *hidden* flag (excludes an entry from the Randomize wheel)
- `GET   /api/list/users-with-nicknames` — users with at least one custom nickname (**rate-limited**, 60/min)
- `GET   /api/list/users-with-ratings?season=&year=` — users with any entry for a season; powers Randomize's nickname auto-check (**rate-limited**)
- `GET   /api/list/user-ratings?username=&season=&year=` — mediaIds a user has in a season (**rate-limited**)
- `GET   /api/list/nicknames?mediaId=` — nicknames & ranks for a given series (**rate-limited**)
- `PUT   /api/list` — replace entire list for a season/year in one shot
- `POST  /api/auth/reset-password` — reset a user's password by username; no auth required (intentionally low-security — no email, small friend-group app)

### Jellyfin integration routes (`/api/jellyfin`)

Requests go out through the **official `@jellyfin/sdk`** (MPL-2.0, zero deps).
`backend/src/lib/jellyfinApi.ts` owns the client: one memoized `Api`, one auth
header, one `DEVICE_ID`, the typed `deviceProfile()`. The route file keeps
caching, matching and proxying; only the wire calls moved. Why it was worth
it: the two costliest bugs here were *guessed fields* — a `DeviceProfile`
missing `videoBitRate` silently returned a 416x234 stream, and
`SubtitleProfiles: [{ Format: 'ass', Method: 'Encode' }]` (the field burn-in
turns on) was found by poking the API. Both are generated SDK types now; a
snapshot test asserts the typed profile is byte-identical to the hand-written
one it replaced.

Two packaging traps, both load-bearing:

- **The backend must use `module: CommonJS` + `moduleResolution: Node10`, not
  `NodeNext`.** The SDK's `.d.ts` files use extensionless relative imports,
  which ESM resolution can't follow — under `NodeNext` every nested SDK type
  degrades to `any` (measured: `Method: 'nonsense'` compiled clean), which
  defeats the entire point of the dependency.
- Importing it is `require()` of an ESM package → **Node >= 20.19** (the
  `engines` floor in `backend/package.json`; production runs 20.20.2).

**`/stream/*` is deliberately NOT on the SDK.** It replays the URL Jellyfin
itself chose (`TranscodingUrl`) with Jellyfin's own parameters; a typed
accessor would mean re-deriving them — the 416x234 mistake again. It stays a
raw `http`/`https` proxy (and `subtitleProxy` stays plain axios: byte pipes,
not JSON APIs).

The admin points SaltyChart at Jellyfin (URL + API key) on `/admin`; both live
in `AppConfig`. **The API key never reaches a browser** — availability
responses carry only ids and display strings, the stream proxy injects the
key server-side. This router mounts **before `compression()`** (the proxy
pipes HLS segments), so it carries its own limiters and JSON parser.

An API key authenticates but does not *identify* — and Jellyfin needs a user
to apply policy against: PlaybackInfo **silently drops `TranscodingUrl`** from
an otherwise-valid response when no user id is sent, which reads exactly like
a rejected DeviceProfile. So a **playback account** is picked on `/admin`
(`jellyfinUserId`, falls back to an administrator). Use a dedicated non-admin
account (this deployment: `SaltyChart` — verified the full player suite passes
non-admin) with library access and no bitrate/parental limits. Nothing is
written to its watch history: Jellyfin only records progress a client reports
to `/Sessions/Playing`, and this proxy never reports (verified:
`playCount=0, lastPlayed=never` after a day of repeats).

**"Direct stream" still runs ffmpeg and still writes to the transcode cache.**
Browsers can't play MKV, so every playback is remuxed into MPEG-TS for HLS —
cheap on CPU, identical on disk to a real transcode:

| mode | ffmpeg | re-encodes video | writes to transcode dir |
|---|---|---|---|
| direct play | no | no | no |
| **direct stream (remux)** ← what we do | **yes** | no | **yes** |
| transcode | yes | yes | yes |

Two consequences that have both bitten: Jellyfin's ffmpeg **writes segments
until the whole file is done regardless of the playhead**, and its cleanup
timers don't keep up for remux jobs (jellyfin#16608) — an abandoned session
leaves most of a ~1.4 GB episode on disk, which is why the pop-up pre-warm
never touches the HLS manifest and why `tools/bench_player.py` must not be
run casually (nine cold runs once filled the transcode cache and Jellyfin
served 0-byte segments — indistinguishable from an app bug). And keeping
subtitles out of the video avoids the third row, not the second.

Routes (contracts here; each guard's story is commented at its code):

- `GET  /status` — `{ configured, isAdmin }` probe (JWT). `isAdmin` rides
  along so the header's Admin link doesn't 403-spam an admin-only endpoint;
  fetched once per login by `stores/jellyfin.ts`.
- `POST /availability/batch` — `{ items: [{ mediaId, titles[], startDate? }] }`
  (max 100) → map of the single-route shape. Randomize asks about every wheel
  item in one request (was ~50 POSTs and 40% of this router's budget per page
  load). Shares `resolveAvailability()` with the single route; per-entry
  `unknown` preserved — one failed show neither contaminates others nor gets
  cached.
- `POST /availability` — `{ mediaId, titles[] }` → is the series in the
  library + the entry's season's first episode (season parsed from
  "Nth Season"/「第N期」; missing season = unavailable). Returns `{ available,
  seriesId, itemId, mediaSourceId, episodeTitle, seasonNumber, episodeNumber,
  libraryTitle, matchedBy }`. The series list is cached 1 h and served
  stale-while-revalidate (`getSeriesLibraryFresh` is the blocking variant for
  `fresh: true` callers). **`Fields=ProviderIds,OriginalTitle` is mandatory**
  on that query or Jellyfin returns `ProviderIds: null`, silently disabling
  the id tier. Per-mediaId cache 1 h positives / 10 min negatives, persisted
  to `AppConfig.jellyfinAvailability`. `fresh: true` bypasses the cache and
  re-resolves (library refetch throttled to one per 30 s — per-negative
  refetches once stampeded); it exists because a cache that survives restarts
  turned `test_jellyfin`'s id-tier proof into a recording. Always 200 —
  server down/unconfigured is `{ available: false, unknown: true }` (never
  cached). Carries **`idConfident`** — do we actually KNOW which show this is:
  a community-map id, a human decision, an admin's manual override, or a
  resolver id a DATE vouched for (`isDateVerified` — the air-date,
  premiere-date and TVDB-season-premiere rungs, and deliberately NOT `exact
  title` or `release year`, the Echo and coincidental-sibling classes). It
  gates the viewer's correction picker, and `unverified` follows the same rule
  so the pop-up's "⚠ unconfirmed match" can't fire on a row /admin/matching
  renders green. **A viewer pick is NOT confident**: it is unconfirmed by
  construction and queued for review, and treating it as settled hid the
  picker — and the undo inside it — the instant someone used it. Verdicts
  cached before the field existed lack it and read falsy until they expire.
  **`unknown` is load-bearing**: "couldn't ask", not "not in the
  library"; every consumer must refuse to hide on it.
- `GET  /playback/:itemId` — one call: `playSessionId`, `mediaSourceId`,
  subtitle streams (with the file's own flags + codec), font attachments.
- `GET  /stream/*` — GET-only streaming proxy (JWT header or `?token=`).
  Forwards `Range`, destroys upstream on client disconnect. **Manifests are
  buffered and refused if they contain a credential** — Jellyfin embeds the
  caller's key into HLS subtitle rendition URIs, so never send
  `subtitleMethod=Hls`; this guard makes "the key never reaches a browser" a
  guarantee rather than a convention.
- `GET  /subtitles` — proxies Jellyfin's own conversion. `format=ass` is a
  pass-through of the original; `format=vtt` lifts `Region:` lines into the
  header (`liftVttRegions` — Jellyfin emits them after the header closes,
  costing a console error and a dropped cue; the lift is cheap because
  Jellyfin repeats placement on every cue).
- `GET  /attachments` — an embedded font. Off the playback path since burn-in
  (kept + tested: it is the only way to inspect what a release ships).
  **Indices are the file's own stream numbers** — they must come from
  `/playback` or every request 502s. Both this and `/subtitles` send
  `Cache-Control: private, max-age=86400` (immutable per item+index).
- `POST /playback/stop` — `{ playSessionId }`; tears the transcode down
  rather than leaving it to time out on a shared box.
- `GET/PUT /config` + `POST /config/test` — admin only. Read returns URL,
  `apiKeySet`, `userId` — never the key. On save, an empty key **and an empty
  URL** keep the stored values (the URL was once written unconditionally, so
  Save on a blank form replaced a working address with the placeholder); an
  empty `userId` is a real choice ("fall back to an administrator"). Test
  hits authenticated `/System/Info`, so green proves the key works, not just
  reachability.
- `GET /users` — admin only; ids + names for the playback-account picker.
- `GET /identity` — admin only; every override row.
- `POST /identity/resolve` — admin only; `{ mediaIds[], years?, titles? }` (max 200) →
  what we believe about each and where it came from. Pairs with
  `/availability/batch` on `/admin/matching`: that says *whether* a show
  resolved, this says *which id* and whether a human confirmed it. Unmatched
  rows carry `retry` (`eligible` / `cooldown` + `nextRetryAt` / `retired`,
  from `retryStateFor` — the tier arithmetic's one home) and `tier` from
  `classifyMatch` (`id`/`title`/`notHeld`/`noMatch`, the sweep's own
  classifier, so the admin panel's per-season and all-seasons rows agree by
  construction). `years` and `titles` are the optional mediaId-keyed maps those
  two computations need, sent by the page because nothing stored on a miss row
  records them. Carries `sweep` — the last resolver
  sweep's persisted summary (`AppConfig.remoteSweepStatus`), written at BOTH
  sweep exits because "ran and found nothing" must be distinguishable from
  "never ran"; a corrupt row parses to null, never a throw. `remaining` counts
  what future runs will actually process (cooldown and retired rows excluded —
  the first shape counted every unmatched entry, so it could never reach 0);
  `retired` counts old misses no longer re-asked.
- `POST /identity/sweep` — admin only; starts a **drain** sweep (per-run cap
  *and* retry cooldowns dropped, pacing kept) and returns `202 { started, running }`
  immediately — a drain over a cold-start backlog runs for minutes, so
  nothing awaits it; `_running` in `remoteIdentity.ts` is the concurrency
  guard, and progress lands in the `sweep` summary above. 503
  `NOT_CONFIGURED` / `IDENTITY_NOT_READY` when it can't start. Exists because
  a cold start (new deployment, 245-entry backlog) used to mean one container
  restart per capped run.
- `GET /library/search?term=` — **viewer-gated** (JWT only, no admin), the one
  exception among the identity endpoints. Ranks the cached library + film index
  for the Watch pop-up's picker (`lib/libraryPick.ts`); in-memory, no Jellyfin
  calls. Items carrying neither a TVDB nor a TMDB id are never offered — a pick
  is stored as an id override, so an id-less item cannot be pinned. It DOES use
  a contains tier, unlike `matchSeries`: a human is choosing, so hiding the
  right answer is the only real failure.
- `GET /library/image/:itemId` — **viewer-gated**, `?token=` like the stream
  and subtitle proxies because `<img>` cannot send a header. Proxies the
  library item's Primary poster (the key stays server-side as always), 404s a
  missing one so the picker needn't special-case it, cached a day. Posters
  exist because a franchise's entries differ by one word and the cover is how
  a human tells them apart.
- `POST /identity/unpick` — **viewer-gated**; `{ mediaId }` clears the override
  so the entry falls back to the automatic match. Same 409 guard as the pick:
  a human decision is never touched. A pick a viewer cannot reverse is worse
  than no pick.
- `POST /identity/pick` — **viewer-gated**; `{ mediaId, itemId }`. The ids
  written are read off OUR library row, never taken from the request. Refuses
  with **409 `ALREADY_SETTLED`** when the stored row is confirmed or rejected —
  nothing else guards those (`setIdentityOverride` upserts unconditionally), so
  without it a viewer could silently undo an admin's Reject. Stored as
  `source: 'manual'`, `confirmed: false`, `note: 'viewer: picked by <user>…'`;
  a new `source` value was rejected as it would need edits in seven places and
  still render as a community-map id. Invalidation is inherited from
  `onIdentityChanged`.
- `PUT /identity` — admin only; write an override. `rejected: true` means
  "not in the library" and suppresses title matching too. **Merged onto the
  stored row** (`mergeIdentityPatch`): an unsent field keeps its stored value
  (Confirm preserves resolver provenance), an explicit null still clears.
  Every identity write **invalidates that mediaId's cached availability, in
  memory AND in the persisted blob** (`onIdentityChanged`) — without the
  persist half, a restart inside the debounce window restored the
  pre-correction verdict from disk for up to an hour, and only the
  persisted-blob assertion in `test_jellyfin` step 11 can see it.
- `DELETE /identity/:anilistId` — admin only; removes + invalidates the same
  way.
- `GET /identity/lookup?term=` — admin only; the Sonarr-style lookup behind
  /admin/matching's search box. A name searches series-first via skyhook
  merged with Jellyfin's TMDB results (degrades to TMDB-only when skyhook is
  down); `tvdb:12345` / `tmdb:12345` resolves a pasted id (prefix required —
  bare digits are real titles: *86*). Results are completed both ways via the
  held library and the community-map cross-walk (this Jellyfin's own remote
  search returns TMDB ids only — measured on all 342 stored candidates),
  carry a `library` tag and a display `year`, and an unheld `tmdb:` paste is
  still named via the identify-by-ProviderIds search. Never on a viewer's
  path; reads only cached data.

### Matching AniList entries to the library

`backend/src/lib/animeMatch.ts` — pure, no I/O, unit-tested directly and
reusable. `backend/src/lib/anilistTvdbMap.ts` does the I/O half. The evidence
behind every rule below is preserved as comments at the guard it justifies —
this section states the rules and where each lives.

**Identity and availability are different questions**, and conflating them is
what made this code produce a new false positive every few weeks. Identity —
*which real series is this?* — is permanent; availability — *do we hold it
right now?* — changes on every grab or delete. `lib/seriesIdentity.ts` owns
the first; `resolveAvailability` (routes/jellyfin.ts) the second.

**Resolution order for identity: our override table → the community map → a
remote lookup we make ourselves → nothing** — and only then may titles be
consulted. The override table is an *overlay*, not a copy: the map already
answers 94% of TV correctly, so rows exist only for corrections,
confirmations, and entries the map never covered. Written from
`/admin/matching`; loaded into memory at boot.

**A known id is authoritative in BOTH directions.** If an id is known and no
library series carries it, that is the answer — `matchSeries` returns null
rather than falling back to titles. Graded blind over 8 seasons / 945 entries:
title-prefix matching was 60% precise, and **all 12 failures were a new work
matching its franchise parent while its real TVDB id sat unheld** — we knew
the answer and let the fuzzy matcher overwrite it. Season counts and title
shape were both tested as separators and refuted (`animeMatch.ts` comments);
**air date separates right from wrong by three orders of magnitude and
nothing else does.** Residual risk: a *wrong* id plus the show held under a
different id reads as "not in library" — zero cases in the corpus, and an
override row is the permanent fix.

#### Making the links nobody else has — `lib/remoteIdentity.ts`

The community map answers 94% of TV and **0% of the 292-entry gap**; the
upstream anime databases know 284 of those 292 but none carries a TVDB/TMDB
id. So we make the links from two keyless sources: **series go to TVDB first**
via `lib/skyhookIdentity.ts` → `skyhook.sonarr.tv` (Sonarr's own proxy: native
TVDB ids, plus per-episode air dates for seasons nobody holds yet — the
evidence class the held-library gate cannot produce); movies and skyhook
misses use Jellyfin's own TMDB remote search (Radarr's proxy was measured and
rescued zero movies, so no new dependency). skyhook is someone else's free
service: calls are paced, bounded per run, degrade to the Jellyfin path, and
**never appear on a viewer's request path**.

A sweep runs 90 s after boot and daily, reads entries from `SeasonCache`
(every cached season, however old — a first-ever lookup is made regardless of
age), and is bounded at **150 lookups per run** (the re-grade pass shares that
figure via `REGRADE_PER_RUN` — it carries correctness fixes now, not grooming,
and 40/day would take over a week to propagate one across a few hundred rows) — sized at ~one year's worth
of gap entries (measured: ~150 of a year's ~470 entries lack any map id), so
a season rollover clears in one run. The three maintenance passes
(legacy-row dating, `regradeStoredRows`, `fillTvdbGaps`) keep a smaller
40-per-run cap; they groom already-stored rows and nothing an admin waits on
depends on them. `POST /identity/sweep` (the *Run sweep now* button on
`/admin/matching`) runs the same sweep with **both the cap and the retry
cooldowns dropped** (`planSweep`'s `ignoreCooldown`) — a human pressing it is
not the daily budget, and without the override the button is a no-op on
exactly the state it exists for, since one sweep leaves every row cooling.
A drain also removes the re-grade cap, so one press propagates a matcher change
across every stored row. Retirement is *not* overridable: those entries aired
years ago and no upstream source has ever heard of them, so re-asking on every
press is the churn retirement removed. Pacing still applies; drain removes the truncation, not
the politeness. Cold starts once took eight container restarts at the old cap
of 40 — measured after: one click, 375 lookups, 11.5 min. Two selection rules were broken at first, invisibly
(the system just silently stops improving — both are commented at the code):

- A row recording *"we looked and found nothing"* must **not** shadow the
  community map — an id-less, unconfirmed, un-rejected row is bookkeeping,
  not an answer (`resolveIdentity`).
- The sweep selects on **`needsRemoteLookup`**, not "has an identity row" —
  the latter retired an entry on its first empty search and made the retry
  tiering dead code.

A human decision (confirmed or rejected) still wins over everything — so a
mistaken Reject is permanent until cleared on `/admin/matching`. Stored rows
are **completed in both id spaces** (`completeIdentityIds`: held item first,
community-map cross-walk second), because this server's remote search returns
TMDB only and a Sonarr user expects TVDB on series rows. Misses are recorded
and retried on a tier keyed to how close the entry is to airing (2 days
within ±1 year, 30 days within ±2, unknown year 14) — that is when records
actually appear. A miss whose entry aired **more than 2 years ago is retired**
(`retryAfterFor` returns Infinity, unit-tested): still unknown upstream after
that long means unknown for good, and re-asking monthly forever was budget
spent on lost causes. Retirement never blocks a *first* lookup, and a human
can still resolve a retired entry by hand on `/admin/matching`.

Three search rules, each measured (evidence in the module header):
**both search kinds are tried** (AniList's format does not predict how TMDB
files a work; +22 and it upgraded wrong matches to right ones); **the base
title is searched too** (+59 — and it also reaches *Babylon 5*, which is why
nothing is ever accepted on title alone; `baseTitles` strips season markers
before subtitles and only treats separator-looking separators as such —
`Re:Zero` must not collapse to `Re`); and **a guessed id is POSITIVE-ONLY**
(`idIsAuthoritative: false`) — it may add a Watch button, never remove one,
because many gap entries resolve by title today and a guess must not delete a
working match. The UI marks such matches `unverified`.

**Which candidate is offered is decided by air date too, not provider
relevance.** `pickCandidate`'s last rung sorts *exact* titles by premiere
distance rather than taking TMDB's first: Echo (premiering 2026-07-19) was
offered its 2023 namesake 1,012 days away while the 2026 film 46 days away sat
third in the list. Only the suggestion changes — nothing within tolerance
means the ladder still queues the row for review.

**A ladder or ranking change reaches rows already stored, via
`RESOLVER_VERSION`.** The sweep selects on `needsRemoteLookup`, so an entry
that already carries an id is never re-asked — which used to mean a matcher
fix healed only NEW lookups and left every old suggestion as it was (Echo kept
offering its 2023 namesake until its row was deleted by hand). Every write
stamps the resolver's version; `needsRegrade` selects machine-decided rows
carrying an id whose stamp is below the current one, and re-resolving stamps
them, so the pass drains and stops. **Bump `RESOLVER_VERSION` whenever a change
would decide a stored row differently** — that is the whole trigger. Human
decisions (confirmed/rejected/manual) are never re-graded, and id-less
bookkeeping rows belong to the main sweep's retry tier instead. Measured on a
deployment carrying 295 stale rows: one *Run sweep now* healed all of them in
~11 min and the next run selects none.

**Acceptance is decided by air date, not title confidence** (`verdictFor` —
the full ladder, its rungs, and the measured day-distance tables are its
JSDoc). The shape that matters: correct results land 0–31 days from the
AniList premiere, wrong ones 62–21,929, with nothing in between — and this
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
  523 d is the correct film — TMDB dates the theatrical release, AniList the
  broadcast).
- The release-year rung is **gated to movie-kind candidates in code** — for a
  series a ±1 production year is nearly free and an ungated rung wrote
  coincidental TV siblings in as accepted fact.
- `pickCandidate` applies the same evidence to title collisions (dated-within
  exacts by distance first — DIVE IN! shipped its 167 d sibling while the
  16 d one sat second in TMDB's popularity order).
- There was an `isRelation` guard rejecting results related to the entry; it
  was wrong and was removed (sequel→parent is *correct* — TVDB/TMDB put
  seasons inside one series). Don't reintroduce a title or relation heuristic
  without re-measuring.

**A viewer can correct a match from the Watch pop-up**, and it is remembered
for everyone: the pop-up is where a wrong match is actually noticed, and
`/admin/matching` — where it could be fixed — is a page nobody visits. The
picker offers held library items only (a resolver candidate is usually
something we DON'T hold, which is why the row is unverified), the pick writes a
`manual` row carrying a `viewer:` note, and that note puts it in the admin
review queue as *Viewer pick* with Confirm/Reject. A human decision always
wins — see `POST /identity/pick`.

**The same show found in both providers becomes ONE candidate, merged on an
id cross-reference — never on a title.** TVDB and TMDB answer the search
separately, so a work both know arrived as two identical-looking options and
only one id was ever stored (`Chikyuu Daisuki! Kikkun`: TVDB undated, TMDB
dated on the entry's premiere day). skyhook's *show* record carries TVDB's own
`tmdbId`, and that request is already made for the season-premiere check — the
field was simply being discarded. `mergeCrossReferencedCandidates` collapses a
TVDB-only candidate into a TMDB-only one only when that reference points at it,
keeping the TVDB side as the base and taking the date. Measured after: Chikyuu
stores both ids, drops from two candidates to one, and leaves the review queue.
**Merging on matching titles would be actively wrong** — Echo's three
candidates are all titled exactly "Echo" and are three different films — and
the guard is a mutation row. A duplicate *within* one provider (Cyborg 009:
Nemesis exists twice in TVDB, one copy undated) is NOT merged: nothing proves
the two are the same show, so it stays in review.

**The top five candidates are kept, not just the winner** (TMDB orders by
relevance; the tail past five is noise — commented at the `slice` in
`searchOne`), stored as JSON on `SeriesIdentity.candidates`; `/admin/matching`
renders a picker defaulting to the resolver's choice, and a multi-candidate
row stays in review even when the air-date gate accepted it. Every resolver
row shows provenance — an `our lookup` badge plus the rung that accepted it —
because an id we guessed is not the same kind of fact as one from the map.
Accepts decided on title text or release year alone stay reachable behind the
"+ resolver accepts" filter (deliberately not in the default queue; their
being *invisible* was the audited bug). Rows stored before candidates carried
premiere dates are re-graded by a capped, self-terminating sweep pass
(`regradeStoredRows`); it never touches confirmed/rejected/manual rows.

#### Films are resolved against films — `jellyfinFilmIndex`

`getSeriesLibrary` fetches Series only, so a film's id could never match and
the lookup used to fall through to title-matching TV shows — measured: **26
category errors** (`The Last Blossom → House`) against 1 lucky hit, and 7
held films unreachable. A `movie`-kind identity now resolves via a TMDB-id →
item **index** (`lib/jellyfinFilmIndex.ts` → `AppConfig.jellyfinFilmIndex`,
6 h TTL, persisted, stale-while-revalidate, warmed at boot). Deliberately an
index and not a second matchable corpus: films are only ever looked up by id,
so titles are never compared — the error class is removed, not re-tuned. Its
cold-path coalescing is unit-tested (check-and-set with nothing awaited
between; the first shape raced and was watched to fail). **When the film
isn't there, that is the answer** — no title fallback; `finishEpisode`
already returns the right shape for a movie item.

#### The two availability tiers — both permanent

1. **id** — AniList id → TVDB id (community map from `Fribb/anime-lists`,
   ~7.2k pairs, cached in `AppConfig`) → a library series carrying that id.
   **Nothing on the request path waits for the map**: it is refreshed at boot
   and daily with `If-None-Match` (usually a 304), never awaited by
   `resolveAvailability` — a viewer used to pay for the whole 7.5 MB download
   after a restart (fixed: 110 ms, id tier recovers ~8 s later in the
   background). `rememberAvailability` refuses to cache until
   `anilistTvdbMapReady()`, or a title-only answer computed before the map
   loaded gets pinned for an hour. **TMDB rides along**: `themoviedb_id` in
   the map is an object (`{"tv": N}` / `{"movie": N}`), never a scalar —
   parsing it as one stringifies to `"[object Object]"` and silently yields
   zero — and the kind is stored with the id (`tv:123`) because TMDB numbers
   films and shows independently. It adds only 3/945 TV matches but is the
   only usable id for movies, and it makes the id tier redundant to a single
   nulled column.

2. **title** — the Unicode-aware fuzzy matcher: NFKD, strip diacritics, keep
   letters/digits of **every** script, then exact > prefix with length/ratio
   guards. Consulted only when **no id is known at all** (65 of 945 corpus
   entries — nothing else could find them). Do not "simplify"
   `normalizeTitle` to `[a-z0-9]`: that reduced a native-script title to
   `"3"`, which matched *30 Rock*. **There is no contains-anywhere tier**:
   the one that existed fired 9 times over 6 seasons and was wrong all 9,
   structurally (no threshold separates the pairs — evidence and the four
   fixture pairs live in `animeMatch.test.ts`, watched to fail with the tier
   restored).

The id tier finds a strict **subset** of what titles find; its value is
**confidence**, not reach. Coverage is uneven by *format*, not season age:
94% of TV entries have a TVDB id (81% even mid-season) but ONA is 40%,
TV_SHORT 32%, MOVIE 3%, OVA 1%. The response says `matchedBy`; the pop-up
marks title-only matches unconfirmed; bulk actions refuse to act on them.

#### Jellyfin identification is controlled by `tvshow.nfo`, not folder names

The Anime library reads local metadata first (`LocalMetadataReaderOrder:
['Nfo']`, always on — the "Metadata savers" checkbox is the *opposite* thing:
it makes Jellyfin WRITE NFOs, which fights Sonarr; leave it empty), and its
remote fetchers are disabled, so the NFO is effectively the only source of
identification. Sonarr → Settings → Metadata → **Kodi (XBMC) / Emby** writes
those files and refreshes them on its daily scan; Radarr ditto for movies.
Enabling it + Refresh Series backfilled 833/836 anime folders and dropped
stored-id/NFO disagreements from 46 to 0, fixing shows matched to entirely
wrong series. No folder renaming, no watched state touched.

Folder-name id tags are a red herring here, but the syntax differs by server
and is worth knowing: **Plex** reads `{tvdb-12345}` (curly, no `id`) plus
`.plexmatch`; **Jellyfin** reads `[tvdbid-12345]` (square, with `id`) and
ignores `.plexmatch`. This library's folders mostly carry `[tvdb-12345]`,
which matches *neither* — those tags do nothing on either server.

**When measuring any of this, compare ids (not names), scope to the seasons
the app shows, and send what the real caller sends.**
`tools/check_match_corpus.py` measures the thing that counts — how a real
season resolves end to end — and it sends `fresh: true` AND `startDate`
because each omission produced a wrong conclusion (the rows in *Measure
before claiming* above): without `fresh` it grades a recording of an earlier
run; without `startDate` the air-date tier is silently disabled and it
reports false positives the real frontend never shows (20 vs 12 measured).

### Rate limiting

A 120 req/min per-IP `generalLimiter` covers all routes. `/api/translate/*`
mounts before `compression()` (SSE can't be buffered), so the limiter is
applied explicitly on that mount — `app.use('/api/translate', generalLimiter,
translateRouter)` — rather than relying on the later global `app.use`.
`/api/auth/*` has a stricter 20 req/min limiter. The 4 unauthenticated
`/api/list/*` endpoints above additionally sit behind a 60 req/min
`publicListLimiter`. `/api/jellyfin` also mounts before `compression()` and so
carries its own limiters: 120 req/min for the JSON endpoints and a separate
**600 req/min** for `/api/jellyfin/stream/*`, `/subtitles` and `/attachments`
(HLS playback is a playlist refresh + a segment every few seconds plus seek
bursts — it must not eat the general budget).

### Error response shape

Every error is `{ error: 'human message', code: 'CODE_NAME' }`. Codes
include `BAD_REQUEST`, `UNAUTHORIZED`, `INVALID_CREDENTIALS`,
`INVALID_TOKEN`, `USER_NOT_FOUND`, `USER_EXISTS`, `ADMIN_REQUIRED`,
`BATCH_RUNNING`, `RATE_LIMITED`, `UPSTREAM_ERROR`, `SERVER_ERROR`.
Frontend code reads `data.error` (unchanged from before the unification)
and may branch on `data.code` for programmatic handling.

### Translation routes (`/api/translate`)

- `GET /api/translate/check-batch?videoIds=id1,id2,...` — bulk DB lookup for English sub status (up to 100 IDs); returns only confirmed positives; queues background Python checks for uncached IDs
- `GET /api/translate/check?videoId=&mediaId=`  — checks English subs + subtitle dismiss state; cached
- `GET /api/translate/stream?videoId=&mediaId=&start=` — SSE subtitle stream; serves from cache on repeat plays. Optional `start=<sec>` begins transcription at the viewer's playhead (live CPU savings); `start>0` runs are partial and not cached
- `PATCH /api/translate/dismiss?videoId=`       — persist subtitle on/off preference; no auth, all users
- `POST /api/translate/upload`                  — upload pre-translated subtitles; admin only, respects model rank
- `DELETE /api/translate/cache?videoId=`        — delete a cached translation; admin only
- `POST /api/translate/batch`                   — trigger batch pre-translation; admin only, JWT required
- `GET /api/translate/batch/status`             — batch job progress/logs; admin only

Both check and stream query `SubtitleCache` first. On a hit, `/stream` sends a
`{cached: true}` SSE event then all segments instantly (~50 ms); on a miss the
daemon translates and caches on completion, and concurrent requests for the
same uncached video are deduplicated. `/check` returns `{hasEnglish,
subtitlesDisabled, hasCachedSegments, modelName}` — the first two hide the
overlay; the last two tell the local script whether to re-translate. Dismiss
state comes from the CC toggle and persists for all users.

YouTube caption control — three paths in `openModal`
(`AnimeGridTranslate.svelte`), driven by a page-load pre-fetch: `Home.svelte`
fires `check-batch` right after the anime list loads (~5 ms, DB-only) into
`prefetchedSubs` + `prefetchComplete`, passed as props to each grid.

- **A — confirmed English** (`prefetchedSubs.get(id) === true`): instant, no
  network; YouTube CC starts in English, translation never runs.
- **B — batch complete, not in map**: iframe opens immediately, Japanese CC is
  suppressed, translation starts; `/check` re-fires async and switches to
  YouTube English CC if Python has since confirmed it.
- **C — batch not yet complete** (clicked within ~5 ms of load): races
  `/check` against a 150 ms timeout, then behaves like B.

`check_subtitles()` uses `ytt.list(videoId).find_transcript(['en'])`, which
sees manually uploaded, auto-generated AND auto-translatable English CC (the
old `ytt.fetch(languages=["en"])` found only manual tracks).
`SubtitleCache.hasEnglishSubs` trusts positives forever and negatives for
**7 days** (`lastEnCheckAt`), so newly added CC is eventually noticed without
re-checking every play; a cache write never downgrades a stored true.
`youtube_transcript_api` must be installed locally (`pip install
youtube-transcript-api`) — without it every check silently returns false.

On-demand translation is a persistent Python daemon
(`backend/scripts/translate_daemon.py`, Whisper `small` int8); batch
pre-translation (`backend/scripts/batch_translate.py`) uses `medium` and
auto-upgrades videos previously translated with `small`, and also pre-checks
English subs so first play never spawns Python. The live path is CPU-only and
shares the box with Plex — **all tuning (nice, env knobs, single-ffmpeg-pass,
playhead start, the per-request timing line, the base-model VAD-poisoning
quirk) is documented in the daemon's docstring.**

**Benchmark / bake-off harness** — `tools/benchmark_whisper_settings.py`
composes swappable stages from `tools/bench_pipeline.py` (audio → ASR →
translate → align) so each layer A/Bs in isolation; suites, the real-CC
corpus, metrics, result-file conventions, and the Windows environment gotchas
(torchcodec, qwen2.5, qwen-asr, kotoba) are all in its docstring. Data in
`tools/benchmark_data/` (gitignored); results consolidate into
`tools/benchmark_results.txt`, one delimited section per suite.

Findings that drive production settings (details in each bench's docstring):

- **Decode params**: `beam_size=10 + repetition_penalty=1.2 (+vad_min300)` is
  the best family for *transcribe*; the same params **hurt** end-to-end
  translate (e2e SCORE 1.0→−1.6) — they interact with the task, which is why
  only the fully-stacked run found the champion.
- **Demucs vocal separation helps** (~+6–8 SCORE, ~5–6 pp less hallucination)
  — but only from full-quality source audio, never the 16 kHz mono input.
- **Champion (`split_best`)**: vocals → large-v3 `transcribe` (tuned params) →
  **qwen3.5:9b** translate via Ollama, SCORE 1.9 vs 1.0 end-to-end, better
  timing and hallucination, more natural English; residual weakness is
  mis-heard proper names. (qwen3.5:9b beat text-only qwen3:8b — content 57.3
  vs 53.6 — so it's kept despite its unused ~1.2 GB vision encoder.)
- **Japanese-specialised ASR lost on this domain**: kotoba-whisper-v2.0 (51.3)
  and Qwen3-ASR (52.2) both under large-v3 transcribe (55.8) — clean-speech
  leaderboard wins don't transfer to stylized trailer audio.
- **Live CPU** (`bench_live_cpu.py`): `small` wins both axes; tiny/base are
  slower AND worse. Transcription is ~8× faster than playback at 1 thread —
  the felt latency is the audio download, hence playhead-start and the
  single-pass download, not model changes.
- **Download** (`bench_download.py`): the ~1.2 s `worstaudio` baseline is the
  floor — every player_client override failed or was slower, and aria2c -x16
  was ~20–28× SLOWER. The cost is YouTube's extraction handshake, not
  bandwidth; the bench exists to prove there's nothing to chase.
- **Player startup** (`bench_player.py`): everything except Jellyfin's first
  HLS segment is under 0.25 s (segment: median 19.9 s cold, range 1.3–30).
  Our proxy adds ~nothing (0.02 s), the first stream request leaves the
  browser ~65 ms after the click, and pre-loading more cannot help. Two fixed
  non-inherent findings: a 30 s proxy idle-timeout that killed slow-but-working
  streams, and an `await` on the Cast SDK between click and manifest. Two
  methodology rules learned here: stop each run's encodings before timing the
  next (or you measure your own load), and measure the fonts the app actually
  sends, not the first N attachments.

The backend auto-scheduler (`index.ts`) runs the medium batch on Wednesdays
2–4 am when the next season is within **50 days** (once per Wednesday,
`--cutoff 10`); the local large-v3 GPU script runs every Sunday and covers all
3 seasons first, so the Wednesday batch is its fallback. A batch run covers
**only the displayed season** by default (one season's downloads per run avoids
the YouTube bot wall; `--all-seasons` restores the old sweep). Downloads are
sequential with `--download-delay` (default 5 s) and the run **aborts on a
bot-challenge** (`_is_bot_block`) instead of hammering on.

Chunking ramps 5 s, 5 s, 10 s, 10 s, then 20 s from second 0. On-demand uses
`beam_size=1, condition_on_previous_text=False` for speed; batch `beam_size=5,
condition_on_previous_text=True` for quality. All calls use
`word_timestamps=True` and take segment starts from `words[0].start`, which
kills the pre-speech lead-in. Subtitle timing syncs to the YouTube iframe's
`currentTime` and respects play/pause.

Python deps: `faster-whisper`, `yt-dlp`, `youtube-transcript-api`, system
`ffmpeg`. Both `small` and `medium` are pre-downloaded in the Docker image.

**Local GPU translation** — `tools/local_translate.py` runs the champion split
pipeline on this PC (requirements, pipeline, Ollama management, and fallback
behaviour are in its docstring) and uploads as **`large-v3-split`** (rank 6,
above plain `large-v3`, so older results auto-upgrade on the next run; use
`--force` to re-do everything). Operational facts that live nowhere else:

- Phase-1 downloads are **serial** with a delay (`--download-delay`, 5 s) —
  parallel downloads tripped YouTube's bot wall, so `--download-workers` is
  ignored; a bot-challenge aborts the run. YouTube auth via `--cookies
  <cookies.txt>` (Netscape format; `--cookies-from-browser` fails on modern
  Edge/Chrome — App-Bound Encryption, yt-dlp #10927).
- Seasons process one at a time; long trailers sub-batch in the translator
  (≤20 lines per Ollama call) and untranslated lines retry.
- VRAM (10 GB): the season run is **phased** — separate-all (Demucs) →
  transcribe-all (Whisper, then freed) → translate-all — so only one model is
  GPU-resident (~6.4 GB peak vs ~9.8 co-resident) and each loads once.
  `run_phased()` owns this; the legacy per-video fallback path is Whisper-only.
- `large-v3-turbo` benchmarks comparable content with slightly more
  hallucination (suite `turbocmp`); it's ~4–8× faster via `--model` if speed
  ever matters.

**Windows Scheduled Task:** "SaltyChart Translate" runs `local_translate.py`
directly (NOT through `translate.bat` — editing the .bat does nothing to the
schedule) every **Sunday 5 am** via `py -3.13` against http://192.168.1.2:8085,
covering 3 seasons, skipping already-cached videos. Change args in Task
Scheduler → Properties → Actions → Edit (needs the Windows password; created
2026-04-08, LogonType: Password). The Sunday run ensures large-v3 completes
before Wednesday's medium batch.

### Database schema

Auto-created / updated at startup via raw SQL in `ensureDatabaseSchema()`.
Production does **not** run `prisma migrate`; keep
`backend/prisma/schema.prisma` and the raw SQL in `backend/src/index.ts`
in sync when adding columns/tables/indexes.

Tables / columns:

- `Settings` — per-user record storing theme, title language, autoplay,
  hide-from-compare, JSON columns `nicknameUserSel` and `subtitlePrefs`,
  and `addWatchedTo`.
- `WatchList.watchedRank` — integer; 0-based rank assigned after a show is
  watched and ranked in the Randomize page.
- `WatchList.hidden` — boolean; when true the show is skipped by the
  Randomize wheel.
- `AppConfig` — server-wide key/value config (`key` TEXT PK, `value` TEXT).
  Holds `jellyfinUrl` / `jellyfinApiKey`, written by the admin `/admin` page
  via `PUT /api/jellyfin/config`, plus `anilistTmdbMap` (AniList → `tv:N` /
  `movie:N`, the namespace kept because TMDB numbers films and shows
  independently), `anilistTvdbMap` / `anilistTvdbMapAt`
  (the cached AniList→TVDB id map, refreshed at boot and daily on a timer,
  conditionally via `If-None-Match`, never on the request path),
  `jellyfinLibrary` / `jellyfinLibraryAt` (the match corpus — 2271 series on this
  deployment; the "836" figure elsewhere in this file counts *anime folders*, not
  the library), `jellyfinFilmIndex` (TMDB film id → item, so a film is never fuzzy-matched
  against TV series), and
  `anilistRateLimit` / `anilistBackoff` (the last observed AniList budget, and
  per-season cooldowns after a 429), `jellyfinAvailability` /
  `jellyfinSourceDims` (the two per-item caches), and `remoteSweepStatus` (the
  last identity sweep's summary — persisted because "did the background
  resolver run, and what did it do" must survive the restart that follows a
  deploy, which is exactly when someone wonders; its `remaining` counts only
  what future runs will actually process, `retired` the old misses no longer
  re-asked, and `tracked`/`unmatched`/`cooldown`/`never`/`ready` plus `tiers`
  the whole-cache counts behind the admin page's all-seasons row. `tiers`
  (`id`/`title`/`notHeld`/`noMatch`) comes from `classifyMatch`, the *same*
  classifier `/identity/resolve` reports per row — so the panel's two scopes
  reconcile instead of being two computations that drift. It costs no provider
  calls: the library, the film index and the id maps are all in memory by the
  time the sweep runs). Everything in this table that
  caches an upstream answer is persisted for the same reason as the library:
  the load it guards against is *caused* by restarts, so an in-memory-only copy
  is empty exactly when it is needed most.
  The library cache is persisted because it used to be in-memory only: every
  restart refetched all of it with `ProviderIds,OriginalTitle`, so each deploy
  made the first viewer pay for it, and a development session with frequent
  reloads ran it dozens of times an hour — most of what drove the Jellyfin
  server process to ~800% CPU. Refresh is incremental where it safely can be:
  a `TotalRecordCount` probe (`limit: 0`, so no items are serialised) detects
  additions and removals, and when the count is unchanged only items matching
  `minDateLastSaved` are refetched and merged. Jellyfin does not return
  `DateLastSaved` on items, so the watermark is our own fetch time with a few
  minutes of overlap. A full refresh runs weekly regardless, because an
  incremental fetch can never reveal a deletion.
- `SeriesIdentity` — our AniList→TVDB/TMDB **overrides**: `anilistId` INTEGER PK,
  `tvdbId`, `tmdbId`, `tmdbKind` (`tv`|`movie`), `source`, `confirmed`,
  `rejected`, `pending`, `resolverVersion` (which resolver decided the row —
  `RESOLVER_VERSION` in `seriesIdentity.ts`; rows below it are re-resolved by
  the sweep's re-grade pass, which is how a matcher change reaches rows already
  stored, and stamping on write is what makes that self-terminating),
  `matchedTitle`, `note`, `year` (release year from whatever source named the identity — display only, never matched on; the sweep stores it at accept time, dates legacy rows via a capped remote pass each run, and the admin lookup/Confirm carry it through), `updatedAt`. `pending` marks a
row the remote resolver could not verify — it still counts (resolver ids are
positive-only, so they can only help) but it is what `/admin/matching` lists for
review. **`rejected` has to be its own column** — it
  means "definitively not in the library" and must suppress the *title* fallback
  as well as the map. Inferring it from "confirmed with no ids" is ambiguous,
  because confirming a good title match also leaves the id boxes empty; that
  ambiguity shipped and made Reject a no-op that still looked like it worked. An overlay over the community map, not a copy of it — see
  *Matching AniList entries to the library*. Written from `/admin/matching`;
  loaded into memory at boot because it is read on every availability lookup.
  A rejection short-circuits *before* matching, since it carries no ids and would
  otherwise fall straight through to the title tier — i.e. to the very match
  being rejected.
- `SubtitleCache` — `videoId` unique, `mediaId`, `modelName`,
  `hasEnglishSubs`, `lastEnCheckAt`, `subtitlesDisabled`, `hasBurnedInSubs`,
  `segments` JSON, `createdAt`. Caches check results, translated segments, and
  user subtitle preferences per YouTube video. `modelName` rank order (upload
  only upgrades to an equal-or-higher rank): tiny < base < small < medium <
  large-v2 < large-v3 < **large-v3-split** (the local champion pipeline). The
  rank table lives in **three** places — `backend/src/routes/translate.ts`,
  `backend/scripts/batch_translate.py`, and `tools/local_translate.py` — keep
  all three in sync (a missing `large-v3-split` in any one makes that path treat
  the champion output as rank 0 and needlessly reprocess it).

Performance indexes (added via `CREATE INDEX IF NOT EXISTS` at startup):

- `WatchList_userId_idx` — speeds `findMany({ where: { userId } })`
- `WatchList_season_year_idx` — speeds `/users-with-ratings`
- `Settings_hideFromCompare_idx` — speeds `/api/users`

`ensureDatabaseSchema()` also drops the retired `PlexSubtitle` table (it
cached WebVTT extracted from Plex media parts; Jellyfin serves subtitle
tracks directly, so nothing extracts any more).

The bootstrap logic will automatically create tables, add missing columns,
back-fill default `Settings` rows for existing users, and build the indexes
above idempotently on every start-up.

## Frontend Service

Path: `frontend/`

- Tech: Svelte 4, Vite, TypeScript, TailwindCSS (DaisyUI)
- Entry: `src/main.ts` → `App.svelte` (client-side router)
- Dev: `npm install && npm run dev` (Vite dev server on port 5173)
- Build: `npm run build` (produces static assets)
- Preview: `npm run preview`
- Pages (lazy-loaded in `App.svelte`): Home, Login, SignUp, ResetPassword, Randomize, Compare, Admin, AdminMatching (`/admin/matching`). The two admin pages share `components/AdminTabs.svelte`, gated to the admin user via the `isAdmin` flag on `/api/jellyfin/status` (`stores/jellyfin.ts`). **`/admin/matching`** is the human end of the matching pipeline — what needs review for a season, a per-row state verdict derived from the stored acceptance rung (so it can never contradict what verified the match), and a Sonarr-import-style match control where picking fills and only Confirm saves. Rows sort by display title (the API returns AniList id order, which reads as arbitrary), a *Run sweep now* button fires `POST /identity/sweep` and polls the sweep summary until the run finishes (status line only — rows never reload out from under a review), and the sweep status line reports `remaining`/`retired` honestly. A two-row table summarises at a glance — the season on screen and every cached season, sharing columns so the scopes are read by comparison and the numbers align by construction (two earlier tile layouts drifted out of alignment the moment one group gained a line the other lacked). Two header tiers because the data is two levels deep: `by id + by title + not in library + no match = entries`, and `never searched + ready to retry + on cooldown + retired = queued`. **`queued` is not a slice of the first four** — an entry with no id can title-match today and still be owed a lookup — and the legend under the table says so, because a reader asked which numbers were subsets of which and flat columns couldn't answer. Each unmatched row also captions its own standing ("auto-searched 2 d ago — retries in ~5 h"). Its full UI contract — filter modes, provenance rules, the changed-vs-untouched Confirm discriminator — is the header comment in `pages/AdminMatching.svelte`; the resolution rules it fronts are in *Matching AniList entries to the library* above.
- State: simple Svelte stores in `src/stores/` (e.g. `authToken`, `userName`)

#### Reading from the API — `src/lib/remote.ts`

**Every remote read goes through this.** Before it existed there were 23 silent
`catch {}` blocks and **zero** `AbortSignal` in the whole frontend, so any hang
was infinite by omission and any failure rendered as an empty page. That is what
made an outage impossible to diagnose: no timeout, no message, no retry, nothing
in the console. The audit that found it is worth repeating before adding a new
fetch — the question is not "does this work" but "what does the screen say when
it doesn't".

- `apiFetch(path, init?, { timeoutMs, retries, budgetMs, label })` — wraps
  `fetch` with `AbortSignal.timeout`, retries **network errors and 5xx only**,
  and `console.warn`s every failed attempt with its label. It **never retries a
  timeout**: retrying a slow-but-working server multiplies the wait, which turns
  one stall into three. `budgetMs` caps the total rather than letting attempts
  multiply worst-case.
- `apiJson<T>(...)` — the same, parsed.
- `createRemote<T>(label)` — `{ status, data, error, run, retry }` with the
  request-id staleness guard extracted from `Home.fetchMainSeason`, so a late
  response for a previous season can't overwrite a newer one.
- `ApiError { kind: 'timeout' | 'network' | 'http', status?, unreachable }` —
  callers need to tell "couldn't reach the server" apart from "the server said
  no", because they mean different things on screen. Compare's is the clearest
  case: a failed `/api/users` used to leave the picker empty *and* suppress the
  "No user named…" warning, so an unreachable backend was indistinguishable from
  a typo'd username.

**Timeouts are per call, never global.** A cold `/api/anime` was measured at
**186s** under AniList rate-limiting, so a blanket default would break season
loading; `SEASON` is 200s and `QUICK` (lists, options, users, availability) is
15s.

`Home.svelte` predates the helper and already does all of this correctly by
hand — it is the shape `createRemote` was extracted from. Converting it is a
later pass; it is the best-covered path in the suite and there is nothing to
gain tonight but consistency.

- The main anime grid (`AnimeGridTranslate.svelte`) handles trailer subtitles
  via `/api/translate`. If the video has YouTube English CC (checked via a
  batch pre-fetch on page load), YouTube CC is shown and no translation runs.
  Otherwise, Japanese CC is suppressed and Whisper-translated subtitles are
  overlaid. Subtitles sync to the YouTube iframe API's `currentTime` and
  support play/pause/scrub.

### Additional UI features (grouped by surface)

**Global *Options* modal** (gear icon in header). Persists in the `options`
store + `/api/options` when authenticated, `localStorage` for guests. Theme
(`LIGHT`/`NIGHT`/`SYSTEM`/`HIGH_CONTRAST`), title language, autoplay,
hide-from-Compare, nickname user picker.

**Season toolbar** (`SeasonSelect.svelte`): search box (client-side fuzzy),
Hide 18+, Hide sequels, Hide in "My List".

**Main Anime grid refinements**: My-List entries get a border highlight (not
opacity), 18+ badge, **progressive loading** on Home (each section gates only
its own fetch — skeleton shimmer per section, per-section error + Retry, one
failure never blanks the rest), covers blur-up (`coverImage.medium` blurred
under `large`, `fadeInWhenLoaded` in `AnimeGridTranslate.svelte`).

**Randomize page**
- Wheel spin: tick sound, confetti, spinner overlay while loading. Post-watch
  ranking via drag-and-drop persists to `WatchList.watchedRank`. Pop-up shows
  other users' nicknames + ranks (nickname endpoints).
- Hide controls: per-show context menu, plus **Hide All / Show All / Hide Not
  in Library** (the last only when Jellyfin is configured, using the batch
  availability cache). Invariants, each with its story commented in
  `Randomize.svelte` / `stores/jellyfin.ts`:
  * an `unknown` verdict is never acted on — it means "couldn't ask", and one
    slow moment must not empty the wheel;
  * `notAired` neither triggers hides nor lights the button — "can't exist
    yet" is not "confirmed missing";
  * title-only matches report `available: true`, so bulk-hide can only ever
    *keep* an unconfirmed match;
  * the library lookup has a visible state (`libraryStatus`: idle / checking /
    ok / unreachable → "Checking your library…" / "Can't reach the media
    server" + Retry) — an unreachable server used to render identically to
    "everything you own is in the library";
  * a failed hide write is put back (`writeHidden` returns the ids that
    didn't stick, `revertHidden` restores them and says so) — the one failure
    here that loses state rather than hiding information. This covers every
    hide path: the per-row eye toggle kept its own fire-and-forget fetch for
    months after the bulk paths were fixed, which is why the shared helper is
    asserted per-path, not once.
- "Nicknames from" panel auto-checks users with entries for the current
  season (`/api/list/users-with-ratings`), re-runs on season change; manual
  toggles reset on season change.
- When Jellyfin is configured, the show pop-up gains **▶ Watch here — SxEy**
  (`JellyfinPlayerModal.svelte`) plus a "Library: <matched title>" caption so
  a bad match is visible; title-only matches are marked **⚠ unconfirmed**.
  Season-aware: a "2nd Season" entry resolves to that season's E1 and is
  honestly unavailable if the library lacks it. A **"Not the right show?"**
  control — offered only when the identity is *uncertain* (a resolver guess or
  a title match), since a community-map id or a human decision needs no
  correcting. That keys off `idConfident` on the availability verdict, not on
  availability itself: the question is "do we know what this is", not "can you
  watch it", so an entry we're sure of shows no control even when the library
  doesn't hold it. Reading "Find it in my library" when nothing matched, it searches the
  held library and pins the entry to what the viewer picks — remembered for
  everyone and queued for admin review. It **replaces the pop-up body** rather
  than opening a menu inside it: `.modal-box` is its own scroll container, so a
  floating panel produced two competing scrollbars, clipped the results and
  pushed *Mark as watched* out of reach. The results list owns the only
  scrollbar and is bounded, so a long list scrolls in place. The AniList cover
  stays on screen beside it and each option shows its **library poster** —
  matching is a comparison, and hiding either side made it guesswork. It states
  what the entry resolves to now and tags that option `current`, so a viewer
  can tell a correction from a no-op. *Reset to
  the automatic match* undoes a pick. Enter belongs to the search box, not the
  pop-up's mark-watched handler (a window listener; the player guards the same
  way), and pick mode never survives the pop-up it belongs to. Logged-in viewers only: the write needs
  a token, and a control that 401s is worse than no control. Availability for all wheel
  items comes from **one `/availability/batch` request** through
  `checkAvailabilityMany()` (`stores/jellyfin.ts`), which omits any entry it
  couldn't definitely answer — so `?.available === false` refuses to act on
  an unanswered show.

**The player** (`JellyfinPlayerModal.svelte`) — a thin wrapper around
video.js 8, lazy-loaded in its own chunk; keep it that way. video.js owns the
control bar, menus, fullscreen, hotkeys, errors. The wrapper adds only: the
HLS source, the play-session lifecycle, the JWT on every request, and the
**`]` / `[` keys stepping playback speed by 0.10× across 0.2×–4.0×** — every
media server's own player is locked to coarser steps, which is why this
player exists. Speed keys don't count as user activity (the bar stays
hidden); `playbackRates` feeds the same steps to video.js's menu. Enabled
options: `skipButtons` ±10s, `enableSmoothSeeking`, `experimentalSvgIcons`,
`persistTextTrackSettings` (defaults seeded once).

- **Seeking is the browser's job.** Jellyfin's `main.m3u8` is a complete VOD
  playlist and the server repositions its own transcoder on an out-of-range
  request — there is no client-side reposition machinery. What remains is
  **recovery**: scrubbing races Jellyfin's segment cleanup (jellyfin#16608)
  and can wedge a session permanently, so the player rebuilds around a fresh
  `playSessionId` at most twice. Two distinct failures need two detectors —
  a stopped clock (10 s without `currentTime` movement) and a stopped *picture*
  with the clock running (`totalVideoFrames` frozen 8 s — reported from the
  field; a clock watchdog can't see it). The four load-bearing details
  (fresh PlaybackInfo, arm only after progress, reset `recoveries` on decoded
  frames only, re-baseline the frame count after restart) are commented at
  the watchdog in the component — each one was learned by watching an
  uncapped restart loop or a false recovery.
- **Subtitles are burned in by Jellyfin** (`SubtitleProfiles: [{ Format:
  'ass', Method: 'Encode' }]`), composited on the GPU with libass and the
  episode's own fonts. This replaced a client-side renderer whose every
  failure was silent (an opaque canvas over healthy video, a double-unwrapped
  `.default` downgrading ASS to WebVTT, empty frames reporting success) —
  pixels can be *tested*, which is what `test_player` step 8 does. Measured
  cost: +0.4 s first segment, 2–4× smaller segments, zero client code. What
  it costs: one re-encode generation, and a **stream restart** on any track
  or quality change (~1.1 s) — every Jellyfin client behaves that way.
- **Both control-bar menus restart the stream** (subtitles are in the picture,
  the tier is baked into the encode). Subtitle selection prefers a plain
  English dialogue track — `sdh|dubtitle|sign|song` set aside, ASS over SRT,
  the file's `default` flag only breaking ties (releases ship signs-only
  tracks marked default). **"Off" must be sent as `subtitleStreamIndex=-1`** —
  omitting the parameter makes Jellyfin pick a default and burn it back in.
  Quality: auto (the source's own ceiling, from a probe PlaybackInfo), 1080p,
  720p, 480p. A rebuild **stops the session it abandons** — before that,
  every track change left an orphan ffmpeg remuxing ~1 GB for nobody, and
  `/Sessions` can't reveal it (this proxy never reports playback, which is
  also what keeps it out of watch history). The two bugs that once made
  restart a no-op (replaying the same URL; the watchdog firing into the
  deliberate rebuild — hence `RESTART_GRACE_MS`) are commented at
  `restartStream()`.
- **Warm-up is two-staged** (`lib/jellyfinPrewarm.ts`): the video.js chunk on
  landing at `/random` (idle-callback, skipped on saveData/2G — Home browsers
  never pay for a player they don't open), and the episode's PlaybackInfo
  when the pop-up opens, cached by itemId+quality+track. **It never touches
  the HLS manifest** — a pre-started stream would remux a whole episode to
  disk for a pop-up nobody plays (jellyfin#16608 again). With both, Watch
  costs only the stream start (~2.4 s, of which ~1.7 s is Jellyfin's segment
  0). `loadVideoJs()` must stay shared — a private `import('video.js')`
  wouldn't be covered by the preload.
- The Watch button shows an "Opening…" spinner while the chunk loads — test
  player latency on something other than localhost before judging it.
  Nothing waits on subtitles any more; the only app-owned wait is the
  "Switching to…" indicator during a genuine rebuild. video.js's big play
  button is hidden while Jellyfin builds the first segment and reappears only
  on **`NotAllowedError`** (a real autoplay block needing a click);
  `AbortError` is routine interruption during rebuilds and must not show it —
  details at the `sc-autoplay-blocked` handling in the component.
- Picture-in-picture is disabled. Chromecast is wired
  (`@silvermine/videojs-chromecast`) but **cannot work over plain LAN HTTP**
  — the Cast SDK needs a secure context; serving HTTPS lights it up with no
  code change. The SDK is warmed on `/random` and never awaited (it is the
  one asset whose latency is someone else's internet).
- While the player is open, `handleModalKey` is suppressed so Enter can't
  mark-watched underneath. Playback runs under the configured playback
  account, so progress never syncs to a viewer's Jellyfin profile.

**Compare page** (mobile + desktop share the card layout)
- One card per anime: cover, canonical title de-emphasised, 3-column rank
  strip `[your rank | diff badge | other rank]`; custom nicknames are the
  primary typography.
- Sticky username bar pins `[you | other]` while cards scroll. Requires
  `html, body { overflow-x: clip }` in `app.css` — `overflow: hidden` creates
  a scroll container that breaks `position: sticky`.
- Unified controls: season/year row, then `{yourName}:` + pre/post on the
  left, `2nd user:` + combobox + pre/post on the right. Default sort is
  `rankA` (your ranking), not `diff`. Desktop caps content at the same
  `calc(100vw - 40rem)` 2cols cap as Home (an older note here claimed 50rem —
  the code says otherwise); heatmap legend + Share-as-image are desktop-only.
  Pre/post-watch order is toggleable per user independently.

**Misc**
- The header logo's `?` badge tooltip shows the deployed version — the
  `YYYYMMDD-<sha>` tag injected by CI (`APP_VERSION` build-arg →
  `VITE_APP_VERSION`); local builds show `dev`.
- First load uses a **50-day look-ahead** (`LOOKAHEAD_DAYS`,
  `computeInitialSeason()` in `stores/season.ts`): if the next season starts
  within 50 days it is shown instead. It was 76, which flipped the default
  two weeks after the current season's premieres — most of a season spent
  looking at one where nothing had aired.
- "X days until [next season]" derives locally from the browser date
  (`nextSeasonInfo()`; season starts Jan/Apr/Jul/Oct 1).
- Ctrl+Shift+R / Ctrl+F5 hard-reloads and resets the cached season selection;
  the last selected season/year is otherwise remembered for an hour.

## Prisma

Path: `backend/prisma/schema.prisma` (a legacy root-level `prisma/` folder
from the old SvelteKit prototype has been removed).

- Defines `User`, `WatchList` (with `watchedRank`, `hidden` columns),
  `Settings`, the two runtime caches `SeasonCache` / `SubtitleCache`, and the
  server-wide `AppConfig` key/value table (Jellyfin URL/API key + the
  cached AniList→TVDB map).
  `Settings.nicknameUserSel` and `subtitlePrefs` (JSON, read/written via raw SQL
  in `/api/options`) are now declared on the model too. `SeasonCache` /
  `SubtitleCache` are created & patched only by the raw SQL in `index.ts`; the
  Prisma models mirror them so `prisma migrate` doesn't flag drift (and offer a
  reset that would drop cached translations) and so the client is typed for them.
- Index declarations in the schema: `@@index([userId])`,
  `@@index([season, year])` on `WatchList`; `@@index([hideFromCompare])`
  on `Settings`. These are also created at runtime via
  `CREATE INDEX IF NOT EXISTS` so production doesn't need to run
  `prisma migrate`.
- SQLite datasource via `DATABASE_URL` (defaults to `file:./prisma/data.db`
  inside the container; locally the real DB is at
  `backend/prisma/prisma/data.db`).
- Run `npx prisma generate` after schema changes and mirror any
  column/index work in the raw SQL in `backend/src/index.ts`.

## Docker Compose

Compose file: `docker-compose.yml` (mirrors the production compose on the
Unraid server at `/mnt/user/appdata/saltychart/docker-compose.yml`).

- `backend` service: `ghcr.io/drohack/saltychart-backend:latest`, SQLite
  bind-mounted from `/mnt/user/appdata/saltychart/prisma` (a legacy
  `saltychart_db` named volume exists on the server but is stale since
  April 2026 — never point anything at it), exposes 3000 internally,
  health-checked before frontend startup. `JWT_SECRET` comes from an
  untracked `.env` (hardcoded directly in the server's compose copy).
- `frontend` service: `ghcr.io/drohack/saltychart-frontend:latest`, nginx
  serving on host port 8085.
- Local usage: `docker build` the images yourself (see Deployment below) or
  `docker compose pull && docker compose up -d` to run what CI published.

## Deployment (CI/CD)

**Push to `master` = deploy.** No manual builds, transfers, or GUI steps.

- `.github/workflows/deploy.yml` — on every push to master (ignoring
  `**.md`, `docs/**`, `tools/**`): gates on backend `tsc --noEmit` +
  frontend `vite build`, then builds and pushes
  `ghcr.io/drohack/saltychart-{backend,frontend}` tagged `latest` +
  immutable `YYYYMMDD-<shortsha>`. Single job; both images push together
  atomically after both builds succeed.
- `.github/workflows/build-base.yml` — **manual dispatch only**, takes a
  `version` input. Builds `backend/Dockerfile.base` →
  `ghcr.io/drohack/saltychart-backend-base:<version>` (~3.3 GB: python3,
  ffmpeg, pip deps, pre-downloaded Whisper small+medium).
- `backend/Dockerfile`'s runtime stage is `FROM` the **pinned** base tag, so
  routine deploys transfer only ~100 MB of app layers, never the models.
  **Rule: any edit to `backend/Dockerfile.base` requires dispatching
  `build-base` with a new version AND bumping the `FROM` tag in
  `backend/Dockerfile` to match** — the base is never rebuilt automatically.
- Pull side: Unraid User Script `update_saltychart` (cron `*/10`, reference
  copy `tools/unraid/update_saltychart.sh`) — `docker compose pull`; if a
  new image arrived it backs up the DB via the existing
  `backup_saltychart_db` script, then `docker compose up -d` + image prune,
  logging to `/mnt/user/appdata/saltychart/update.log`.
- The full pre-deploy suite (`tools/tests/run_all.py`) **cannot run in CI**
  (Playwright against live dev servers + GPU test) — run it locally before
  pushing to master (see *Testing* above).
- Data safety: the DB bind mount (`/mnt/user/appdata/saltychart/prisma`) is
  never touched by deploys, and every applied update is preceded by a DB
  backup. Backup/restore User Scripts snapshot the **live** DB via the
  SQLite online-backup API — reference copies in `tools/unraid/`. Rollback =
  pin compose to a previous `YYYYMMDD-<sha>` tag (+ `restore_saltychart_db`
  if needed).
- Design spec: `docs/superpowers/specs/2026-07-09-cicd-deployment-design.md`.
  README has the user-facing walkthrough incl. offline tar fallback.

## Common Workflows

Local development:
```bash
# One-time setup
cp backend/.env.example backend/.env   # provides DATABASE_URL for ts-node-dev
pip install youtube-transcript-api     # enables English CC detection locally

cd backend && npm install && npm run dev
cd frontend && npm install && npm run dev
```

Full stack via Docker Compose:
```bash
docker compose up --build
```

Backend codegen (Prisma): `npm run generate`

Production build:
```bash
cd backend && npm run build
cd frontend && npm run build
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
  (`routes/anime.ts`), on a flat 6 h TTL (see the rationale in *Testing* —
  serve-stale hides the TTL from viewers; it only sets AniList refresh
  frequency).
- Respect rate limits for the AniList API — retry/backoff, global pacing, and
  season-aware TTLs. **Anything added to reduce AniList load must survive a
  process restart**, because restarts are what generate the load in the first
  place; an in-memory counter is zero on every fresh process. Never call
  AniList from the browser, where no backend throttle can see it.

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
  engine loaded. `kill_stale.py` only frees the *ports* — stale ts-node-dev
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
