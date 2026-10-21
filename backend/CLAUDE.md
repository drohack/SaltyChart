# CLAUDE.md - SaltyChart backend

**Nested guide.** This file loads automatically when you work with files under
`backend/`. It holds the backend's reference material - the two route
subsystems, how identities are actually resolved, and the database schema -
moved out of the root guide so it is not paid for on every unrelated session.

The root `CLAUDE.md` stays authoritative for everything project-wide: the
working conventions, the measurement rules, the secrets rule, deployment, and
*Matching AniList entries to the library*, which states the matching **rules**
this file's *Matching internals* implements. Read it first; nothing here
overrides it.

Rules that bind from **outside** this directory deliberately stay in the root
file (or in `.claude/rules/tools.md` for `tools/`), because a rule that isn't
loaded when it matters is not a rule.

**One home per story.** Where a guard's evidence (the incident, the show, the
measurement) is already a comment at the code, this file states the rule and
names the identifier to read. Don't copy the story back in here.

---

## Jellyfin integration routes (`/api/jellyfin`)

Requests go out through the **official `@jellyfin/sdk`** (MPL-2.0, zero deps).
`backend/src/lib/jellyfinApi.ts` owns the client: one memoized `Api`, one auth
header, one `DEVICE_ID`, the typed `deviceProfile()`. The route file keeps
caching, matching and proxying; only the wire calls moved. The two costliest
bugs here were *guessed fields* (a `DeviceProfile` missing `videoBitRate`
returned a 416x234 stream; the burn-in `SubtitleProfiles` shape was found by
poking the API) - both are generated SDK types now, and a snapshot test pins
the typed profile byte-identical to the hand-written one it replaced.

Two packaging traps, both load-bearing:

- **The backend must use `module: CommonJS` + `moduleResolution: Node10`, not
  `NodeNext`.** The SDK's `.d.ts` files use extensionless relative imports,
  which ESM resolution can't follow - under `NodeNext` every nested SDK type
  degrades to `any` (measured: `Method: 'nonsense'` compiled clean), which
  defeats the entire point of the dependency.
- Importing it is `require()` of an ESM package -> **Node >= 20.19** (the
  `engines` floor in `backend/package.json`; production runs 20.20.2).

**`/stream/*` is deliberately NOT on the SDK.** It replays the URL Jellyfin
itself chose (`TranscodingUrl`) with Jellyfin's own parameters; a typed
accessor would mean re-deriving them - the 416x234 mistake again. It stays a
raw `http`/`https` proxy (and `subtitleProxy` stays plain axios: byte pipes,
not JSON APIs).

The admin points SaltyChart at Jellyfin (URL + API key) on `/admin`; both live
in `AppConfig`. **The API key never reaches a browser** - availability
responses carry only ids and display strings, the stream proxy injects the
key server-side. This router mounts **before `compression()`** (the proxy
pipes HLS segments), so it carries its own limiters and JSON parser.

An API key authenticates but does not *identify*, and PlaybackInfo **silently
drops `TranscodingUrl`** when no user id is sent - which reads exactly like a
rejected DeviceProfile. So a **playback account** is picked on `/admin`
(`jellyfinUserId`, falls back to an administrator): a dedicated non-admin
account (here `SaltyChart`, which passes the full player suite) with library
access and no bitrate/parental limits. Nothing reaches its watch history:
Jellyfin records only progress a client reports to `/Sessions/Playing`, and
this proxy never reports (verified: `playCount=0` after a day of repeats).

**"Direct stream" still runs ffmpeg and still writes to the transcode cache.**
Browsers can't play MKV, so every playback is remuxed into MPEG-TS for HLS -
cheap on CPU, identical on disk to a real transcode:

| mode | ffmpeg | re-encodes video | writes to transcode dir |
|---|---|---|---|
| direct play | no | no | no |
| **direct stream (remux)** <- H.264 8-bit source, no subtitle burned in | **yes** | no | **yes** |
| **transcode** <- everything else: HEVC, Hi10P, any burned-in subtitle | yes | yes | yes |

Transcodes run on the CPU (`libx264`): Jellyfin's hardware acceleration is
`none` on this deployment (checked 2026-10-12), which is a Jellyfin dashboard
setting, not ours.

**Auto's ceiling sits above the source, never at it** (`autoTier`,
`lib/jellyfinApi.ts`; the PSYREN S01E01 case that played at 960x540 is its
JSDoc - after the change it encodes at 1280x720 under a 3.8 Mbps ceiling,
checked from Jellyfin's own ffmpeg log 2026-10-12). Jellyfin compensates for a low-bitrate or HEVC source
and then clamps to our ceiling, so a ceiling equal to the source cancels the
compensation, and a video budget below the source's bitrate makes
`ResolutionNormalizer` downscale. So Auto sends the source's width and
`max(source + AUDIO_HEADROOM, the named tier's bitrate for that width)`. The
encode is CRF 23, so the ceiling is a cap, not a target; a cap below the
CONTAINER bitrate also forces `ContainerBitrateExceedsLimit` - a full re-encode
of every file.

Jellyfin's ffmpeg **writes segments until the whole file is done regardless of
the playhead**, and its cleanup timers don't keep up for remux jobs
(jellyfin#16608), so an abandoned session leaves most of a ~1.4 GB episode on
disk. That is why the pop-up pre-warm never touches the HLS manifest and why
`tools/bench_player.py` must not be run casually (`.claude/rules/tools.md`).
Keeping subtitles out of the video avoids the third row, not the second.

Routes (contracts here; each guard's story is commented at its code):

- `GET  /status` - `{ configured, isAdmin }` probe (JWT). `isAdmin` rides
  along so the header's Admin link doesn't 403-spam an admin-only endpoint;
  fetched once per login by `stores/jellyfin.ts`. It is `User.isAdmin` - it
  compared against `ADMIN_USER_ID` until 2026-10-13, so a promoted admin saw no
  admin pages (`test_account_security` step 9 now asserts it).
- `POST /availability/batch` - `{ items: [{ mediaId, titles[], startDate?, status? }] }`
  (max 100) -> map of the single-route shape. Randomize asks about every wheel
  item in one request (was ~50 POSTs per page load). Shares
  `resolveAvailability()` with the single route; per-entry `unknown` preserved -
  one failed show neither contaminates others nor gets cached. **Ignores
  `fresh`** and serves cached negatives for 10 minutes - a diagnostic that needs
  a live answer must use the single route.
- `POST /availability` - `{ mediaId, titles[], startDate?, status? }` -> is the
  series in the library + the entry's season's first episode (season parsed
  from "Nth Season"/「第N期」; missing season = unavailable). Returns
  `{ available, seriesId, itemId, mediaSourceId, episodeTitle, seasonNumber,
  episodeNumber, libraryTitle, matchedBy, english }`.
  - `english` is what the episode Watch plays offers an English speaker
    (`fullEng` / `signsOnly` / `engAudio` / `none` / `unknown`,
    `classifyJellyfin`), read from the media source `finishEpisode` already
    fetches - no extra request. It drives Randomize's Hide Not English;
    verdicts cached before it existed lack it and read as unknown until expiry.
  - **An unaired entry** (AniList `status`, else `startDate` - `isUnaired`) is
    asked like any other, because a file can land before AniList's premiere
    (the case is at `resolveAvailability`). A "no" for it carries `notAired`,
    applied per request (`withAiring`) and **never cached**: the cache is keyed
    by AniList id alone, and a cached flag let a status-less lookup hand later
    callers an unmarked "no" (`entryStatus.ts` has that story). Accepted risk:
    the title and season-marker fallbacks can mis-answer a NEXT-season sequel
    (One Punch Man S3 Part 2 read as Part 1's S3E1) - harmless, because an
    unaired show has nothing to watch yet and the Sonarr selection never reads
    availability. On FALL 2026 all 33 unaired entries answered correctly.
  - The series list is cached 1 h and served stale-while-revalidate
    (`getSeriesLibraryFresh` is the blocking variant for `fresh: true`
    callers). The stale check must come **before** joining an in-flight
    refresh: measured 2026-10-13 on a forced full read (~1 s locally), the old
    order made every request after the first wait for it (0.13-1.02 s for 7
    staggered requests) while the current order served all 8 in 10-20 ms. No
    pipeline test guards it - emptying the in-memory copy needs a backend
    restart - so re-measure with an aged `jellyfinLibraryAt` if you reorder it.
    **`Fields=ProviderIds,OriginalTitle` is mandatory** on that query
    or Jellyfin returns `ProviderIds: null`, silently disabling the id tier.
    **So is `userId`** (the playback account): a user-less listing silently
    omits real series, each then reading "not in the library" - measured at
    `libraryUserId`.
  - Per-mediaId cache 1 h positives / 10 min negatives, persisted to
    `AppConfig.jellyfinAvailability`. `fresh: true` bypasses it (library
    refetch throttled to one per 30 s); without it a restart-surviving cache
    turned `test_jellyfin`'s id-tier proof into a recording.
  - Always 200 - server down/unconfigured is `{ available: false, unknown: true }`
    (never cached). **`unknown` is load-bearing**: "couldn't ask", not "not in
    the library"; every consumer must refuse to hide on it.
  - **`idConfident`** is `isIdConfident` (see *How well do we know each match*):
    a map id, a human decision, an admin override, or a resolver id a DATE
    vouched for (`isDateVerified` - deliberately NOT `exact title` or `release
    year`). It gates the viewer's correction picker, and `unverified` follows
    the same rule so the pop-up's badge can't fire on a row /admin/matching
    renders green. **A viewer pick is NOT confident** - treating it as settled
    hid the picker, and the undo inside it, the instant someone used it.
- `GET  /playback/:itemId` - one call: `playSessionId`, `mediaSourceId`,
  subtitle streams (with the file's own flags + codec), font attachments.
  **`subtitleIndex` requires `mediaSourceId`** (400 otherwise): Jellyfin
  applies a track choice only when the request names the source, and without
  it silently burns in the default track (the player always sends it).
  **A Jellyfin 404 answers 404 `ITEM_GONE`** and drops every cached
  availability verdict carrying that itemId: Jellyfin derives item ids from the
  file path, so a Sonarr replace + rescan brings the episode back under a NEW
  id (the measured case is at the route in `routes/jellyfin.ts`). The pop-up
  notices `ITEM_GONE` on its prewarm, re-asks with `fresh: true`, and points
  Watch at the new episode before anyone presses it.
- `GET  /stream/*` - GET-only streaming proxy (JWT header or `?token=`).
  **Forwards only `/videos/<itemId>/...`** (`STREAM_PATH`, checked on the
  normalised path, no `%` allowed) - anything else is 403 `FORBIDDEN`. It
  attaches the server's API key, and until 2026-10-13 it forwarded any path:
  a fresh signup read `/Auth/Keys` through it. Forwards `Range`, destroys
  upstream on client disconnect. **Manifests are buffered and refused if they
  contain a credential** - Jellyfin embeds the caller's key into HLS subtitle
  rendition URIs, so never send `subtitleMethod=Hls`. All three `?token=`
  routes (this, `/subtitles`/`/attachments`, `/library/image`) authenticate
  through `checkToken` (`middleware/auth.ts`), the same session rules as
  `requireAuth` - a bare `jwt.verify` let a deleted account or a session a
  password change had ended keep streaming.
- `GET  /subtitles` - proxies Jellyfin's own conversion. `format=ass` is a
  pass-through of the original; `format=vtt` lifts `Region:` lines into the
  header (`liftVttRegions` - Jellyfin emits them after the header closes,
  costing a console error and a dropped cue).
- `GET  /attachments` - an embedded font. Off the playback path since burn-in
  (kept + tested: it is the only way to inspect what a release ships).
  **Indices are the file's own stream numbers** - they must come from
  `/playback` or every request 502s. Both this and `/subtitles` send
  `Cache-Control: private, max-age=86400` (immutable per item+index).
- `POST /playback/stop` - `{ playSessionId }`; tears the transcode down
  rather than leaving it to time out on a shared box.
- `GET/PUT /config` + `POST /config/test` - admin only. Read returns URL,
  `apiKeySet`, `userId` - never the key. On save, an empty key **and an empty
  URL** keep the stored values (Save on a blank form once replaced a working
  address with the placeholder); an empty `userId` is a real choice ("fall back
  to an administrator"). Test hits authenticated `/System/Info`, so green
  proves the key works, not just reachability.
- `GET /users` - admin only; ids + names for the playback-account picker.
- `GET /identity` - admin only; every override row.
- `POST /identity/resolve` - admin only; `{ mediaIds[], years?, titles?, dates? }`
  (max 200) -> which id we believe each is, where it came from, and whether a
  human confirmed it (`/availability/batch` says *whether* it resolved).
  Unmatched rows carry `retry` (`eligible` / `cooldown` + `nextRetryAt` /
  `retired`, from `retryStateFor`) and `tier` from `classifyMatch`
  (`id`/`title`/`notHeld`/`noMatch`, the sweep's own classifier, so per-season
  and all-seasons rows agree by construction); `years` and `titles` are the
  mediaId-keyed maps those need, since a miss row stores neither. `dates`
  (day-precision premieres) feeds **`settledByDate`** - did the premiere
  SEPARATE a multi-candidate row; a year cannot serve (the rule measures a 31-day
  gap), and no `dates` settles nothing (`test_candidate_separation.py` asserts
  it). Each row's `status` is the identity half of the status vocabulary
  (`identityStatus` over `identityFacts`, shared with `/api/sonarr/report`).
  Top level carries `sweep`, the persisted `AppConfig.remoteSweepStatus`,
  written at BOTH sweep exits so "ran and found nothing" differs from "never
  ran"; a corrupt row parses to null. Its `remaining` counts only what future
  runs will process (cooldown and retired excluded, or it could never reach 0);
  `retired` counts old misses no longer re-asked.
- `POST /identity/sweep` - admin only; starts a **drain** sweep (per-run cap
  *and* retry cooldowns dropped, pacing kept) and returns
  `202 { started, running }` immediately - a drain runs for minutes, so nothing
  awaits it; `_running` in `remoteIdentity.ts` is the concurrency guard, and
  progress lands in the `sweep` summary above. 503 `NOT_CONFIGURED` /
  `IDENTITY_NOT_READY` when it can't start.
- `GET /library/search?term=` - **viewer-gated** (JWT only, no admin), the one
  exception among the identity endpoints. Ranks the cached library + film index
  for the Watch pop-up's picker (`lib/libraryPick.ts`); in-memory, no Jellyfin
  calls. Items carrying neither a TVDB nor a TMDB id are never offered - a pick
  is stored as an id override, so an id-less item cannot be pinned. It DOES use
  a contains tier, unlike `matchSeries`: a human is choosing, so hiding the
  right answer is the only real failure.
- `GET /library/image/:itemId` - **viewer-gated**, `?token=` like the stream
  and subtitle proxies because `<img>` cannot send a header. Proxies the
  item's Primary poster (key server-side), 404s a missing one so the picker
  needn't special-case it, cached a day. A franchise's entries differ by one
  word; the cover is how a human tells them apart.
- `POST /identity/unpick` - **viewer-gated**; `{ mediaId }` clears the override
  so the entry falls back to the automatic match. Same 409 guard as the pick:
  a human decision is never touched. A pick a viewer cannot reverse is worse
  than no pick.
- `POST /identity/pick` - **viewer-gated**; `{ mediaId, itemId }`. The ids
  written are read off OUR library row, never taken from the request. Refuses
  with **409 `ALREADY_SETTLED`** when a human settled the row - confirmed,
  rejected, or an admin's unconfirmed manual override (`viewerMayReplace` in
  `seriesIdentity.ts`; the last case was missing until 2026-10-13) - nothing
  else guards those (`setIdentityOverride` upserts unconditionally). Stored as
  `source: 'manual'`, `confirmed: false`, `note: 'viewer: picked by <user>...'`;
  a new `source` value was rejected as it would need edits in seven places and
  still render as a community-map id. Invalidation is inherited from
  `onIdentityChanged`.
- `PUT /identity` - admin only; write an override. `rejected: true` means
  "not in the library" and suppresses title matching too. **Merged onto the
  stored row** (`mergeIdentityPatch`): an unsent field keeps its stored value
  (Confirm preserves resolver provenance), an explicit null still clears.
  Every identity write **invalidates that mediaId's cached availability, in
  memory AND in the persisted blob** (`onIdentityChanged`) - without the
  persist half, a restart inside the debounce window restored the
  pre-correction verdict from disk for up to an hour, and only the
  persisted-blob assertion in `test_jellyfin` step 11 can see it.
- `DELETE /identity/:anilistId` - admin only; removes + invalidates the same
  way.
- `GET /identity/lookup?term=` - admin only; the Sonarr-style lookup behind
  /admin/matching's search box. A name searches series-first via skyhook
  merged with Jellyfin's TMDB results (TMDB-only when skyhook is down);
  `tvdb:12345` / `tmdb:12345` resolves a pasted id (prefix required - bare
  digits are real titles: *86*). Results are completed both ways (held library,
  then the community-map cross-walk) and carry a `library` tag and a display
  `year`; an unheld `tmdb:` paste is named via the identify-by-ProviderIds
  search. Never on a viewer's path.

## Sonarr auto-add (`/api/sonarr`)

We add seasonal anime to Sonarr with `POST /api/v3/series`, **once per series,
ever**. The full argument for every predicate - why whole first seasons rather
than pilots, why `pending` is excluded, why relations decide scope but never
identity - is the docstring of `backend/src/routes/sonarr.ts`, and that is its
one home. What matters here is the contract.

**Every route carries `requireAuth` + `requireAdmin`**, and a mutation row proves
it. There is no public route: the one that existed, `GET /list`, was the Custom
List Sonarr polled and it went away with the list.

**This replaced a Custom List, and the reasoning is not re-litigable without new
measurement.** The root guide states why; the full argument is
`lib/sonarrPush.ts`.

- `GET /push/preview` - admin; what a push would do, **writing nothing**:
  `toPush`, `deferred` (held back by the cap), `skipped` (each with its reason),
  `problems` (setup still outstanding), `enabled`, `cap`. It does *not* perform
  the TVDB lookup (one round trip per candidate on a page load), so a bad id
  surfaces as a `lookupFailed` row after a real push instead.
- `POST /push` - admin, and **the only thing in this codebase that writes to
  Sonarr**. Gated in order: the master switch, then config completeness, then tag
  resolution; each refuses before a single `POST /api/v3/series` goes out.
  Per series it does `GET /api/v3/series/lookup?term=tvdb:<id>` (the validity
  check, and the source of the object we post - hand-building it means guessing
  at fields that change between versions) then the add.
- `GET /report` - **admin**; everything `/admin/sonarr` renders, in one payload:
  candidates with a `state` (`willBeAdded` / `addedByUs` / `pushedAlready` /
  `heldAlready` / `excludedInSonarr` / `lookupFailed` / `failed` / `unknown`),
  the per-gate rejection breakdown, the push log and orphans.
  - **It degrades rather than failing** - with Sonarr unreachable it still
    returns the whole candidate side with `sonarr.observed: false`, because an
    outage is exactly when someone opens the page. The UI must not collapse
    `unknown` into zero: "couldn't ask" is not "nothing to do" (the headline did
    exactly that once and was caught in a browser, not by any test).
  - Also carries `library` (the cached library check: `last` null means never
    checked, never zero problems) and `config.qualityProfileName` /
    `qualityProfileUpgrades`, named from the snapshot's cached profile list -
    still no Sonarr call on a page load.
  - Every proposed and rejected row carries `english: { label, ok } | null`
    (`englishSummary`): `subs` / `dub` / `subs + dub` / `no English`, with a
    `watchable/episodes` count when only some episodes have English (for a
    sequel, every episode Sonarr holds for the series); null when the last
    check did not see that tvdbId.
  - **Every row also carries the one status** (`lib/entryStatus.ts`): `status`
    `{ level, code, text, also? }`, `wanted` / `wantedBy`, `listedBy`,
    `onMyList` (the requesting admin's own list), `attention` (wanted and broken
    or check), `watchable` (`false` = what Randomize's Hide Not English hides;
    `null` = no definite answer) and `unaired` (an unaired show with no file is
    hidden there but not red here - the page counts it apart from red). The
    AniList airing status field is `airing`, not `status`. Top level adds
    `attention` (open failures no row accounts for, `unattachedFailures`) and
    `summary` (the chip counts, plus how many shows, unaired included, the
    library was asked about and answered).
  - **This is the one place the report asks Jellyfin anything**:
    `availabilityFor` (routes/jellyfin.ts) - the same `resolveAvailability` and
    cache Randomize uses, unaired entries included - which makes "red here" and
    "hidden there" the same set by construction. Warm: 0.5 s for 170 rows;
    cold it walks the library and the page waits up to 60 s.
  - Push failures join a row by AniList id (`pushForEntry`), never by title -
    a title join once attributed one show's push to another of the same name.
- `POST /library/check` - admin; the **Refresh Jellyfin** button. Runs the
  library check now and answers once the audit is stored and any refreshes are
  requested (Jellyfin catching up is watched in the background). Takes a
  snapshot first when the stored one predates the `ours` field. The same check
  runs daily from `index.ts`, on the Sonarr push timer (so also once ~12 min
  after each boot); there is no other trigger.
- `PUT /enabled` - admin; the master switch, **`sonarrPushEnabled`, default
  off**. Deliberately a new key rather than a rename of the list era's
  `sonarrListEnabled`: reusing it would have inherited an existing `true` and
  turned a list that merely *offered* series into a job that *adds* them, on the
  first restart after deploy, with nobody having chosen that.
- `POST /snapshot` - admin; caches what Sonarr holds, including `ours` (the
  marker-tagged series with their Sonarr ids, so the library check never pulls
  the 2,400-series library) and `profiles` (with `upgradeAllowed`). `GET/PUT /config`,
  `GET /config/options` (root folders, quality profiles and tags for the setup
  dropdowns), `POST /config/test`, `POST /include`, `DELETE /include/:anilistId`
  - admin.
- **Reads `SeasonCache` only, and never calls `startColdFetch()`.** It serves a
  stale row happily; freshness is irrelevant here, which is also why there is no
  second copy of `SEASON_TTL_SECONDS` to drift. A never-fetched season simply
  contributes nothing, and a cached-but-empty one (`"[]"`) means "asked,
  nothing yet" rather than "not cached". It reads the `''` format key - the
  `'TV'` row would silently drop every TV_SHORT.

**We send every add setting** (monitor, series type, root folder, profile,
tags) rather than relying on hand-typed import-list settings.
`searchForMissingEpisodes` is **off** - for an upcoming season RSS picks
episodes up as they air - so an already-`FINISHED` entry sits in Sonarr until
someone hits Search, which `/admin/sonarr` says out loud.

**Tags must already exist in Sonarr.** Labels resolve to ids via `sonarrTags()`
and a missing one **blocks the push** rather than adding untagged: creating it
would be a second write verb, and an untagged series is invisible to
Maintainerr's scoping - a cleanup that quietly does nothing.

**One of those tags is the marker, and only it means "we added this".**
`sonarrMarkerTag` (default `saltychart`) is forced into the applied set on both
read and save, so nothing we add can lack it. The others are shared library
conventions and must never be read as ownership: `anime` sits on hundreds of
series here, so "does it carry any of our tags" claimed the owner's
years-old shows as ours (measured at `sonarrApi.ts`; it has a mutation row).

**The marker is a second, independent record of what we added**, because a
database does not follow you from dev to production or survive a restore from
an old backup, while the tag lives in Sonarr beside the series. Neither is
complete (the record misses anything added before it existed, the tag anything
since deleted), so `history.ours` is their **union**, with `history.pushed` /
`history.tagged` reported separately. Hand-tagging a series is a legitimate way
to say "this one is ours".

The selection itself is `lib/sonarrSelect.ts`: pure, I/O-free, resolver injected,
so every predicate is unit-tested without a DB. The identity filter is
**`tvdbId && !pending && !rejected && confident`** - deliberately not
`confirmed`, since a community-map row is unconfirmed by construction and
requiring confirmation would discard the ~94% of TV the map answers. This is the
one path stricter than the site's: elsewhere an unverified resolver id is
positive-only because a bad guess costs a Watch button that doesn't work; here
it downloads a season of the wrong series.

**`confident` is `isIdConfident`** (a human decision, a map id, or a resolver id
a DATE vouched for), passed in as `SonarrIdentity.confident`. `pending` alone
was not enough: the resolver's exact-title rung, the id backfill and the TVDB
gap fill all write NON-pending rows carrying a TVDB id nothing has dated (the
case is in `sonarrSelect.ts`). Checking confidence in the selection covers every
writer, past and future, in one place. A not-confident entry the rules want is
rejected as **`unverifiedMatch`** (wanted, yellow, in Needs attention) until the
daily TVDB check verifies it by a date or someone presses Confirm; a trusted
list drops it as `unverifiedNotAcknowledged`; an acknowledged Include still adds
it, and `POST /include` 409s on it exactly as on a pending match.

Measured 2026-08-06 on the live cache: 39 proposed from SUMMER 2026's 111 cached
entries; 157 excluded across both seasons (66 not TV/TV_SHORT, 50 with a
PREQUEL/PARENT edge, 37 outside the 14-day air window, 4 with no usable id), and
**zero duplicate TVDB ids** in any season or across the pair. On 2026-08-10 the
automatic list graded 30 `map` + 9 `dateVerified`, **zero weak**.

### How well do we know each match - `matchGrade`

`lib/seriesIdentity.ts` owns the ladder, and it is the **only** definition:
`matchGrade()` returns `confirmed` / `adminOverride` / `map` / `dateVerified` /
`viewerPick` / `weak` / `none`, and `isIdConfident()` derives the boolean the
Watch pop-up's correction picker uses. A correctness rule with two copies is one
that can disagree with itself. What each grade means and the mistake behind each
distinction is the JSDoc of `matchGrade`; in short, `weak` is title text or a
+/-1 year (the Echo class), an **admin** override is settled and a **viewer
pick** is not.

**A resolver id the community map independently names grades `map`, not
`weak`.** A stored row SHADOWS the map, so without this rung an entry we looked
up graded *worse* than the same entry with no row (the deploy-gate failure that
found it is in `seriesIdentity.test.ts`). `resolveIdentity` sets
`Identity.mapCorroborated` - only it sees both the stored row and the map - and
it is **never persisted**: the map refreshes on its own schedule. **Only an
identical id counts**: a map entry naming a DIFFERENT id is a dispute, and the
resolver is often the one that is right (IGPX, documented at `mapCorroborated`),
so a contradicted row stays `weak` and in review. A mutation row guards each
direction. Measured over 1520 stored rows (2026-09-22): 42 shadow a map answer,
41 agreeing and 1 contradicting (IGPX), and exactly one of the 41 graded weak;
1004 carry no tvdbId (bookkeeping, which cannot shadow) and 473 sit where the
map has no id - the gap the resolver exists to fill. **`RESOLVER_VERSION` was deliberately not
bumped**: the grade is computed at read time, so no stored row decides
differently.

**The override needed its own guard.** `selectForSonarrDetailed`'s
force-include branch once skipped `usableTvdbId` entirely (the count is at the
code). `POST /include` now answers **409 `UNVERIFIED_MATCH`** (with the grade
and what it matched against) unless the caller sends `acknowledgeUnverified`,
and `SonarrInclude.acknowledgedUnverified` records that someone was told. An
override may outrank the filter; it may not do so blindly. Two mutation rows
guard it - the pure check and the 409 - because the UI asking is a courtesy and
the endpoint is the actual guard. If an automatic proposal ever grades `weak`,
the filter has regressed, and `test_sonarr.py` step 9 fails on exactly that.

### What the history line can honestly say

`SonarrPush` is the record of what has already happened, and **only a 201 from
Sonarr writes a `pushed` row**. That, plus the marker tag, is what makes "we
added N" sayable at all - an observed-held date is not an add date (the Custom
List era's `SonarrSeen` table proved it: every row shared the first snapshot's
timestamp).

`history.alreadyHeld` stays a **separate** count for the same reason: those
series were in Sonarr before we got there. A mutation row guards the tempting
simplification - count every *tagged* series rather than only marker-tagged ones -
which would claim credit for the entire library.

`lookupFailed` and `failed` are the actionable statuses. Both mean nothing was
added and both are retried, so a row that persists is a real problem: a
`lookupFailed` is a wrong TVDB id, which is a `/admin/matching` job. **Except
once it is superseded** (`supersededFailures`, `superseded: true` on the row):
the entry now resolves to a different tvdbId, or was added under another one.
Nothing retries the old id, so without this the failure stayed in "need
attention" for ever after a fix. Superseded rows stay in the log, labelled
`replaced`, and are not counted.

### One add per series, and what that replaced

A terminal row (`pushed` or `alreadyHeld`) means we never consider that tvdbId
again (the rule is in the root guide). **We do not have to observe a deletion
for that to hold** - the old design did, and could not.

- **Retries exist only where nothing was added.** `lookupFailed` and `failed`
  stay retryable; a corrected identity produces a *different* tvdbId, which has
  no terminal row and pushes fresh - the only intended second attempt.
- **`alreadyExists` from Sonarr is terminal, not a failure.** The held set comes
  from a cached snapshot, so a series added between snapshots answers 400
  "already been added"; recording that as failed would retry it every run for
  ever. `classifyAddError` (`lib/sonarrPush.ts`) is pure and unit-tested for it.
- **A failed or empty read of `/api/v3/series` must never be trusted.** "Could
  not ask" is not "the library is empty", and an empty read taken at face value
  would make every held series a new candidate - a burst of duplicate adds. The
  push refuses outright without a trusted snapshot. (A genuinely empty Sonarr
  also reads as "could not ask", so a brand new install needs that guard
  revisited before its first push.)
- **Sonarr's Import List Exclusion is honoured but not required.** It does not
  bind `POST /api/v3/series`, so we skip anything on it as a human's stated
  intent. Maintainerr writing one on reap is now belt-and-braces.
- **Orphans need a human.** Correct an identity after we already added the wrong
  series and Sonarr keeps the wrong one while we add the right one. We have no
  delete verb, so `/admin/sonarr` names the deletion to make by hand.

### How Sonarr gets this, and what we decide for it

One connection, one direction:

```
  SaltyChart  --(GET /api/v3/series/lookup, POST /api/v3/series)-->  Sonarr
```

Configuring Sonarr's URL + API key on `/admin` is the whole wiring. **No Import
List is created in Sonarr**, and any left over from the Custom List era should
be deleted - it would keep re-adding whatever it last read.

**Setting it up**, all on `/admin` -> Connection:

| field | value | why |
|---|---|---|
| URL + API key | Sonarr -> Settings -> General -> API Key | the same key does the lookup and the add |
| Root folder | the anime share | must match one of Sonarr's own paths exactly; a dropdown for that reason |
| Quality profile | **Anime Dual Audio (720p)** | applied to every series we add; **must allow upgrades** (see below) |
| Series type | Standard | how releases are matched to episodes; Anime enables absolute numbering |
| Tags | `anime, saltychart` | **must already exist in Sonarr**; all are applied to every add |
| Marker tag | `saltychart` | the one that means *we* added it, and what Maintainerr scopes on; always applied |

Measured on the live instance 2026-08-10: root folders `/media/TV Shows` and
`/media/Anime`; tags `anime` (5, on 692 series) and `saltychart` (37).

**Monitoring and search are ours to send**, and are not configurable per
deployment on purpose: `addOptions.monitor: 'firstSeason'` (whole first
seasons, never a pilot - Seerr refuses requests for a `PARTIALLY_AVAILABLE`
season; the argument is the `sonarr.ts` docstring) and
`searchForMissingEpisodes: false`. **A forced sequel is the exception**: an
Include or a trusted list on a "Season 2" entry is sent `lastSeason`
(`SonarrPushItem.monitor`), because `firstSeason` would download season 1.
(`latestSeason` is deprecated in Sonarr v4; if TVDB already lists an announced
later season, `lastSeason` monitors that one.)

### Trusted users' lists are requests

Every show on a **trusted** user's list for the current or next season is
force-included (`listRequests` in `lib/sonarrSelect.ts`, counted by
`loadTrustedListCounts` in `routes/sonarr.ts`), so a show the rules skip - a
sequel, an ONA - is still added when someone ranked it. Trusted = an admin, or
`User.sonarrTrusted` set on `/admin/users` (`PATCH
/api/admin/users/:id/sonarr-trusted`). **Off by default and admin-only,
because signup is open to the internet** - an untrusted list must never start
downloads; `test_sonarr` step 11 and a mutation row guard it. The identity
guard still applies: a list entry never acknowledges an unverified match, so a
pending guess is dropped as `unverifiedNotAcknowledged`, never added; MOVIE is
skipped. A manual Include for the same entry wins over the list. Rows carry
`listedBy` (how many trusted lists) and the page says so. One add per series
still holds: a show added once and deleted is not re-added because it is still
listed.

**A quality profile invalidates the size estimate.** The 0.38 GB median comes
from the mixed-quality library (500 episodes, 2026-08-04). "Anime Dual Audio
(720p)" is a 720p *floor*, not a cap: re-measured 2026-10-13 read-only against
Sonarr, the 215 files it grabbed in its first four days (53 series) were median
0.69 GB, p90 1.43, mostly Bluray/WEBDL-1080p (median of per-series medians
0.48). Too young and clustered (one backfill was 56 of them) to replace the
constant, so the page says the estimate is likely low. Re-measure once a season
of new shows has been grabbed under it, and update `GB_MEDIAN`/`GB_P90` in
`AdminSonarr.svelte` and `tools/sonarr_dryrun.py` together.

**The profile must allow upgrades, and even then it is not the whole fix.** Until
2026-10-09 the auto-add sent "Prefer Smaller (At least 720p)"
(`upgradeAllowed: false`), so whatever Sonarr grabbed first - often a raw
(`ToonsHub ... YT/NHK WEB-DL JPN`, `MeGusta HDTV`) with no subtitle tracks - was
permanent. "Anime Dual Audio (720p)" upgrades, but its `minUpgradeFormatScore`
of 1600 means a raw (score 0) is replaced only by a dual-audio release, never by
SubsPlease (400); 30 of the 43 unsubbed files that day were already on it.
Tuning that is Sonarr configuration; seeing it is what the library check is for.
The `/admin` dropdown marks no-upgrade profiles and warns when one is chosen.

### The library check - English subtitles, and Jellyfin catching up

`lib/libraryCheck.ts` (I/O, deps injected) over `lib/libraryAudit.ts` (pure, the
rules). One pass over every series in scope (below), from the snapshot's cached
`ours` + `seasonHeld` lists:

1. Sonarr `GET /api/v3/episode?seriesId=&includeEpisodeFile=true` - one call per
   series answers both "which episode" and "what is in the file". A read; the
   one-write-verb boundary is untouched.
2. Jellyfin `/Shows/{id}/Episodes?Fields=Path,MediaStreams`, the series found by
   TVDB id in the cached library (refetched once when one of ours is missing -
   the stale-while-revalidate copy lags new series).
3. Each episode is classified `fullEng` / `signsOnly` / `engAudio` / `none` /
   `unknown`, from **Jellyfin's** tracks (only Jellyfin publishes track titles
   and `IsForced`). **The forced flag is not decisive** - a release group that
   flags full dialogue forced is the measured case at `libraryAudit.ts` - so
   forced counts as signs-only only in a file with English audio, where it
   carries the signs for a dub. Sonarr's codes are the fallback for a series
   Jellyfin cannot be matched to, labelled so on screen. `unknown` is never
   counted as subbed.
4. **Stale** = Sonarr's current file name is not among Jellyfin's paths for that
   series. A file-NAME rule, never episode numbers: a multi-episode file is one
   Jellyfin item and the two orderings differ (the per-episode version and its
   false positives are at `libraryAudit.ts`).
5. Stale series, and only those, get one Jellyfin `Refresh` (Default modes:
   "Scan for new and updated files", nothing replaced). The check then polls
   every 15 s - up to 2 minutes, 5 when a series is new to Jellyfin
   (`POLL_TRIES` / `NEW_SERIES_POLL_TRIES`) - for Jellyfin's paths to match, and
   only THEN drops cached availability pointing into the series - dropping it
   the moment we ask lets the next viewer re-cache the old item for another
   hour. Series still stale after the window are named on the page
   (`refresh.stillStale`). **Whether a series refresh really picks up a
   replaced file is from Jellyfin forum reports, not docs** - the poll exists so
   the page reports what happened instead of assuming it.

**Sonarr's Connect -> Emby/Jellyfin "Update Library" is deliberately OFF** - the
owner does not want Jellyfin told about every import. This is narrower: only
series whose files changed, daily or on **Refresh Jellyfin** (82 series cost
~165 LAN requests, 1-4 s, 2026-10-09). A Randomize-visit trigger was dropped at
the owner's request.

**Scope**: the marker-tagged series with files, plus `seasonHeld` - held series
the current and next season's entries point at that we did not add (sequels,
hand-added shows) - so the English column covers every row Sonarr holds. On
2026-10-10: 99 series, 685 episodes - 641 full English, 1 signs-only, 1 English
audio, 42 none, 0 stale, 0 unmatched once the library was listed as the
playback account.

**Tags travel in our add payload** (`addSeries`, with the marker forced in), so
Maintainerr can scope cleanup to what we added. Don't add a per-season tag: age
(`Plex.addDate`) gives the same granularity with no extra Sonarr state.
`/report` counts how many held series carry the marker, because a typo there
fails silently by scoping Maintainerr to nothing.

Graded against the held library over WINTER + SPRING + SUMMER 2026: **119
proposals, zero wrong exclusions.** Every held entry the list declines is either
a sequel/later cour (27) or a non-TV format (14) - both deliberate. Proposals
per season are stable (36 / 44 / 39); what swings is how much is held (14 / 3 /
36), which the library alone cannot attribute to "never grabbed" versus
"grabbed and since deleted".

**Why ONA stays excluded is precision, not id coverage.** Over those three
seasons: 51 ONA entries, 30 first-season, **27 of those with a usable TVDB id**
(our resolver rows included, so not in tension with the map-only "ONA is 40%"
in the root guide). The problem is that only **3 of the 27 were wanted**, and
nothing separates them: the three held span popularity 213,444 / 44,384 /
**18,042**, score 85 / 78 / **68**, favourites 10,599 / 1,812 / **314** -
Hana-Kimi sits below seventeen unheld entries on every axis. `duration` and
`episodes` cleanly identify short-form and non-full seasons, but removing those
still leaves 21-for-3. Three positives are far too few to establish a threshold
and quite enough to refute one, so **do not add a quality, popularity or score
heuristic here** - that is the `isRelation` guard's mistake in a new costume.
Full-length ONA belongs to a human request path, not to auto-add.

## Translation routes (`/api/translate`)

- `GET /api/translate/check-batch?videoIds=id1,id2,...` - bulk DB lookup for English sub status (up to 100 IDs); returns only confirmed positives; queues background Python checks for uncached IDs - **except during a bot-wall hold**, when it queues nothing. `X-Check-Queue: held | queued:N | no-daemon` says which, so the decision is observable even with no daemon running
- `GET /api/translate/check?videoId=&mediaId=`  - checks English subs + subtitle dismiss state; cached. During a hold it answers from cache only (`hasEnglish: null`, `holdUntil`) and writes no row
- `GET /api/translate/stream?videoId=&mediaId=&start=` - SSE subtitle stream; serves from cache on repeat plays. Optional `start=<sec>` begins transcription at the viewer's playhead (live CPU savings); `start>0` runs are partial and not cached
- `PATCH /api/translate/dismiss?videoId=`       - persist subtitle on/off preference; no auth, all users
- `POST /api/translate/upload`                  - upload pre-translated subtitles; admin only, respects model rank
- `DELETE /api/translate/cache?videoId=`        - delete a cached translation; admin only
- `POST /api/translate/batch`                   - trigger batch pre-translation; admin only, JWT required
- `GET /api/translate/batch/status`             - batch job progress/logs; admin only (in-memory only, see `/report`)
- `GET /api/translate/report?season=&year=`     - everything `/admin/subtitles` renders; admin only, and carries `download` (the health record below) and `schedule.lastLocalRun`
- `POST /api/translate/local-run`               - the Sunday GPU run posts its `run_verdict` here at the end; admin only; stored in `AppConfig.subtitleLocalRunStatus`

`GET /report` is the one route here that reads `SeasonCache`, and like
`/api/sonarr` it **never triggers a cold AniList fetch** and reads the `''`
format key. Defaults to the current season plus the next (`seasonsForSonarr`);
`season`+`year` override it, both or neither. It returns `overall` (aggregates
over the whole `SubtitleCache`), `schedule`, per-season `counts`, and one row per
trailer carrying a single `state`. **`cached: false` on a season means no
`SeasonCache` row at all**, distinct from a row holding `[]` ("asked, nothing
yet"); the page must render it as *not cached*, never as zero work.

**The state ladder is `lib/subtitleReport.ts` and only there** -
`ourSubsOff > burnedIn > youtubeCc > translated > checkedNoSubs > never`, with
the argument for each rung at the function. `youtubeCc` outranks `translated`
because CC is *why* the pipeline skips a video, and **`never` is about evidence
rather than about a row existing** - `PATCH /dismiss` upserts a row with a null
`hasEnglishSubs`, and calling that "checked, no YouTube CC" would claim work
nobody did.

**What the schedule can honestly say.** The Wednesday medium batch is described
from `lib/batchSchedule.ts`, which `index.ts` and this route share so the page
cannot name a night the job does not run; `wouldFireAtNextWindow` is evaluated
**at the window**, not at now, or the page promises a run the scheduler will
decline. The Sunday `large-v3-split` GPU run is a Windows Scheduled Task on
someone's PC that the server cannot observe, so `lastChampionUploadAt` is only
*last upload seen* - **the run reports itself** by `POST`ing its `run_verdict`
to `/local-run`, and `schedule.lastLocalRun` is that report. Without it, a run
that produced nothing was indistinguishable from a quiet week.

**All three scripts in `backend/scripts/` force stdout and stderr to UTF-8**
(`errors='replace'` as the backstop): the backend spawns them through a pipe,
and Python on Windows encodes redirected output as cp1252, so one title outside
cp1252 killed a whole run. The incident is at the `reconfigure` call in each
script.

**The batch script derives its DB path from its own location** (`SCHEMA_DIR` in
`batch_translate.py`, reasoning at the constant), not from a hardcoded container
path, so it is right in the image and the repo alike.

**Both batch scripts exit with a verdict, and both self-upgrade yt-dlp first.**
`run_verdict` in `translate_stream.py` (one definition; `local_translate.py`
imports it) turns the run-wide error count into an exit code: 0, **2 when at
least `RUN_FAIL_MIN` failures make up more than `RUN_FAIL_RATIO` of attempts**,
3 on a bot-wall abort - with a final `Done:` line naming the dominant failure
kind and its remedy (a 403 run says "stale yt-dlp, upgrade it").
- **`unavailable` is left out of that ratio on both sides**, and out of the
  remedy choice, for the `countsTowardBroken` reason below (the run that mailed
  FAILED with nothing broken is at `run_verdict`). They are still shown in
  `Done:` as `N not on YouTube (retried next run)`.
- **Do not add a "known dead, skip it" memory**: it was considered and rejected,
  because a trailer can be private now and public later, and asking again each
  run (one request per missing trailer) is how we notice.
- Before the verdict, per-season errors were discarded and the run exited 0
  through four Sundays of mostly-failed downloads (`tools/logs/translate.log`
  is the record every "four Sundays" mention points at).
- **Every exit path of `local_translate.py` goes through it** - `main()` ends in
  one `finish()`: the season loop, `--video` (one attempt, counted), and a
  `--within-days` decline, which sits *after* login so it reports
  `Done: skipped - ...` (exit 0) rather than leaving the server's card reading
  "did not run". A bot-wall abort accumulates the season's counts before it
  breaks. The report is posted whenever the run authenticated and is not
  `--dry-run` / `--no-upload`. **No offline test** covers these paths (the
  script imports torch); the decline is verified live with `--within-days 0`.

`ensure_ytdlp_current()` runs before the first download unless
`--dry-run`/`--no-update` (its docstring has the out-of-process version read
and the old-pip retry). **The live daemon deliberately does not call it**: a
viewer is waiting, it is a pip round trip (~6 s even when current), and the
daily updater (`lib/ytdlpUpdate.ts`) plus the daemon recycle covers that path.
The rule: the two off-hours batches check every run; the live path never does.

Both check and stream query `SubtitleCache` first. On a hit, `/stream` sends a
`{cached: true}` SSE event then all segments instantly (~50 ms); on a miss the
daemon translates and caches on completion, and concurrent requests for the
same uncached video are deduplicated. `/check` returns `{hasEnglish,
subtitlesDisabled, hasCachedSegments, modelName}` - the first two hide the
overlay; the last two tell the local script whether to re-translate. Dismiss
state comes from the CC toggle and persists for all users.

YouTube caption control is three paths in `openModal`
(`AnimeGridTranslate.svelte`, commented there), fed by `Home.svelte` firing
`check-batch` right after the anime list loads (~5 ms, DB-only): a confirmed
English video opens on YouTube CC and never translates; any other opens with
Japanese CC suppressed and translation started, while `/check` re-fires and
switches to YouTube English CC if Python has since confirmed it; a click before
the batch returns races `/check` against 150 ms first.

`check_subtitles()` uses `ytt.list(videoId).find_transcript(['en'])`, which
sees manually uploaded, auto-generated AND auto-translatable English CC (the
old `ytt.fetch(languages=["en"])` found only manual tracks).
`SubtitleCache.hasEnglishSubs` trusts positives forever and negatives for
**7 days** (`lastEnCheckAt`), so newly added CC is eventually noticed without
re-checking every play; a cache write never downgrades a stored true.

**The check has three answers, not two.** `check_subtitles()` returns
`hasEnglish: true` / `false` only when YouTube definitively said so
(`DEFINITIVE_NO_CC` in `translate_stream.py`, matched by exception class *name*
so the module stays stdlib-only for `yt_guard.py`); an IP block, a PO-token
demand, a network error, a timeout, or a missing `youtube_transcript_api` all
return `hasEnglish: null` plus `checkError`, and **no write site pins a null**:
`checkVerdict()` (`lib/subtitleCheck.ts`) gates both route writes, and
`batch_translate.py`'s upsert `COALESCE`s the stored verdict and leaves
`lastEnCheckAt` untouched - otherwise one transient block is trusted as "no CC"
for seven days. `test_run_verdict.py` re-checks the class names against the
installed version.

**A row existing is not a verdict.** `PATCH /dismiss` and segment caching both
upsert `SubtitleCache` rows with a null `hasEnglishSubs`; `/check-batch` now
queues a check for every null verdict - the story is at the code in
`routes/translate.ts`.

On-demand translation is a persistent Python daemon
(`backend/scripts/translate_daemon.py`, Whisper `small` int8); batch
pre-translation (`backend/scripts/batch_translate.py`) uses `medium` and
auto-upgrades videos previously translated with `small`, and also pre-checks
English subs so first play never spawns Python. The live path is CPU-only and
shares the box with Plex - **all tuning (nice, env knobs, single-ffmpeg-pass,
playhead start, the per-request timing line, the base-model VAD-poisoning
quirk) is documented in the daemon's docstring.**

**Benchmark / bake-off harness** - `tools/benchmark_whisper_settings.py`
composes swappable stages from `tools/bench_pipeline.py` (audio -> ASR ->
translate -> align) so each layer A/Bs in isolation; suites, the real-CC
corpus, metrics, result-file conventions, and the Windows environment gotchas
are all in its docstring. Data in `tools/benchmark_data/` (gitignored); results
consolidate into `tools/benchmark_results.txt`, one section per suite.

Findings that drive production settings (raw tables in
`tools/benchmark_results.txt`; method in each bench's docstring):

- **Decode params**: `beam_size=10 + repetition_penalty=1.2 (+vad_min300)` is
  best for *transcribe* but **hurts** end-to-end translate (e2e SCORE
  1.0->-1.6) - params interact with the task, which is why only the
  fully-stacked run found the champion.
- **Demucs vocal separation helps** (~+6-8 SCORE, ~5-6 pp less hallucination),
  but only from full-quality source audio, never the 16 kHz mono input.
- **Champion (`split_best`)**: vocals -> large-v3 `transcribe` (tuned params) ->
  **qwen3.5:9b** translate via Ollama, SCORE 1.9 vs 1.0 end-to-end; residual
  weakness is mis-heard proper names. qwen3.5:9b beat text-only qwen3:8b
  (content 57.3 vs 53.6), so it is kept despite its unused ~1.2 GB vision
  encoder.
- **Japanese-specialised ASR lost on this domain**: kotoba-whisper-v2.0 (51.3)
  and Qwen3-ASR (52.2) both under large-v3 transcribe (55.8) - clean-speech
  leaderboard wins don't transfer to stylized trailer audio.
- **Live CPU** (`bench_live_cpu.py`): `small` wins both axes; tiny/base are
  slower AND worse. Transcription is ~8x faster than playback, so the felt
  latency is the audio download - hence playhead-start and the single-pass
  download, not model changes.
- **Download** (`bench_download.py`): the ~1.2 s `worstaudio` baseline is the
  floor - every player_client override failed or was slower, and aria2c -x16
  was ~20-28x SLOWER. The cost is YouTube's extraction handshake, not bandwidth.
- **Player startup** (`bench_player.py`): everything except Jellyfin's first
  HLS segment is under 0.25 s (segment: median 19.9 s cold, range 1.3-30); our
  proxy adds ~0.02 s and the first stream request leaves the browser ~65 ms
  after the click, so pre-loading more cannot help. It found and fixed a 30 s
  proxy idle-timeout that killed slow-but-working streams and an `await` on the
  Cast SDK between click and manifest. Methodology: stop each run's encodings
  before timing the next, and measure the fonts the app actually sends.

The backend auto-scheduler (`index.ts`) runs the medium batch on Wednesdays
2-4 am when the next season is within **50 days** (once per Wednesday,
`--cutoff 10`); the local large-v3 GPU script runs every Sunday and covers all
3 seasons first, so the Wednesday batch is its fallback. A batch run covers
**only the displayed season** by default (one season's downloads per run avoids
the YouTube bot wall; `--all-seasons` restores the old sweep). Downloads are
sequential with `--download-delay` (default `DOWNLOAD_DELAY_DEFAULT` in
`translate_stream.py` - one definition per deployable, reasoning at the
constant, printed into `--help` via `%(default)s` so the text cannot drift) and
the run **aborts on a bot-challenge** (`_is_bot_block`) instead of hammering on.

Chunking ramps 5 s, 5 s, 10 s, 10 s, then 20 s from second 0. On-demand uses
`beam_size=1, condition_on_previous_text=False` for speed; batch `beam_size=5,
condition_on_previous_text=True` for quality. All calls use
`word_timestamps=True` and take segment starts from `words[0].start`, which
kills the pre-speech lead-in. Subtitle timing syncs to the YouTube iframe's
`currentTime` and respects play/pause.

Python deps: `faster-whisper`, `yt-dlp`, `youtube-transcript-api`, system
`ffmpeg`. Both `small` and `medium` are pre-downloaded in the Docker image.

### Keeping yt-dlp current - the failure that looks like an auth problem

**The symptom:** trailers report `Subtitles unavailable`, the backend log shows
`unable to download video data: HTTP Error 403: Forbidden`, and *some* trailers
still work perfectly. **The cause is never authentication.** We send no
credentials to YouTube and need none, and extraction succeeds - only the
download fails.

**The mechanism:** YouTube caps how many bytes one request may take, so a
whole-file GET is refused while bounded chunks are served. An aged yt-dlp asks
for the file in one unranged request; a current one fetches bounded chunks - so
no cookie fixes it. **"Some videos work" is the giveaway, not a
contradiction**: `GET /stream` serves `SubtitleCache` hits before the daemon is
involved, so every cached trailer keeps working while every new one fails, and
nothing in the suite downloads a fresh video.

**Four mechanisms keep it current, and each reaches a machine the others do
not:**

1. `backend/Dockerfile` upgrades it in the runtime stage, **deliberately after
   the `COPY --from=builder` lines** (which change every deploy, so the upgrade
   is never served from cache; moved above them it would be cached forever,
   the original bug - reasoning at the `RUN`). A rebuild of the *same* commit
   still hits the cache; (2) covers that.
2. `lib/ytdlpUpdate.ts` re-checks daily (and 5 min after boot), logging one line
   either way, and recycles the translate daemon when the version changed -
   Python caches `yt_dlp` in `sys.modules`. `recycleTranslateDaemon()` returns
   `recycled` / `busy` / `none`: `busy` means the **old** version serves until
   the daemon's next respawn; `none` (not running) means the next spawn imports
   the new one.
3. `ensure_ytdlp_current()` at the start of both batch scripts - the only one of
   the four that reaches the **Sunday PC**, where nothing else runs.
4. `Dockerfile.base` still installs it, but that is only the offline floor - the
   base is rebuilt by manual dispatch only, so its copy ages by design.

**Do not pin a version.** Pinning is how this broke: the base image froze
whatever was current when it was built, and nothing ever moved it.

#### Knowing when it breaks - `lib/downloadHealth.ts`

The outage was never hard to *fix* - it was impossible to *see*: cached
trailers kept serving and the suite stayed green. So every real download
records whether it worked, in `AppConfig.subtitleDownloadHealth`. **It makes no
requests of its own** - no canary, no polling: the thing that breaks is
YouTube's tolerance for our traffic, so a health check that adds traffic is the
wrong shape. The daemon tags a failure with its `stage` (`download` vs
`transcribe`), because a transcription error says nothing about downloads.

**The signal is a streak, not a failure.** One failure is a private or deleted
trailer; `BROKEN_AFTER = 3` consecutive ones is the path being down for
everyone. It logs loudly exactly once, at the crossing (`failureTransition` /
`okTransition` are pure, so that is a unit test and a mutation row), and
`/admin/subtitles` leads with a red banner plus the "a 403 here is a stale
yt-dlp, not auth" hint. A `kind` is normalised to `FAIL_KINDS`
(`normalizeFailKind`) before it is persisted, and the hint
(`looksLikeStaleYtDlp(reason, kind)`) hangs only on a `forbidden` kind - a
challenge can arrive as a 403 whose body says "confirm you are not a bot".

**A dead video is not evidence, and a 403 is worth one retry.** Both come from
one measured run: 51 of 63 trailers downloaded, and the 12 failures split into
6 videos that no longer exist and 6 transient 403s.

- `countsTowardBroken` (pure, mutation-guarded) spares `unavailable` from the
  streak - it neither advances nor clears it, because a video that no longer
  exists is a fact about that video, not about us. The counters still move, so
  "how many trailers are simply gone" stays visible. yt-dlp says it two ways
  (`Video unavailable`, `This video is not available`), and both must classify.
  The measured run that would otherwise have mailed "broken" is at
  `countsTowardBroken`.
- A 403 is transient often enough to retry **once** (the proof is the
  docstring of `should_retry_download` in `translate_stream.py`), after a short
  pause and **only** for a `forbidden` kind. That function is the policy, with
  **one definition**: `translate_stream` defines `download_with_retry` and
  `tools/local_translate.py` imports it. What is not shared is `ydl_opts`,
  which differ for measured reasons - the server takes `worstaudio` (Whisper
  resamples to 16 kHz anyway), the GPU run takes `bestaudio` (Demucs
  benchmarked worse on low-quality input) and carries cookies and its own
  pacing. `test_run_verdict.py` asserts the two share the function object
  **and** that no second copy of the loop has reappeared. A dead video can
  never succeed and retrying a bot wall deepens the block, so neither is
  retried - a mutation row guards that direction specifically. A failing video
  therefore costs 2 requests, never a loop.

This does NOT weaken the stale-yt-dlp signal: that failure is total by
mechanism, so it produces consecutive 403s across the whole run and still
crosses the streak.

**Crossing that line also mails the admins** (`lib/subtitleAlerts.ts`). Every
trigger is a state change, never a per-failure event - an alert that fires on
every failure is the alert that gets muted:

- once when the path breaks, once when it recovers - both obey YouTube's own
  toggles on `/admin/status` (`alertAdmins(..., { service: 'youtube' })`), so
  recovery mail is off unless switched on there;
- once per failed batch exit (`persistBatchRun`, any non-zero or signal exit;
  the mail says whether the run was scheduled or manual, and **a dry run never
  mails**);
- once per failed Sunday report (`POST /local-run`);
- once when the Sunday run has been **silent for `LOCAL_RUN_SILENT_DAYS` (8)** -
  a daily timer in `index.ts` (`checkLocalRunSilence`) stamps `silentAlertedAt`
  on the stored report so it mails once per silence, and the next report
  replaces the row and re-arms it. **Residual gap, documented rather than
  closed**: a Scheduled Task that never fires even once after deploy leaves no
  report to be silent, so the timer logs `no Sunday run has ever reported` and
  sends nothing.

Recipients are the **owner** - the lowest-id admin with a verified address
(`ownerEmail`, pure) - plus any extras set on `/admin/status`. A second admin is
a peer for permissions but is not signed up for operational mail; with SMTP
unconfigured it logs `would have sent` instead.

`stage`, `raw` and `kind` are **stripped in `routes/translate.ts` before the
payload reaches a browser**. The raw text is operator detail; putting it on
screen is what sent the owner hunting for an authentication bug that never
existed.

**And when it breaks the OTHER way - YouTube refusing the server - it holds.**
The daemon classifies every download failure (`classify_error` in
`translate_stream.py`: one definition, also behind the viewer's message) and
sends `kind` with the error. A `botwall` kind (the phrases in `BOT_WALL_SIGNS`)
makes `/stream` **refuse new downloads for `BOT_WALL_HOLD_MS`** (15 min, **a
guess and labelled as one** - nothing publishes how long a YouTube soft block
lasts) with a friendly message plus `holdUntil`, recording nothing;
`/check-batch` queues no background checks meanwhile (`X-Check-Queue: held`)
and `/check` answers from cache only. **One bot wall is enough** - it is
YouTube saying "you", not "that video". A `forbidden` (403) failure
deliberately does **not** hold: that is the stale-yt-dlp signature, and holding
would hide the recovery an updater or deploy may bring any minute. `botwall` is
checked before `forbidden` because a challenge can arrive with a 403 status.
Guarded by `downloadHealth.test.ts`, `test_download_hold.py` and four mutation
rows (the stream, check-batch and check gates, and a 403 never holding).

**A JS runtime must be present.** yt-dlp enables **only deno** by default, which
this image lacks, so `download_audio` passes `js_runtimes: {"deno": {}, "node": {}}`
(reasoning at the option; re-check `JS runtimes:` in a production log if in
doubt).

**The viewer never sees the raw yt-dlp string.** `friendly_error()`
(`translate_stream.py`) maps it to something actionable and the raw text goes to
stderr: `HTTP Error 403: Forbidden` reads as "SaltyChart must log in to
YouTube", which is never true.

**Local GPU translation** - `tools/local_translate.py` runs the champion split
pipeline on this PC (requirements, pipeline, Ollama management, and fallback
behaviour are in its docstring) and uploads as **`large-v3-split`** (rank 6,
above plain `large-v3`, so older results auto-upgrade on the next run; use
`--force` to re-do everything). Download pacing, cookies and why
`--download-workers` is ignored are in `.claude/rules/tools.md`. Operational
facts that live nowhere else:

- Seasons process one at a time; long trailers sub-batch in the translator
  (<=20 lines per Ollama call) and untranslated lines retry.
- VRAM (10 GB): the season run is **phased** - separate-all (Demucs) ->
  transcribe-all (Whisper, then freed) -> translate-all - so only one model is
  GPU-resident (~6.4 GB peak vs ~9.8 co-resident) and each loads once.
  `run_phased()` owns this; the legacy per-video fallback path is Whisper-only.
- `large-v3-turbo` benchmarks comparable content with slightly more
  hallucination (suite `turbocmp`); it's ~4-8x faster via `--model` if speed
  ever matters.

**Windows Scheduled Task:** "SaltyChart Translate" runs `local_translate.py`
directly (NOT through `translate.bat` - editing the .bat does nothing to the
schedule) every **Sunday 5 am** via `py -3.13` against http://192.168.1.2:8085,
covering 3 seasons, skipping already-cached videos. Change args in Task
Scheduler -> Properties -> Actions -> Edit (needs the Windows password;
LogonType: Password). **Its `lastResult` is meaningful**: 0x0 worked, 0x2 most
downloads failed, 0x3 a bot-wall abort; the same verdict is posted to the
server, which mails on a non-zero code and on silence (above).

**The task's credentials live in its Arguments, and `local_translate.py` reads
them from nowhere else** - there is no `$SALTYCHART_USER` env fallback (one was
drafted and reverted). To run it by hand, pass `-u`/`-p`, or start the
Scheduled Task itself (`Start-ScheduledTask -TaskName 'SaltyChart Translate'`),
which reuses the stored credentials without anyone handling them.
**`--token` is not the answer for the weekly task**: `/api/auth` signs **7-day**
tokens (`auth.ts`), so one minted today is expired by the run after next. It is
for a one-off, like the `--within-days` check.


## Upstream service status (`/api/status`)

**Why it exists.** Two third-party services changed and broke silently in one
week - YouTube's media requests and skyhook's `User-Agent` - and in both cases a
`catch` turned the failure into a plausible empty answer. "Could not ask" and
"there is nothing there" were the same value. This router and
`lib/upstreamHealth.ts` are where those stop being the same value.

`lib/downloadHealth.ts` is the shape (record real traffic, a **streak** is the
signal, log and mail once at the crossing) and keeps its own store for its
YouTube-specific hold and hint; `upstreamHealth` covers everything else and
`GET /report` composes both. The transitions are a threshold-aware twin rather
than shared code, and `upstreamHealth.test.ts` pins what must still match (the
streak arithmetic) **and the divergence itself** (only this module needs a time
window) - the same discipline as `MODEL_RANK`.

- `GET  /report` - admin; every service with a server-decided `state`, plus the
  alert settings and whether SMTP is configured at all.
- `PUT  /alerts` - admin; save the alert settings. The body is *coerced*, not
  rejected: these are preferences, and the response echoes what was actually
  stored so the page cannot believe it saved an address the server dropped.
- `POST /probe` - admin; run every due check now.

**A streak is not an outage until it has LASTED its window** - `MIN_OUTAGE_MS`
(10 min) by default, **2 hours** for skyhook, TMDB and AniList
(`outageWindowMs`, read only through `outageWindowFor`). The clock starts at
the **first failure of the streak** (`failingSince`, cleared by a success), so
"failing for the window" implies "nothing worked for the window". Both earlier
versions mailed false outages - a bare streak count (skyhook's routine 500s,
three in 0.9 s) and a since-last-success clock (a burst of 403s on an idle
server); both measurements are at `streakStartedAt` / `failingLongEnough` in
`upstreamHealth.ts`. A probed service is re-checked every `CONFIRM_RETRY_MS`
while failing, so a dead one keeps recording failures and crosses on its own.
YouTube's window is **0**: `downloadHealth` owns that verdict. Because the
streak and the window become true in either order, "once" is a stored flag
(`downAlertedAt`), and recovery is keyed off the same flag so a recovery mail
can never arrive for an outage nobody was told about. **The flag only holds if writes
never overlap**: every service shares one `upstreamHealth` row, so every record
is a read-modify-write of all of them, and `recordUpstream` / `recordSkip` run
through one in-process queue (`serialized`). Without it two failures arriving
together both read "not mailed" and both mailed - AniList's 2026-10-21 shutdown
reached the owner twice in one minute - and each overlap lost a count. Mutation rows guard the
once-rule, the window, the clock it is timed by, and the badge using the same
rule.

**Five states, decided on the server** (`stateOf`: `ok` / `failing` / `down` /
`unknown` / `notConfigured`); the page renders a verdict and never computes one,
so the page and the alert email cannot disagree. `unknown` (nothing has asked
yet) must never render as healthy - that is how skyhook stayed invisible.
`notConfigured` is deliberate, not a fault: a skip touches neither counter, so
an unconfigured Sonarr is never painted green *or* red.

**Probe daily, confirm fast.** Third-party APIs break on a release cadence, so
hourly probes of someone else's free service buy nothing. Each spec declares
`minProbeIntervalMs` (a **day** for skyhook, TMDB, SMTP and the id map; **15
min** for Jellyfin and Sonarr, our own boxes); a just-failed service is
re-checked after `CONFIRM_RETRY_MS`, so a real API change is confirmed within
the hour while a transient 500 clears itself.

**The sweep logs when it ACTED, not every time it fires**, with a six-hour
heartbeat so silence stays unambiguous - "silent unless it acts" is right for
daily jobs but at 15-minute cadence it drowned the log (reasoning at the timer
in `index.ts`). The identity re-grade beside it **reports its own progress**,
and every line carries its position (`re-grade 150/725`), because a progress
line that cannot say where it is in the run is not a progress line.

**YouTube alone is `passiveOnly`, and a mutation row stops that being undone.**
Its failure mode *is* request volume, so a synthetic probe risks deepening the
bot wall it exists to detect. Its record comes from real traffic.

**AniList is probed daily**, though it was passive at first - the budget
argument was wrong (one request a day is 0.002%), and AniList is called only
from `/api/anime`, so a quiet server would never check it (the argument is at
AniList's spec in `upstreamHealth.ts`). `pingAniList` goes through
`fetchAniListPage`, so it exercises the same headers, budget recording and 429
handling a viewer's page load does - with `record: false`, because the probe
runner records every result once and the fetch recording it too counted each
probe twice. A 429 that exhausts the retries is reported
as **healthy** - AniList is talking to us and rate-limiting. The probe query
must select a content field, not just `pageInfo` (see `pingAniList` in
`routes/anime.ts`).

**A probe goes through our own client, never a hand-rolled request.** skyhook's
outage was our axios instance being refused while `curl` to the identical URL
returned 200; a hand-built probe would have reported green throughout. The TMDB
probe sends the same shape `remoteIdentity.searchOne` does, field for field.

**TMDB is graded separately from Jellyfin** even though it is reached through
it, because "Jellyfin is up but its metadata provider is failing" was the
blindest failure in the codebase (`upstreamProbes.ts`). A blanket axios
interceptor would have merged the two.

Alert settings live in `AppConfig.alertSettings` (`lib/alertSettings.ts`):
master switch, per-service toggles, extra recipients, and the maintenance window.

**Scheduled maintenance holds the mail for our own boxes, never drops it**
(`MaintenanceWindow`, applied to specs marked `maintenanceAware` - Jellyfin and
Sonarr only). The Unraid Appdata Backup plugin stops every container in turn;
on 2026-10-18 it stopped Jellyfin 05:52-06:30 and mailed a false outage. The
window is the plugin's own cron line (`0 5 18 */3 *` on this server - read
from `/boot/config/plugins/appdata.backup/config.json`, not guessed) plus a
duration, **read in an explicit IANA zone**: the server's crontab runs in local
time and the backend container in UTC. A failure inside the window does not
cross (`failureTransition`'s `inMaintenanceNow`), so `downAlertedAt` stays null:
a recovery inside the window sends nothing, and a service still failing after
it crosses on its next failure and mails, saying the mail was held. Do not
"fix" a backup alert by widening `MIN_OUTAGE_MS` instead - a window long enough
to sit out a 40-minute stop hides every real crash for as long. A schedule that
changes without this one costs one unnecessary mail, never a missed one. Two
mutation rows guard the hold and the zone.

- **`alertAdmins` (`lib/subtitleAlerts.ts`) is the one funnel every alert goes
  through**, so the master switch and the extra recipients are honoured there,
  once - **a control that lies is worse than no control** (reasoning at
  `alertAdmins`). The switch once went unread and the deploy gate's fake Sunday
  verdict reached the owner's real inbox; `test_local_run_report.py` now turns
  it off around that verdict and restores it in a `finally`. It is also where
  **only production mails** - see *A dev backend runs no scheduled jobs*.
- The read **fails open** - a missing or unparseable row yields the defaults,
  alerts ON.
- **Per-service toggles reach an alert that names its service**
  (`alertAdmins(..., { service })` - the download-path mails pass `youtube`);
  alerts about our own jobs (the batch, the Sunday run) have no service and
  obey the master switch alone. **An absent per-service key means enabled** -
  if absence meant off, every service added later would arrive silent.
- **Recovery mail is a SECOND per-service switch, and its absent key means
  DISABLED** - deliberately the opposite default: a silent new outage costs
  something, a missed recovery notice costs nothing (reasoning at
  `perServiceRecovery` in `alertSettings.ts`; requested after the id-map fix
  mailed a recovery whose cause was the deploy the reader had just asked
  for). **Recovery is gated on the
  outage switch as well**, because `downAlertedAt` is stamped at the crossing
  whether or not mail went out - otherwise a silenced service could send
  "working again" for a break nobody was told about. **`alertsEnabledFor` takes
  its `kind` with no default**, so a caller forgetting which kind it asks about
  is a compile error, not a quiet return to mailing every recovery. Three
  mutation rows guard the defaults and the ordering.
- Recipients are the **owner** plus the extras, de-duplicated - not every
  verified admin (see the subtitle alerts above).
- **SMTP itself stays in `.env`**: a mail password in `AppConfig` is a mail
  password in every backup. Residual gap, stated on the page: with SMTP down,
  nothing can mail to say that mail is down.

### The refresh clock and the alarm clock have to overlap

The id map's probe makes no request: it calls the map broken once
`anilistTvdbMapAt` is `MAP_STALE_MS` (48h) old. **So `REFRESH_AFTER_MS` (12h)
plus one restart interval must stay under `MAP_STALE_MS`.** It was 7 days, and a
deploy-on-push server restarts more often than its 24h-of-uptime timer fires, so
a false outage was mailed (the story is at `REFRESH_AFTER_MS` in
`anilistTvdbMap.ts`). The ETag is persisted so a boot refresh is a 304, not a
7.5 MB download. `anilistTvdbMap.test.ts` imports the probe's own constant and a
mutation row puts the 7 days back.

**State a restart resets** is the wider class, and two more places had it -
both now go through `alreadyRanToday` (`lib/scheduling.ts`, unit-tested and
mutation-guarded):

- **The Wednesday batch** stamps `AppConfig.subtitleBatchStartedAt` *before* the
  spawn, and refuses to start if it cannot. It cannot reuse
  `subtitleBatchStatus`: that row is written at the child's exit, so a backend
  killed mid-batch never writes it, and the restart would start a second batch.
- **The Sonarr push** (`runScheduledPushIfDue`) stamps `sonarrPushRanAt` only
  once a run gets past its gates, so a transient refusal at boot does not use up
  the day; the admin's *Push now* is never blocked by it.

**A thrown map fetch records its reason** - only errors tagged by `fetchPairs`
grade the upstream, so a failed local SQLite write is never reported as
"GitHub is not responding".

### A dev backend runs no scheduled jobs

`lib/scheduling.ts` is the whole rule: a timer that acts OUTSIDE this process
fires only when `NODE_ENV === 'production'` - the batch, the Sonarr push, the
identity sweep, the snapshot, the yt-dlp updater, the probe sweep and the
Sunday-silence check. The id-map refresh is left alone (a 304, no side effect,
and local matching needs a current map). The incident that made it code is at
the top of `scheduling.ts`.

**Alert mail asks the same question, in `alertAdmins`**, because gating the
timers did not cover alerts raised on the request path: a mutation-audit row
sent a junk `?format=` through a dev backend, AniList's 400s crossed the
health threshold, and the owner was mailed "AniList is not responding" while
production was fine. A dev backend still *records* upstream health (so
`/admin/status` is red locally) and logs `[alerts] not production ...` instead
of sending. Password-reset and verification codes do not go through
`alertAdmins` and still send.

**`NODE_ENV === 'production'` and nothing else counts** - the opposite question
the rate limiters ask, because the safe side differs ("protect" for a limiter,
"don't" for a job that writes to Sonarr and sends mail). A mutation row guards
each direction. **No escape hatch**: every gated job has a manual trigger. Boot
logs which mode it is in either way.

### The `MaxListenersExceededWarning` is benign - the measurement

The root guide's rule is "don't re-investigate unless RSS stops being flat".
This is the evidence, so a third pass re-derives nothing.

Measured twice and dismissed twice - **74 occurrences**, then **re-measured
2026-08-06 at 204** across 71 PIDs. It is **always exactly `11 error
listeners`**: never 12, never 50, about 2.9 per process lifetime. A real leak
would climb. Under 180 requests (150 cached, 30 `fresh`) RSS went 124.8 ->
124.5 MB, handle count 277 -> 277, and **zero** new warnings appeared.

Almost certainly more than ten requests queued on one keep-alive socket, each
attaching an `error` listener while queued - that matches "always 11" exactly.
**Not established**: it could not be reproduced on demand, so the cause is
inference rather than a traced stack. To settle it, run the dev backend once
under `NODE_OPTIONS=--trace-warnings` during an audit.

## Matching internals - how identities get made

The *rules* - identity versus availability, an id being authoritative in both
directions, air date separating right from wrong by three orders of magnitude -
are in the root `CLAUDE.md` under *Matching AniList entries to the library*,
and they still govern everything here. This section is the mechanism. The
evidence behind each rung (every show named, every day-distance table) lives at
the code in `lib/remoteIdentity.ts`, `lib/skyhookIdentity.ts` and
`lib/seriesIdentity.ts`; read the identifier named before changing it.

### Making the links nobody else has - `lib/remoteIdentity.ts`

The community map answers 94% of TV and none of the gap it leaves; the upstream
anime databases know almost all of that gap but carry no TVDB/TMDB id (counts in
the module header). So we make the links from two keyless sources: **series go
to TVDB first** via `lib/skyhookIdentity.ts` -> `skyhook.sonarr.tv` (Sonarr's
own proxy: native TVDB ids, plus per-episode air dates for seasons nobody holds
yet - the evidence the held-library gate cannot produce); movies and skyhook
misses use Jellyfin's own TMDB remote search (Radarr's proxy rescued zero
movies, so no new dependency). skyhook is someone else's free service: calls are
paced, bounded per run, degrade to the Jellyfin path, and **never appear on a
viewer's request path**.

**Send a real `User-Agent`, and never cache a failed lookup.** skyhook answers
**400** to axios's default agent (measured at `USER_AGENT` in
`skyhookIdentity.ts`). A bare `catch` once turned every failure into an empty
show **and cached it**, silently killing the whole TVDB evidence tier (eight
stored rows carry the season rung from before it broke, none from during).
Both halves of the fix matter - "could not ask" and "this show has no schedule"
were the same value. It logs one `[skyhook]` warning per failure; two unit
tests and a mutation row hold the caching rule. Successful answers are reused
for **12 h** (`SKYHOOK_CACHE_TTL_MS`, empty answers included) so a record TVDB
adds later is seen without a restart.

**Budgets.** A sweep runs 90 s after boot and daily, reads entries from every
cached `SeasonCache` season (a first-ever lookup is made regardless of age), and
is bounded at **150 lookups per run** (`MAX_PER_RUN`) - about one year's gap
entries, so a season rollover clears in one run. The re-grade pass shares that
figure (`REGRADE_PER_RUN`: it carries correctness fixes, and 40/day would take
over a week to propagate one). Legacy-row dating and the TVDB check's older rows
keep a 40-per-run cap (`MAINTENANCE_PER_RUN`).

**The TVDB check (`fillTvdbGaps`) completes and verifies the TVDB half of stored
rows**, because TVDB is what Sonarr acts on and, for a new season, the record
appears and gains a premiere date around the premiere. Two kinds of row -
**fill** (a TMDB-only tv row; for a confirmed or manual row, only TVDB's own
link to that TMDB id may add to it) and **verify** (a stored TVDB id whose note
is not date evidence, not map-corroborated). The whole policy is one pure
function, `decideTvdbFill`, and its JSDoc is the table of what each case
writes: a date within tolerance writes `pending: false` with the date as the
note, a verify never swaps the id, and an exact title a date refutes writes
nothing.

**A link completes, a date verifies**: TVDB's link to a TMDB id proves the two
records are one show, not that the show is right for the AniList entry. The
stored TMDB id is never touched, and only the candidate used is merged into the
stored list (both reasons at `decideTvdbFill`). **Scheduling** (`planGapFill`): current/next-season rows
every daily run (ceiling 150), older rows 40 a run on the main sweep's retry
tiers, films skipped (TVDB lists none - 103 of the queue were films on
2026-10-10), retirement never lifted, due-ness read
from the sweep-START `updatedAt` snapshot so the year-dating pass cannot starve
it. **A drain lifts its caps and cooldowns too.** A check that could not reach
skyhook counts as `failed` and leaves the row's clock alone; one that changes
nothing touches only `updatedAt`, so it does not wipe the show's cached Watch
verdict daily. Results land in the sweep status (`gapFill`) and on
/admin/matching.

**The community map takes over from an unverified guess** (`mapBackfillAction`,
every run): a stored remote row with no TVDB id that is not date-verified is
CLEARED once the map gives its AniList id a TVDB id, so `resolveIdentity` falls
through to the map; a dated tv row the map agrees with on TMDB gains the map's
TVDB id; dated films and OVAs where the map names a parent series are left
alone.

**`POST /identity/sweep` (*Run sweep now*) drains**: **both the cap and the
retry cooldowns dropped** (`planSweep`'s `ignoreCooldown`) and the re-grade cap
removed - a human pressing it is not the daily budget, and one sweep leaves
every row cooling, so without the override the button would be a no-op. Pacing
still applies, and **retirement is not overridable**. A cold start that once
took eight container restarts is one click (375 lookups, 11.5 min).

Two selection rules were broken at first, invisibly (both commented at the code):

- A row recording *"we looked and found nothing"* must **not** shadow the
  community map - an id-less, unconfirmed, un-rejected row is bookkeeping,
  not an answer (`resolveIdentity`).
- The sweep selects on **`needsRemoteLookup`**, not "has an identity row" -
  the latter retired an entry on its first empty search and made the retry
  tiering dead code.

Stored rows are **completed in both id spaces** (`completeIdentityIds`: held item
first, community-map cross-walk second), because this server's remote search
returns TMDB only and a Sonarr user expects TVDB on series rows. Misses retry on
a tier keyed to how close the entry is to airing (2 days within +/-1 year, 30
within +/-2, unknown year 14) - when records appear. A miss whose entry aired
**more than 2 years ago is retired** (`retryAfterFor` returns Infinity,
unit-tested); retirement never blocks a *first* lookup, and a human can still
resolve a retired entry on `/admin/matching`.

Three search rules, each measured (evidence in the module header): **both search
kinds are tried** (AniList's format does not predict how TMDB files a work);
**the base title is searched too** (`baseTitles` strips season markers before
subtitles and only treats separator-looking separators as such - `Re:Zero` must
not collapse to `Re`; it also reaches unrelated namesakes, which is why nothing
is ever accepted on title alone); and **a guessed id is POSITIVE-ONLY**
(`idIsAuthoritative: false`) - it may add a Watch button, never remove one. The
UI marks such matches `unverified`.

**Which candidate is offered is decided by air date too, not provider
relevance** - `pickCandidate` sorts exact titles by premiere distance rather
than taking TMDB's first (the Echo case is at the code). Only the suggestion
changes; nothing within tolerance still queues the row for review.

**A ladder or ranking change reaches rows already stored, via
`RESOLVER_VERSION`.** The sweep selects on `needsRemoteLookup`, so an entry that
already carries an id is never re-asked - a matcher fix used to heal only NEW
lookups. Every write stamps the resolver's version; `needsRegrade` selects
machine-decided rows carrying an id whose stamp is below the current one, and
re-resolving stamps them, so the pass drains and stops. **Bump
`RESOLVER_VERSION` whenever a change would decide a stored row differently** -
that is the whole trigger. Human decisions (confirmed/rejected/manual) are never
re-graded, and id-less bookkeeping rows belong to the main sweep's retry tier.
Measured on a deployment carrying 295 stale rows: one *Run sweep now* healed
all of them in ~11 min and the next run selected none.

**Acceptance is decided by air date, not title confidence** (`verdictFor` - the
full ladder, its rungs, and the measured day-distance tables are its JSDoc).
Correct results land 0-31 days from the AniList premiere, wrong ones 62-21,929,
with nothing in between - for library air dates, TVDB season premieres and TMDB
premiere dates alike. Rules encoded in the ladder (each case named at its rung):

- An exact title the premiere date *refutes* is never blind-accepted.
- The TVDB season-premiere rung (B0) sits **above** the held-library rung (held
  episodes are stale by construction for a season nobody has grabbed - Ranma S3
  was rejected at 287 d while TVDB had S3E1 on the premiere day) **and
  above the exact-title rung**, and is fetched for that shape rather than only
  to rescue a rejection - otherwise an exact title grades `weak` while TVDB knew
  the day. Audited with `tools/audit_premiere_dates.py`: first seasons agreed
  345/345 when written; quote a fresh run, not this.
- **It reaches a TMDB-only candidate through the id cross-walk** (an in-memory
  join, no request, and it **never crosses the film/series namespace**), because
  `completeIdentityIds` runs AFTER the verdict and the ladder was never allowed
  to use the id it stored.
- **That rung may only UPGRADE, never refute.** The known-correct entries it
  fails to vouch for are all sequels modelled differently by TVDB (a split cour
  as one season lands ~182 d off); out of tolerance it declines and the title
  rung below still accepts.
- **Use the SEASON premiere, never the series' `firstAired`** - that is season
  1's date, and reading it as "the premiere" would demote nearly every sequel.
- A held-library rejection softens to queue while TVDB lists an **undated
  future season** (`hasUndatedFutureSeason`); One Piece Fan Letter and
  Babylon 5 list none and still reject.
- A dated candidate beyond tolerance **queues, never rejects** (TMDB may date a
  film's theatrical release while AniList dates the broadcast).
- The release-year rung is **gated to movie-kind candidates in code** - for a
  series a +/-1 production year is nearly free and an ungated rung wrote
  coincidental TV siblings in as accepted fact.
- `pickCandidate` applies the same evidence to title collisions (dated-within
  exacts by distance first, not popularity order).
- **A multi-candidate row leaves the review queue when the date SEPARATED the
  candidates** - `dateSettlesCandidates` (`lib/seriesIdentity.ts`, beside
  `matchGrade` for the same one-definition reason). Three conditions, each
  excluding a measured case (counts in its JSDoc): exactly one candidate inside
  tolerance, no undated sibling (settling one would undo the merge refusal by a
  side door), and the stored pick IS that candidate. The season rung's rows are
  deliberately untouched - that rung was never measured for this rule.
- There was an `isRelation` guard rejecting results related to the entry; it
  was wrong and was removed (sequel->parent is *correct* - TVDB/TMDB put
  seasons inside one series). Don't reintroduce a title or relation heuristic
  without re-measuring.

**A viewer can correct a match from the Watch pop-up**, remembered for
everyone, because the pop-up is where a wrong match is noticed. The picker
offers held library items only; the pick writes a `manual` row whose `viewer:`
note puts it in the admin review queue as *Viewer pick* (contract and guards:
`POST /identity/pick`).

**The same show found in both providers becomes ONE candidate, merged on an id
cross-reference - never on a title** (`mergeCrossReferencedCandidates`).
skyhook's show record carries TVDB's own `tmdbId` (already fetched for the
season check), and a TVDB-only candidate collapses into a TMDB-only one only
when that reference points at it, keeping the TVDB side as the base and taking
the date. **Merging on matching titles would be actively wrong** - Echo's three
candidates share one title and are three different films - and the guard is a
mutation row. A duplicate *within* one provider is NOT merged: nothing proves
the two are the same show, so it stays in review.

**The top five candidates are kept** (commented at the `slice` in `searchOne`)
on `SeriesIdentity.candidates`; `/admin/matching` renders a picker defaulting to
the resolver's choice, and every resolver row shows provenance (an `our lookup`
badge plus the accepting rung). Accepts on title text or release year alone read
yellow (`unconfirmedAuto` - their being *invisible* was the audited bug), so they
are in Needs attention whenever something wants the show. Rows stored before
candidates carried premiere dates are re-graded by `regradeStoredRows`, capped
and self-terminating, never touching confirmed/rejected/manual rows.

### Films are resolved against films - `jellyfinFilmIndex`

`getSeriesLibrary` fetches Series only, so a film's id could never match and the
lookup used to fall through to title-matching TV shows (the category errors are
counted in `lib/jellyfinFilmIndex.ts`). A `movie`-kind identity now resolves via
a TMDB-id -> item **index** (`AppConfig.jellyfinFilmIndex`, 6 h TTL, persisted,
stale-while-revalidate, warmed at boot). Deliberately an index and not a second
matchable corpus: films are only ever looked up by id, so the error class is
removed, not re-tuned. Its cold-path coalescing is unit-tested (check-and-set
with nothing awaited between). **When the film isn't there, that is the
answer** - no title fallback; `finishEpisode` already returns the right shape
for a movie item.

### Jellyfin identification is controlled by `tvshow.nfo`, not folder names

The Anime library reads local metadata first (`LocalMetadataReaderOrder:
['Nfo']`, always on - the "Metadata savers" checkbox is the *opposite* thing:
it makes Jellyfin WRITE NFOs, which fights Sonarr; leave it empty), and its
remote fetchers are disabled, so the NFO is effectively the only source of
identification. Sonarr -> Settings -> Metadata -> **Kodi (XBMC) / Emby** writes
those files and refreshes them on its daily scan; Radarr ditto for movies.
Enabling it + Refresh Series backfilled 833/836 anime folders and dropped
stored-id/NFO disagreements from 46 to 0. No folder renaming, no watched state
touched.

Folder-name id tags are a red herring here, but the syntax differs by server:
**Plex** reads `{tvdb-12345}` (curly, no `id`) plus `.plexmatch`; **Jellyfin**
reads `[tvdbid-12345]` (square, with `id`) and ignores `.plexmatch`. This
library's folders mostly carry `[tvdb-12345]`, which matches *neither*.

**When measuring any of this, compare ids (not names), scope to the seasons the
app shows, and send what the real caller sends** - `tools/check_match_corpus.py`
sends `fresh: true` AND `startDate`, for the reasons in the root guide's
*Measure before claiming*.


## Accounts and admin access (`/api/auth`, `/api/admin/users`)

The rules are in the root guide under *Accounts and admin access*; the
argument for each is
`docs/superpowers/specs/2026-08-16-admin-account-security-design.md`. This is
the contract.

**Why any of this exists.** `POST /reset-password` used to reset any account
with no identity check - fine on a LAN, an internet-facing admin takeover once
the site went public behind Nginx Proxy Manager. The chain was: reset the
admin's password, log in, `PUT /api/jellyfin/config` with an attacker URL and an
empty `apiKey` (which deliberately keeps the stored one), then
`POST /config/test`, which sends the **stored** Jellyfin key to that URL. Two
curl commands.

**`lib/authCodes.ts` is pure and owns every decision**: `resetPathFor`,
`mayResetOpenly`, code generation, hashing, expiry, the attempt cap, the issue
cap. No clock reads, no Prisma - the route layer passes rows in. Guarantees:

- Six digits from `crypto.randomInt`, **hashed with bcrypt**. Six digits is a
  million values, so a fast digest would make a leaked DB equivalent to a leaked
  code.
- 10-minute expiry against the row's own `expiresAt` (never `createdAt` plus a
  constant computed elsewhere, so changing the TTL cannot retroactively extend a
  stored code), single use, **5 wrong guesses kill it**, at most **3 codes per
  account per hour**, and issuing one consumes any earlier unconsumed code for
  the same purpose. Those numbers are the arithmetic that makes a 6-digit code
  defensible: guessing costs a fresh request per five attempts, and the hourly
  cap bounds the requests.

Auth routes:

- `POST /reset-request` - `{ username }` -> **three** outcomes, all 200:
  `{ codeRequired: false }` (open account), `{ codeRequired: true, hint }` (code
  sent, address masked), or `{ codeRequired: true, noAddress: true, message }` -
  an admin with no address, a deliberate dead end. The hourly cap is reported as
  success on purpose: telling an unauthenticated caller "that account has had
  three codes this hour" is a free oracle, and the real user's earlier code
  still works.
- `POST /reset-verify` - `{ username, code, newPassword }`. **Issues no token**;
  both reset paths land on the existing "Log in here" screen.
- `POST /reset-password` - the old route, now refusing as described in the root.
- `GET /account` - drives the Options Account section, the admin nag banner, and
  the first-run claim form (`setupNeeded`). A non-admin must be able to read it,
  which is why `setupNeeded` rides here and not on an admin-gated route.
- `POST /change-password`, `POST /email`, `POST /email/verify`,
  `DELETE /email` - all require the current password. Without it a borrowed
  unlocked laptop silently redirects the recovery channel, which is worth more
  than the session. `DELETE /email` refuses for admins
  (`EMAIL_REQUIRED_FOR_ADMIN`) - it would be one-click self-lockout.
- `POST /claim-admin` - first run only; see below.

`/api/admin/users` (all `requireAuth` + `requireAdmin`): `GET /` (adds
`createdAt` and a list count - signup is open to the internet, so a stranger's
account otherwise looks like a friend's; also `sonarrTrusted` and
`countsForSonarr`), `PATCH /:id/sonarr-trusted` (`{ trusted }` - does this
account's list add shows to Sonarr; see *Trusted users' lists are requests*),
`PATCH /:id` (promote needs a verified
email on the **target**, `EMAIL_NOT_VERIFIED`; demote respects the floor,
`LAST_ADMIN`), `DELETE /:id` (refuses the last admin and refuses self; clears
lists, settings and codes in one transaction - `WatchList`'s foreign key is
`ON DELETE RESTRICT`, and SQLite cannot change one without rebuilding the table),
`POST /test-email` (mirrors the Jellyfin/Sonarr `config/test` pattern - green
proves the App Password authenticates, not merely that env vars are non-empty).

**Nothing here SETS a credential; the two recovery routes only clear one.**
`POST /:id/clear-password` replaces the hash with one of a random secret nobody
has seen (not a blank - every login path bcrypt-compares, and an empty hash is
what ends up matching `''` after some later refactor) and bumps `tokenVersion`.
`POST /:id/clear-email` drops the address and its outstanding codes.

The distinction is the whole design. An admin who *set* a password would have to
relay it and would know it afterwards, which is a takeover primitive; clearing
gives the admin nothing, because the owner picks the next one. That is why an
admin may clear **another admin's** password, and why only two refusals exist -
the two that would leave an account with no route back in:
`clear-password` on an admin with no verified email (`ADMIN_RESET_BLOCKED`), and
`clear-email` on any admin at all (`EMAIL_REQUIRED_FOR_ADMIN`), since admins are
blocked from the open reset.

**These buttons are for the one lockout self-service cannot reach**: an address
whose inbox its owner has lost pins them to a coded path they can never finish,
and clearing it hands them back the open one (an account with no email already
resets itself).

**First run.** On a database with no admin at all, `ensureDatabaseSchema()`
prints a one-time code under `[SETUP]` and `/admin` shows a claim form
(`lib/setupCode.ts`: in memory only, regenerated per boot, so it cannot leak
from a backup). Before this, whoever signed up first became admin by the
`ADMIN_USER_ID` default - a land-grab on a public domain, reachable for real if
the DB is restored empty. It doubles as break-glass recovery.

**Mail is `lib/mailer.ts`** - plain SMTP, transport injected so tests capture
instead of send. Unset SMTP **does not fail startup** the way `JWT_SECRET` does;
that would break local dev and any deploy predating the config. It fails at the
point of use with `SMTP_NOT_CONFIGURED`. Env: `SMTP_HOST`, `SMTP_PORT`,
`SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` - in the untracked `.env` **and** the
compose `environment:` block, like `JWT_SECRET`; missing the compose half means
the container never sees them. **Log `mailErrorInfo(err)`, never the error
object** - a nodemailer error carries `auth.pass`, which is the same bug shape
as the axios error that printed the Jellyfin `Token="..."` into the log.

New error codes: `ADMIN_RESET_BLOCKED`, `CODE_REQUIRED`, `INVALID_CODE`,
`CODE_EXPIRED`, `TOO_MANY_ATTEMPTS`, `EMAIL_NOT_VERIFIED`,
`EMAIL_REQUIRED_FOR_ADMIN`, `LAST_ADMIN`, `SMTP_NOT_CONFIGURED`,
`SETUP_CODE_INVALID`, `ALREADY_INITIALIZED`.

## Database schema

Auto-created / updated at startup via raw SQL in `ensureDatabaseSchema()`.
Production does **not** run `prisma migrate`; keep
`backend/prisma/schema.prisma` and the raw SQL in `backend/src/index.ts`
in sync when adding columns/tables/indexes.

Tables / columns:

- `User` - `sonarrTrusted` (default 0: does this account's list add shows to
  Sonarr; admins count regardless - see *Trusted users' lists are requests*),
  plus four account-security columns: `email` (nullable, **not
  unique** - a household may share one, and nothing looks a user up by it),
  `emailVerifiedAt` (non-null is the entire protection rule), `isAdmin`
  (default 0; the bootstrap in `ensureDatabaseSchema()` sets it on
  `ADMIN_USER_ID` **only when no admin exists**, so demoting that account is
  not silently undone on the next restart), and `tokenVersion` (default 0,
  bumped on every password change; `requireAuth` rejects a mismatch, and a
  **missing `v` claim reads as 0** so the hand-minted tokens in `tools/` keep
  working).
- `AuthCode` - `userId` (indexed with `purpose`), `purpose`
  (`reset`|`verifyEmail`), `codeHash` (bcrypt), `expiresAt`, `attempts`,
  `consumedAt`, `createdAt`. **Deliberately carries no foreign key**: SQLite
  cannot add one to an existing table without rebuilding it, so a user delete
  clears these rows explicitly instead.
- `Settings` - per-user record storing theme, title language, autoplay,
  hide-from-compare, JSON columns `nicknameUserSel` and `subtitlePrefs`,
  and `addWatchedTo`.
- `WatchList.userId` - foreign key `ON DELETE RESTRICT ON UPDATE CASCADE`, the
  same on every deployment: the long-lived databases got it from the original
  Prisma migration, and the raw SQL said `CASCADE` until 2026-10-13, so a fresh
  install deleted differently. Deleting a user clears its rows explicitly.
- `WatchList.watchedRank` - integer; 0-based rank assigned after a show is
  watched and ranked in the Randomize page. A sidebar save that marks a show
  watched leaves it unranked (`null`), and unranked sorts LAST everywhere -
  `/api/public-list` uses `nulls: 'last'` because SQLite sorts NULLs first.
- `WatchList.hidden` - boolean; when true the show is skipped by the
  Randomize wheel.
- `AppConfig` - server-wide key/value config (`key` TEXT PK, `value` TEXT).
  **Everything in it that caches an upstream answer is persisted for one
  reason**: the load it guards against is *caused* by restarts, so an
  in-memory-only copy is empty exactly when it is needed most. Keys:
  - `jellyfinUrl` / `jellyfinApiKey` - written by `/admin` via
    `PUT /api/jellyfin/config`.
  - `anilistTmdbMap` - AniList -> `tv:N` / `movie:N`; the namespace is kept
    because TMDB numbers films and shows independently.
  - `anilistTvdbMap` / `anilistTvdbMapAt` / `anilistTvdbMapEtag` - the cached
    AniList->TVDB id map, refreshed at boot when the stamp is over
    `REFRESH_AFTER_MS` (12h) old and daily on a timer, conditionally via
    `If-None-Match`, never on the request path (why 12h is not a free choice:
    *The refresh clock and the alarm clock*). The ETag is stored **with** the
    pairs it validates and only sent when we hold them: a 304 against an empty
    map would leave us serving nothing and call it loaded.
  - `jellyfinLibrary` / `jellyfinLibraryAt` - the match corpus (~2,360 series
    as the playback account, 2026-10-09; the "836" figure elsewhere counts
    *anime folders*). Persisted because an in-memory copy made every restart
    refetch all of it - a dev session's reloads drove the Jellyfin process to
    ~800% CPU. Refresh is incremental (a `TotalRecordCount` probe, then only
    items past `minDateLastSaved` minus `LIBRARY_OVERLAP_MS`), with a full
    refresh weekly (`LIBRARY_FULL_REFRESH_MS`) because an incremental fetch can
    never reveal a deletion - see `getSeriesLibrary`.
  - `jellyfinFilmIndex` - TMDB film id -> item, so a film is never
    fuzzy-matched against TV series.
  - `jellyfinAvailability` / `jellyfinSourceDims` - the two per-item caches; a
    source-dims entry without `containerBitrate` predates `autoTier` and is
    re-probed.
  - `libraryAudit` - the last library check (English subtitles across the
    series in scope, and which ones Jellyfin had out of date); display-only,
    persisted so `/admin/sonarr` can show it without asking Sonarr or Jellyfin
    on a page load.
  - `anilistRateLimit` / `anilistBackoff` - the last observed AniList budget,
    and per-season cooldowns after a 429.
  - `subtitleDownloadHealth` - is the trailer download path working (*Knowing
    when it breaks*); its `lastFailKind` is what arms the bot-wall hold on
    `/stream`.
  - `subtitleLocalRunStatus` - the Sunday GPU run's own verdict, posted to
    `/local-run` - the only record the server has that it ran.
  - `subtitleBatchStartedAt` - when a SCHEDULED batch last started, written
    before the spawn for the scheduler's once-a-night guard; separate from
    `subtitleBatchStatus` because that is written at the child's exit and so is
    absent for a run the restart interrupted.
  - `subtitleBatchStatus` - the last completed batch run (`batchStatus` in
    `routes/translate.ts` is in-memory and a deploy is a restart, which is
    exactly when someone opens `/admin/subtitles`); written at **both** exits,
    because "ran and failed" must stay distinguishable from "never ran".
  - `sonarrPushRanAt` - when a scheduled push last got past its gates; a
    refusal leaves it untouched, so a transient one does not consume the day.
  - `upstreamHealth` - one row holding every upstream service's record (one
    read, one atomic write, no per-service key sprawl).
  - `alertSettings` - master switch, per-service toggles, extra recipients and
    the maintenance window (a row saved before that field existed reads as the
    default schedule, on); deliberately NOT the SMTP connection, which stays in
    `.env`.
  - `remoteSweepStatus` - the last identity sweep's summary, persisted because
    "did the resolver run, and what did it do" must survive the restart that
    follows a deploy. `remaining` / `retired` as on `/identity/resolve`,
    `gapFill` what the TVDB check did, `mapReplaced` the guesses handed back to
    the map, and `tracked`/`unmatched`/`cooldown`/`never`/`ready` plus `tiers`
    the whole-cache counts behind the all-seasons row - `tiers` from
    `classifyMatch`, the *same* classifier `/identity/resolve` uses per row, so
    the two scopes reconcile. Costs no provider calls.
  - The Sonarr keys (`sonarrUrl`, `sonarrApiKey`, `sonarrTags`,
    `sonarrMarkerTag`, `sonarrRootFolder`, `sonarrQualityProfileId`,
    `sonarrSeriesType`, `sonarrSeasonFolder`, `sonarrPushEnabled`) are listed in
    the root guide.
- `SeriesIdentity` - our AniList->TVDB/TMDB **overrides**: `anilistId` INTEGER PK,
  `tvdbId`, `tmdbId`, `tmdbKind` (`tv`|`movie`), `source`, `confirmed`,
  `rejected`, `pending`, `resolverVersion` (which resolver decided the row -
  `RESOLVER_VERSION` in `seriesIdentity.ts`; rows below it are re-resolved by
  the sweep's re-grade pass, and stamping on write is what makes that
  self-terminating), `candidates` (JSON, the top five), `matchedTitle`, `note`,
  `year` (release year from whatever source named the identity - display only,
  never matched on; stored at accept time, legacy rows dated by a capped remote
  pass, carried through the admin lookup/Confirm), `updatedAt`.
  - `pending` marks a row the remote resolver could not verify - it still
    counts (resolver ids are positive-only) but it is what `/admin/matching`
    lists for review.
  - **`rejected` has to be its own column** - it means "definitively not in the
    library" and must suppress the *title* fallback as well as the map.
    Inferring it from "confirmed with no ids" is ambiguous (confirming a good
    title match also leaves the id boxes empty); that ambiguity shipped and made
    Reject a no-op that still looked like it worked. A rejection
    short-circuits *before* matching, or its id-less row would fall straight
    through to the title tier - the very match being rejected.
  - An overlay over the community map, not a copy (root guide). Written from
    `/admin/matching`; loaded into memory at boot because it is read on every
    availability lookup.
- `SubtitleCache` - `videoId` unique, `mediaId`, `modelName`,
  `hasEnglishSubs`, `lastEnCheckAt`, `subtitlesDisabled`, `hasBurnedInSubs`,
  `segments` JSON, `createdAt`. Caches check results, translated segments, and
  user subtitle preferences per YouTube video. `modelName` rank order (upload
  only upgrades to an equal-or-higher rank): tiny < base < small < medium <
  large-v2 < large-v3 < **large-v3-split** (the local champion pipeline). The
  rank table has **one definition per language** (root guide):
  `lib/subtitleReport.ts` (`routes/translate.ts` imports it) and `MODEL_RANK`
  in `backend/scripts/translate_stream.py` (`batch_translate.py` and
  `tools/local_translate.py` import it). `test_run_verdict.py` asserts the two
  are equal and that neither script redefines it.

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
