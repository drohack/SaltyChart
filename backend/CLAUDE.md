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
file, because a rule that isn't loaded when it matters is not a rule: the
Jellyfin API key never reaching a browser, the `tools/bench_player.py`
transcode-cache hazard, the YouTube download pacing that keeps batch runs off
the bot wall, bumping `RESOLVER_VERSION` when a change would decide a stored
row differently, keeping skyhook off a viewer's request path, the raw-SQL
schema path being authoritative in production, and the `modelName` rank table
having exactly one Python definition (`translate_stream.py`, which
`tools/local_translate.py` imports).

---

## Jellyfin integration routes (`/api/jellyfin`)

Requests go out through the **official `@jellyfin/sdk`** (MPL-2.0, zero deps).
`backend/src/lib/jellyfinApi.ts` owns the client: one memoized `Api`, one auth
header, one `DEVICE_ID`, the typed `deviceProfile()`. The route file keeps
caching, matching and proxying; only the wire calls moved. Why it was worth
it: the two costliest bugs here were *guessed fields* - a `DeviceProfile`
missing `videoBitRate` silently returned a 416x234 stream, and
`SubtitleProfiles: [{ Format: 'ass', Method: 'Encode' }]` (the field burn-in
turns on) was found by poking the API. Both are generated SDK types now; a
snapshot test asserts the typed profile is byte-identical to the hand-written
one it replaced.

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

An API key authenticates but does not *identify* - and Jellyfin needs a user
to apply policy against: PlaybackInfo **silently drops `TranscodingUrl`** from
an otherwise-valid response when no user id is sent, which reads exactly like
a rejected DeviceProfile. So a **playback account** is picked on `/admin`
(`jellyfinUserId`, falls back to an administrator). Use a dedicated non-admin
account (this deployment: `SaltyChart` - verified the full player suite passes
non-admin) with library access and no bitrate/parental limits. Nothing is
written to its watch history: Jellyfin only records progress a client reports
to `/Sessions/Playing`, and this proxy never reports (verified:
`playCount=0, lastPlayed=never` after a day of repeats).

**"Direct stream" still runs ffmpeg and still writes to the transcode cache.**
Browsers can't play MKV, so every playback is remuxed into MPEG-TS for HLS -
cheap on CPU, identical on disk to a real transcode:

| mode | ffmpeg | re-encodes video | writes to transcode dir |
|---|---|---|---|
| direct play | no | no | no |
| **direct stream (remux)** <- what we do | **yes** | no | **yes** |
| transcode | yes | yes | yes |

Two consequences that have both bitten: Jellyfin's ffmpeg **writes segments
until the whole file is done regardless of the playhead**, and its cleanup
timers don't keep up for remux jobs (jellyfin#16608) - an abandoned session
leaves most of a ~1.4 GB episode on disk, which is why the pop-up pre-warm
never touches the HLS manifest and why `tools/bench_player.py` must not be
run casually (nine cold runs once filled the transcode cache and Jellyfin
served 0-byte segments - indistinguishable from an app bug). And keeping
subtitles out of the video avoids the third row, not the second.

Routes (contracts here; each guard's story is commented at its code):

- `GET  /status` - `{ configured, isAdmin }` probe (JWT). `isAdmin` rides
  along so the header's Admin link doesn't 403-spam an admin-only endpoint;
  fetched once per login by `stores/jellyfin.ts`.
- `POST /availability/batch` - `{ items: [{ mediaId, titles[], startDate? }] }`
  (max 100) -> map of the single-route shape. Randomize asks about every wheel
  item in one request (was ~50 POSTs and 40% of this router's budget per page
  load). Shares `resolveAvailability()` with the single route; per-entry
  `unknown` preserved - one failed show neither contaminates others nor gets
  cached.
- `POST /availability` - `{ mediaId, titles[] }` -> is the series in the
  library + the entry's season's first episode (season parsed from
  "Nth Season"/「第N期」; missing season = unavailable). Returns `{ available,
  seriesId, itemId, mediaSourceId, episodeTitle, seasonNumber, episodeNumber,
  libraryTitle, matchedBy }`. The series list is cached 1 h and served
  stale-while-revalidate (`getSeriesLibraryFresh` is the blocking variant for
  `fresh: true` callers). **`Fields=ProviderIds,OriginalTitle` is mandatory**
  on that query or Jellyfin returns `ProviderIds: null`, silently disabling
  the id tier. Per-mediaId cache 1 h positives / 10 min negatives, persisted
  to `AppConfig.jellyfinAvailability`. `fresh: true` bypasses the cache and
  re-resolves (library refetch throttled to one per 30 s - per-negative
  refetches once stampeded); it exists because a cache that survives restarts
  turned `test_jellyfin`'s id-tier proof into a recording. Always 200 -
  server down/unconfigured is `{ available: false, unknown: true }` (never
  cached). Carries **`idConfident`** - do we actually KNOW which show this is:
  a community-map id, a human decision, an admin's manual override, or a
  resolver id a DATE vouched for (`isDateVerified` - the air-date,
  premiere-date and TVDB-season-premiere rungs, and deliberately NOT `exact
  title` or `release year`, the Echo and coincidental-sibling classes). It
  gates the viewer's correction picker, and `unverified` follows the same rule
  so the pop-up's "unconfirmed match" badge can't fire on a row /admin/matching
  renders green. **A viewer pick is NOT confident**: it is unconfirmed by
  construction and queued for review, and treating it as settled hid the
  picker - and the undo inside it - the instant someone used it. Verdicts
  cached before the field existed lack it and read falsy until they expire.
  **`unknown` is load-bearing**: "couldn't ask", not "not in the
  library"; every consumer must refuse to hide on it.
- `GET  /playback/:itemId` - one call: `playSessionId`, `mediaSourceId`,
  subtitle streams (with the file's own flags + codec), font attachments.
- `GET  /stream/*` - GET-only streaming proxy (JWT header or `?token=`).
  Forwards `Range`, destroys upstream on client disconnect. **Manifests are
  buffered and refused if they contain a credential** - Jellyfin embeds the
  caller's key into HLS subtitle rendition URIs, so never send
  `subtitleMethod=Hls`; this guard makes "the key never reaches a browser" a
  guarantee rather than a convention.
- `GET  /subtitles` - proxies Jellyfin's own conversion. `format=ass` is a
  pass-through of the original; `format=vtt` lifts `Region:` lines into the
  header (`liftVttRegions` - Jellyfin emits them after the header closes,
  costing a console error and a dropped cue; the lift is cheap because
  Jellyfin repeats placement on every cue).
- `GET  /attachments` - an embedded font. Off the playback path since burn-in
  (kept + tested: it is the only way to inspect what a release ships).
  **Indices are the file's own stream numbers** - they must come from
  `/playback` or every request 502s. Both this and `/subtitles` send
  `Cache-Control: private, max-age=86400` (immutable per item+index).
- `POST /playback/stop` - `{ playSessionId }`; tears the transcode down
  rather than leaving it to time out on a shared box.
- `GET/PUT /config` + `POST /config/test` - admin only. Read returns URL,
  `apiKeySet`, `userId` - never the key. On save, an empty key **and an empty
  URL** keep the stored values (the URL was once written unconditionally, so
  Save on a blank form replaced a working address with the placeholder); an
  empty `userId` is a real choice ("fall back to an administrator"). Test
  hits authenticated `/System/Info`, so green proves the key works, not just
  reachability.
- `GET /users` - admin only; ids + names for the playback-account picker.
- `GET /identity` - admin only; every override row.
- `POST /identity/resolve` - admin only; `{ mediaIds[], years?, titles?, dates? }` (max 200) ->
  what we believe about each and where it came from. Pairs with
  `/availability/batch` on `/admin/matching`: that says *whether* a show
  resolved, this says *which id* and whether a human confirmed it. Unmatched
  rows carry `retry` (`eligible` / `cooldown` + `nextRetryAt` / `retired`,
  from `retryStateFor` - the tier arithmetic's one home) and `tier` from
  `classifyMatch` (`id`/`title`/`notHeld`/`noMatch`, the sweep's own
  classifier, so the admin panel's per-season and all-seasons rows agree by
  construction). `years` and `titles` are the optional mediaId-keyed maps those
  two computations need, sent by the page because nothing stored on a miss row
  records them. `dates` is a third: day-precision premieres, feeding
  **`settledByDate`** - did the entry's own premiere date SEPARATE a
  multi-candidate row, so the review queue can stop asking about a match nothing
  disputes. A year cannot serve there (the rule measures a 31-day gap and a year
  is 365 days of slack), and a caller that sends no `dates` settles nothing -
  the honest default, and the first thing `test_candidate_separation.py`
  asserts. Carries `sweep` - the last resolver
  sweep's persisted summary (`AppConfig.remoteSweepStatus`), written at BOTH
  sweep exits because "ran and found nothing" must be distinguishable from
  "never ran"; a corrupt row parses to null, never a throw. `remaining` counts
  what future runs will actually process (cooldown and retired rows excluded -
  the first shape counted every unmatched entry, so it could never reach 0);
  `retired` counts old misses no longer re-asked.
- `POST /identity/sweep` - admin only; starts a **drain** sweep (per-run cap
  *and* retry cooldowns dropped, pacing kept) and returns `202 { started, running }`
  immediately - a drain over a cold-start backlog runs for minutes, so
  nothing awaits it; `_running` in `remoteIdentity.ts` is the concurrency
  guard, and progress lands in the `sweep` summary above. 503
  `NOT_CONFIGURED` / `IDENTITY_NOT_READY` when it can't start. Exists because
  a cold start (new deployment, 245-entry backlog) used to mean one container
  restart per capped run.
- `GET /library/search?term=` - **viewer-gated** (JWT only, no admin), the one
  exception among the identity endpoints. Ranks the cached library + film index
  for the Watch pop-up's picker (`lib/libraryPick.ts`); in-memory, no Jellyfin
  calls. Items carrying neither a TVDB nor a TMDB id are never offered - a pick
  is stored as an id override, so an id-less item cannot be pinned. It DOES use
  a contains tier, unlike `matchSeries`: a human is choosing, so hiding the
  right answer is the only real failure.
- `GET /library/image/:itemId` - **viewer-gated**, `?token=` like the stream
  and subtitle proxies because `<img>` cannot send a header. Proxies the
  library item's Primary poster (the key stays server-side as always), 404s a
  missing one so the picker needn't special-case it, cached a day. Posters
  exist because a franchise's entries differ by one word and the cover is how
  a human tells them apart.
- `POST /identity/unpick` - **viewer-gated**; `{ mediaId }` clears the override
  so the entry falls back to the automatic match. Same 409 guard as the pick:
  a human decision is never touched. A pick a viewer cannot reverse is worse
  than no pick.
- `POST /identity/pick` - **viewer-gated**; `{ mediaId, itemId }`. The ids
  written are read off OUR library row, never taken from the request. Refuses
  with **409 `ALREADY_SETTLED`** when the stored row is confirmed or rejected -
  nothing else guards those (`setIdentityOverride` upserts unconditionally), so
  without it a viewer could silently undo an admin's Reject. Stored as
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
  merged with Jellyfin's TMDB results (degrades to TMDB-only when skyhook is
  down); `tvdb:12345` / `tmdb:12345` resolves a pasted id (prefix required -
  bare digits are real titles: *86*). Results are completed both ways via the
  held library and the community-map cross-walk (this Jellyfin's own remote
  search returns TMDB ids only - measured on all 342 stored candidates),
  carry a `library` tag and a display `year`, and an unheld `tmdb:` paste is
  still named via the identify-by-ProviderIds search. Never on a viewer's
  path; reads only cached data.

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
measurement.** A Custom List is a declarative set that Sonarr reconciles on a
hardcoded ~5-minute Import List Sync (Sonarr#5927), so a series deleted from
Sonarr was re-added on the next poll for as long as its season stayed in scope -
3 to 6 months, since `isWithinAirWindow` stays true once a show has aired.
Watching for the deletion could never fix it: the snapshot is hourly against a
5-minute poll, so a still-listed series is only ever seen *held*. Retiring
entries from the list instead would have been worse - Sonarr's
`config/importlist.listSyncLevel` is **global** (shared with every other import
list) and unmonitors library series that fall off all of them, with an open bug
where dropping one unmonitors all (Sonarr#7555). Measured on the live instance
2026-08-10 it is `disabled`, but correctness would have depended on a setting we
do not own. `lib/sonarrPush.ts` holds this argument at the code.

- `GET /push/preview` - admin; what a push would do, **writing nothing**:
  `toPush`, `deferred` (held back by the cap), `skipped` (each with its reason),
  `problems` (setup still outstanding), `enabled`, `cap`. It does *not* perform
  the TVDB lookup - that is one round trip per candidate and this is a page load
  - so a bad id surfaces as a `lookupFailed` row after a real push instead.
- `POST /push` - admin, and **the only thing in this codebase that writes to
  Sonarr**. Gated in order: the master switch, then config completeness, then tag
  resolution; each refuses before a single `POST /api/v3/series` goes out.
  Per series it does `GET /api/v3/series/lookup?term=tvdb:<id>` (the validity
  check, and the source of the object we post - hand-building it means guessing
  at fields that change between versions) then the add.
- `GET /report` - **admin**; everything `/admin/sonarr` renders, in one payload:
  candidates with a `state` (`willBeAdded` / `addedByUs` / `pushedAlready` /
  `heldAlready` / `excludedInSonarr` / `lookupFailed` / `failed` / `unknown`),
  the per-gate rejection breakdown, the push log and orphans. **It degrades
  rather than failing** - with Sonarr unreachable it still returns the whole
  candidate side with `sonarr.observed: false`, because an outage is exactly when
  someone opens the page. The UI must not collapse `unknown` into zero:
  "couldn't ask" is not "nothing to do" (the headline did exactly that once and
  was caught in a browser, not by any test).
- `PUT /enabled` - admin; the master switch, **`sonarrPushEnabled`, default
  off**. Deliberately a new key rather than a rename of the list era's
  `sonarrListEnabled`: reusing it would have inherited an existing `true` and
  turned a list that merely *offered* series into a job that *adds* them, on the
  first restart after deploy, with nobody having chosen that.
- `POST /snapshot` - admin; caches what Sonarr holds. `GET/PUT /config`,
  `GET /config/options` (root folders, quality profiles and tags for the setup
  dropdowns), `POST /config/test`, `POST`/`DELETE /include` - admin.
- **Reads `SeasonCache` only, and never calls `startColdFetch()`.** It serves a
  stale row happily; freshness is irrelevant here, which is also why there is no
  second copy of `SEASON_TTL_SECONDS` to drift. A never-fetched season simply
  contributes nothing, and a cached-but-empty one (`SUMMER 2027` was `"[]"`)
  means "asked, nothing yet" rather than "not cached". It reads the `''` format
  key - the `'TV'` row would silently drop every TV_SHORT.

**What Sonarr decides vs what we send.** Under the Custom List, Monitor, Series
Type, root folder, quality profile and tags were all the import list's settings,
typed in by hand and unverifiable from here. We send them now, which is the other
reason the push is better: `addOptions.monitor: 'firstSeason'` is the locked
"whole first season" decision expressed directly, rather than depending on
someone setting `shouldMonitor` correctly. `searchForMissingEpisodes` is **off** -
for an upcoming season there is nothing to search for and RSS picks episodes up
as they air; an already-`FINISHED` entry therefore sits in Sonarr until someone
hits Search, which `/admin/sonarr` says out loud.

**Tags must already exist in Sonarr.** Labels are resolved to ids with
`sonarrTags()` and a missing one **blocks the push** rather than adding untagged.
Creating them would mean a second write verb, and an untagged series is invisible
to Maintainerr's scoping - a failure that would only surface as a cleanup that
quietly did nothing.

**One of those tags is the marker, and only it means "we added this".**
`sonarrMarkerTag` (default `saltychart`) is forced into the applied set on both
read and save, so nothing we add can lack it. The others are shared library
conventions and must never be read as ownership: `anime` is applied too and sits
on **692 series** here, so a version that asked "does it carry any of our tags"
reported two shows the owner had for years as ours. Measured on the live instance
2026-08-10, and it has its own mutation row.

**The marker is a second, independent record of what we added, and it exists
because `SonarrPush` is not enough.** A database does not follow you from dev to
production and does not survive a restore from an old backup; the tag lives in
Sonarr beside the series. Neither source is complete on its own - the record
misses anything added before that database existed, the tag misses anything since
deleted (a series that is gone carries no tag) - so `history.ours` is their
**union**, and `history.pushed` / `history.tagged` are reported separately so a
reader can see which one is talking. Hand-tagging a series is therefore a
legitimate way to say "this one is ours".

The selection itself is `lib/sonarrSelect.ts`: pure, I/O-free, resolver injected,
so every predicate is unit-tested without a DB. The identity filter is
**`tvdbId && !pending && !rejected`** - deliberately not `confirmed`, since a
community-map row is unconfirmed by construction and requiring confirmation
would discard the ~94% of TV the map answers. `pending` *is* excluded, and this
is the one path stricter than the site's: elsewhere an unverified resolver id is
positive-only because a bad guess costs a Watch button that doesn't work; here
it downloads a season of the wrong series.

Measured 2026-08-06 on the live cache: 39 proposed from SUMMER 2026's 111 cached
entries; 157 excluded across both seasons (66 not TV/TV_SHORT, 50 with a
PREQUEL/PARENT edge, 37 outside the 14-day air window, 4 with no usable id), and
**zero duplicate TVDB ids** in any season or across the pair.

### How well do we know each match - `matchGrade`

`lib/seriesIdentity.ts` owns the ladder, and it is the **only** definition:
`matchGrade()` returns `confirmed` / `adminOverride` / `map` / `dateVerified` /
`viewerPick` / `weak` / `none`, and `isIdConfident()` derives the boolean the
Watch pop-up's correction picker uses. `routes/jellyfin.ts` computed that inline
until `/admin/sonarr` needed the same answer; a correctness rule with two copies
is one that can disagree with itself.

The distinctions each came from a real mistake: a map id is unconfirmed by
construction and still the best thing we have; an **admin** override is settled
but a **viewer pick** is not (counting it as settled once hid the picker, and
the undo inside it, the instant anyone used it); and a resolver id is only as
good as its rung - a **date** vouching for it is as settled as a map id, while
`weak` means title text or a +/-1 year, the class that offered *Echo* a namesake
**1,012 days** from its premiere.

**The override needed its own guard.** `selectForSonarrDetailed`'s force-include
branch skipped `usableTvdbId` entirely, so `tvdbId && !pending && !rejected`
never applied to overrides - **22 candidates carried a pending identity** when
this was measured. `POST /include` now answers **409 `UNVERIFIED_MATCH`** (with
the grade and what it matched against) unless the caller sends
`acknowledgeUnverified`, and `SonarrInclude.acknowledgedUnverified` records that
someone was told. An override may outrank the filter; it may not do so blindly.
Two mutation rows guard it - the pure check and the 409 - because the UI asking
is a courtesy and the endpoint is the actual guard.

Measured 2026-08-10: the **automatic** list is already clean - 30 `map` +
9 `dateVerified`, **zero weak**. This work is about the override, not the filter.
If a proposed row ever grades `weak`, the filter has regressed, and
`test_sonarr.py` step 9 fails on exactly that.

### What the history line can honestly say

`SonarrPush` is the record of what has already happened, and **only a 201 from
Sonarr writes a `pushed` row**. That, plus the marker tag described above, is
what makes "we added N" sayable at all.

The Custom List era could not say it. Its record was `SonarrSeen.firstHeldAt`,
which meant "when a snapshot first *observed* this held" - measured on this
deployment, all 36 rows shared a single `firstHeldAt`, the instant the first
snapshot ran, for a library owned for months. Rendering that as an add date
would have been a confident, plausible lie about someone's own library, and the
header had to say "tracking since" instead.

`history.alreadyHeld` stays a **separate** count for the same reason: those
series were in Sonarr before we got there. A mutation row guards the tempting
simplification - count every *tagged* series rather than only marker-tagged ones -
which would claim credit for the entire library.

`lookupFailed` and `failed` are the actionable statuses. Both mean nothing was
added and both are retried, so a row that persists is a real problem: a
`lookupFailed` is a wrong TVDB id, which is a `/admin/matching` job.

### One add per series, and what that replaced

A terminal row (`pushed` or `alreadyHeld`) means we never consider that tvdbId
again. Deletion by Maintainerr, by hand, for any reason - it stays gone, and
crucially **we do not have to observe the deletion for that to hold**. The old
design did, and could not: it needed to catch a delete before Sonarr's ~5-minute
poll re-added it, from an hourly snapshot.

- **Retries exist only where nothing was added.** `lookupFailed` (Sonarr does not
  know the id) and `failed` (Sonarr unreachable, or refused) stay retryable,
  because both are fixable and neither left anything behind. A corrected identity
  produces a *different* tvdbId, which has no terminal row and pushes fresh -
  that is the only intended second attempt, and it falls out of keying on tvdbId.
- **`alreadyExists` from Sonarr is terminal, not a failure.** The held set comes
  from a cached snapshot, so a series added between snapshots answers 400 "already
  been added". Recording that as failed would leave it retryable and it would be
  retried on every run for ever - the same infinite loop arriving through the
  error path. `classifyAddError` is pure and unit-tested for exactly this.
- **A failed or empty read of `/api/v3/series` must never be trusted.** "Could
  not ask" is not "the library is empty", and taking an empty read at face value
  would make every held series look like a new candidate - a burst of duplicate
  adds. The push refuses outright without a trusted snapshot. (Consequence worth
  knowing: a genuinely empty Sonarr also reads as "could not ask", so a brand new
  install needs that guard revisited before its first push.)
- **Sonarr's Import List Exclusion is honoured but not required.** It does not
  bind `POST /api/v3/series` - an explicit add succeeds regardless - so we skip
  anything on it as a human's stated intent. Maintainerr writing one on reap is
  now belt-and-braces; it was mandatory only because the list would otherwise
  have re-added things.
- **Orphans need a human.** Correct an identity after we already added the wrong
  series and Sonarr keeps the wrong one while we add the right one. We have no
  delete verb, so `/admin/sonarr` names the deletion to make by hand.

### How Sonarr gets this, and what we decide for it

One connection, one direction:

```
  SaltyChart  --(GET /api/v3/series/lookup, POST /api/v3/series)-->  Sonarr
```

Configuring Sonarr's URL + API key on `/admin` is now the whole wiring. **No
Import List is created in Sonarr**, and any left over from the Custom List era
should be deleted - it would keep re-adding whatever it last read.

**Setting it up**, all on `/admin` -> Connection:

| field | value | why |
|---|---|---|
| URL + API key | Sonarr -> Settings -> General -> API Key | the same key does the lookup and the add |
| Root folder | the anime share | must match one of Sonarr's own paths exactly; a dropdown for that reason |
| Quality profile | the anime profile | applied to every series we add |
| Series type | Standard | how releases are matched to episodes; Anime enables absolute numbering |
| Tags | `anime, saltychart` | **must already exist in Sonarr**; all are applied to every add |
| Marker tag | `saltychart` | the one that means *we* added it, and what Maintainerr scopes on; always applied |

Measured on the live instance 2026-08-10: root folders `/media/TV Shows` and
`/media/Anime`; tags `anime` (5, on 692 series) and `saltychart` (37) both
present.

**Monitoring and search are ours to send**, and are not configurable per
deployment on purpose: `addOptions.monitor: 'firstSeason'` (the Seerr
`PARTIALLY_AVAILABLE` rule above) and `searchForMissingEpisodes: false`.

**A quality profile invalidates the size estimate.** The 0.38 GB median comes
from the current mixed-quality library, so under a 720p-only profile the page
reads high. The page says so; re-measure rather than quietly trusting it.

**Tags come from the import list's configuration, not our payload**, so one list
means one tag set. Set `saltychart` on the import list and Maintainerr can scope
cleanup to what we added. A per-season tag would need one import list per season,
and a pinned `?season=` list **never expires** (`isWithinAirWindow` treats
`FINISHED` as aired forever) - that is the re-add loop by construction. Age
(`Plex.addDate`) gives the same granularity. `/report` counts how many held
series carry the tag, because a typo there fails silently by scoping Maintainerr
to nothing.

Graded against the held library over WINTER + SPRING + SUMMER 2026: **119
proposals, zero wrong exclusions.** Every held entry the list declines is either
a sequel/later cour (27) or a non-TV format (14) - both deliberate. Proposals
per season are stable (36 / 44 / 39); what swings is how much is currently held
(14 / 3 / 36), which the library alone cannot attribute to "never grabbed"
versus "grabbed and since deleted".

**Why ONA stays excluded is precision, not id coverage** - and the distinction
matters, because the coverage figure is the one a future reader will find first
and it does not support the decision. Over those three seasons: 51 ONA entries,
30 of them first-season, and **27 of those resolve to a usable TVDB id** - so
coverage is fine here (that is not in tension with the map-only "ONA is 40%"
figure under *The two availability tiers*; this number includes our own resolver
rows). The problem is that only **3 of the 27 were wanted**. Nothing separates
them: the three held span popularity 213,444 / 44,384 / **18,042**, score 85 /
78 / **68**, favourites 10,599 / 1,812 / **314** - Hana-Kimi sits below
seventeen unheld entries on every axis. `duration` and `episodes` DO cleanly
identify short-form and non-full seasons (1-5 min/ep, or 3-7 episodes), but
removing those still leaves 21-for-3. Three positives is far too few to
establish a threshold and quite enough to refute one, so **do not add a quality,
popularity or score heuristic here** - that is the `isRelation` guard's mistake
in a new costume. Full-length ONA belongs to a human request path (the site
already renders them in its OVA/ONA/Special section), not to auto-add.

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
`/api/sonarr` it **never triggers a cold AniList fetch** - it serves a stale row
happily, and reads the `''` format key (the `'TV'` row would drop every
TV_SHORT). Defaults to the current season plus the next (`seasonsForSonarr`);
`season`+`year` override it, both or neither. It returns `overall` (aggregates
over the whole `SubtitleCache`), `schedule`, per-season `counts`, and one row per
trailer carrying a single `state` from `lib/subtitleReport.ts`.

**`cached: false` on a season means there is no `SeasonCache` row at all**, and
is deliberately distinct from a row holding `[]` ("we asked, nothing yet"). The
page must render the first as *not cached*, never as zero work.

**The state ladder is `lib/subtitleReport.ts` and only there** -
`ourSubsOff > burnedIn > youtubeCc > translated > checkedNoSubs > never`, with
the argument for each rung at the function. One rung is easy to get wrong twice
over: `youtubeCc` outranks `translated` because CC is *why* the pipeline skips a
video, and **`never` is about evidence rather than about a row existing** - a
null `hasEnglishSubs` has no check verdict, and `PATCH /dismiss` upserts, so the
admin page's own subs toggle creates exactly such a row. Calling it "checked, no
YouTube CC" would claim work nobody did.

**What the schedule can honestly say.** The Wednesday medium batch is fully
described from `lib/batchSchedule.ts`, which `index.ts` and this route now share
so the page cannot name a night the job does not run; `wouldFireAtNextWindow` is
evaluated **at the window**, not at now, or the page promises a run the scheduler
will decline. The Sunday `large-v3-split` GPU run is a Windows Scheduled Task on
someone's PC; the server cannot observe it, so `lastChampionUploadAt` is only
*last upload seen*. **The run now reports itself**: it ends by `POST`ing its
`run_verdict` to `/local-run`, and `schedule.lastLocalRun` is that report. Until
it did, a run that produced nothing was indistinguishable from a quiet week -
four Sundays of 46/49 download failures left no trace an admin could see.

**Both batch scripts exit with a verdict, and both self-upgrade yt-dlp first.**
`run_verdict` in `translate_stream.py` (one definition; `local_translate.py`
imports it) turns the run-wide error count into an exit code: 0, **2 when at
least `RUN_FAIL_MIN` failures make up more than `RUN_FAIL_RATIO` of attempts**,
3 on a bot-wall abort - with a final `Done:` line naming the dominant failure
kind and its remedy (a 403 run says "stale yt-dlp, upgrade it"). Before that,
per-season errors were counted, printed and discarded and `main()` fell off the
end with exit 0 (Sundays 2026-08-23 through 2026-09-20; `tools/logs/translate.log`
is the record every "four Sundays" mention points at). **Every exit path of
`local_translate.py` goes through it** - `main()` ends in one `finish()`: the
season loop, `--video` (one attempt, counted), and a `--within-days` decline,
which now sits *after* login so it can report `Done: skipped - ...` (exit 0)
instead of leaving the server's card reading "did not run". A bot-wall abort
accumulates the season's counts before it breaks, or the verdict read "0 of 0".
The report is posted whenever the run authenticated and is not `--dry-run` /
`--no-upload`. These three exit paths have **no offline test** (the script
imports torch); the decline is verified live with `--within-days 0`, the other
two by compile and review.

`ensure_ytdlp_current()` runs before the first download unless
`--dry-run`/`--no-update`; it reads the version **out of process** on purpose -
importing `yt_dlp` first would pin the stale module in `sys.modules` for the
whole run - and never fails the run on its own. When pip is old enough to reject
`--break-system-packages` (pip < 23, "no such option") it **retries once without
the flag** rather than logging a polite failure and staying stale. **The live
daemon deliberately does not call it**: a viewer is waiting, it is a pip round
trip (6.2 s on the dev PC in the already-current case, measured 2026-09-20;
longer when it downloads), and the daily updater (`lib/ytdlpUpdate.ts`) plus the
daemon recycle covers that path. The rule is: the two off-hours batches check
every run; the live path never does.

Both check and stream query `SubtitleCache` first. On a hit, `/stream` sends a
`{cached: true}` SSE event then all segments instantly (~50 ms); on a miss the
daemon translates and caches on completion, and concurrent requests for the
same uncached video are deduplicated. `/check` returns `{hasEnglish,
subtitlesDisabled, hasCachedSegments, modelName}` - the first two hide the
overlay; the last two tell the local script whether to re-translate. Dismiss
state comes from the CC toggle and persists for all users.

YouTube caption control - three paths in `openModal`
(`AnimeGridTranslate.svelte`), driven by a page-load pre-fetch: `Home.svelte`
fires `check-batch` right after the anime list loads (~5 ms, DB-only) into
`prefetchedSubs` + `prefetchComplete`, passed as props to each grid.

- **A - confirmed English** (`prefetchedSubs.get(id) === true`): instant, no
  network; YouTube CC starts in English, translation never runs.
- **B - batch complete, not in map**: iframe opens immediately, Japanese CC is
  suppressed, translation starts; `/check` re-fires async and switches to
  YouTube English CC if Python has since confirmed it.
- **C - batch not yet complete** (clicked within ~5 ms of load): races
  `/check` against a 150 ms timeout, then behaves like B.

`check_subtitles()` uses `ytt.list(videoId).find_transcript(['en'])`, which
sees manually uploaded, auto-generated AND auto-translatable English CC (the
old `ytt.fetch(languages=["en"])` found only manual tracks).
`SubtitleCache.hasEnglishSubs` trusts positives forever and negatives for
**7 days** (`lastEnCheckAt`), so newly added CC is eventually noticed without
re-checking every play; a cache write never downgrades a stored true.

**The check has three answers, not two.** `check_subtitles()` returns
`hasEnglish: true` / `false` only when YouTube definitively said so
(`DEFINITIVE_NO_CC` in `translate_stream.py` - matched by exception class *name*
through the MRO, so the module stays stdlib-only at import for `yt_guard.py`);
an IP block, a PO-token demand, a network error, a timeout, or a missing
`youtube_transcript_api` all return `hasEnglish: null` plus `checkError`, and
**no write site pins a null**: `checkVerdict()` (`lib/subtitleCheck.ts`) gates
both route writes, and `batch_translate.py`'s upsert `COALESCE`s the stored
verdict and leaves `lastEnCheckAt` untouched. Before this every failure was
written as "no CC" with a fresh timestamp and trusted for seven days - one
transient block sent a captioned trailer down the download path for a week.
`youtube_transcript_api` must be installed locally (`pip install
youtube-transcript-api`); without it nothing is pinned and every trailer takes
the Whisper path. The class names were checked against 1.2.4 (2026-09-20);
`test_run_verdict.py` re-checks them against whatever is installed.

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
(torchcodec, qwen2.5, qwen-asr, kotoba) are all in its docstring. Data in
`tools/benchmark_data/` (gitignored); results consolidate into
`tools/benchmark_results.txt`, one delimited section per suite.

Findings that drive production settings (details in each bench's docstring):

- **Decode params**: `beam_size=10 + repetition_penalty=1.2 (+vad_min300)` is
  the best family for *transcribe*; the same params **hurt** end-to-end
  translate (e2e SCORE 1.0->-1.6) - they interact with the task, which is why
  only the fully-stacked run found the champion.
- **Demucs vocal separation helps** (~+6-8 SCORE, ~5-6 pp less hallucination)
  but only from full-quality source audio, never the 16 kHz mono input.
- **Champion (`split_best`)**: vocals -> large-v3 `transcribe` (tuned params) ->
  **qwen3.5:9b** translate via Ollama, SCORE 1.9 vs 1.0 end-to-end, better
  timing and hallucination, more natural English; residual weakness is
  mis-heard proper names. (qwen3.5:9b beat text-only qwen3:8b - content 57.3
  vs 53.6 - so it's kept despite its unused ~1.2 GB vision encoder.)
- **Japanese-specialised ASR lost on this domain**: kotoba-whisper-v2.0 (51.3)
  and Qwen3-ASR (52.2) both under large-v3 transcribe (55.8) - clean-speech
  leaderboard wins don't transfer to stylized trailer audio.
- **Live CPU** (`bench_live_cpu.py`): `small` wins both axes; tiny/base are
  slower AND worse. Transcription is ~8x faster than playback at 1 thread -
  the felt latency is the audio download, hence playhead-start and the
  single-pass download, not model changes.
- **Download** (`bench_download.py`): the ~1.2 s `worstaudio` baseline is the
  floor - every player_client override failed or was slower, and aria2c -x16
  was ~20-28x SLOWER. The cost is YouTube's extraction handshake, not
  bandwidth; the bench exists to prove there's nothing to chase.
- **Player startup** (`bench_player.py`): everything except Jellyfin's first
  HLS segment is under 0.25 s (segment: median 19.9 s cold, range 1.3-30).
  Our proxy adds ~nothing (0.02 s), the first stream request leaves the
  browser ~65 ms after the click, and pre-loading more cannot help. Two fixed
  non-inherent findings: a 30 s proxy idle-timeout that killed slow-but-working
  streams, and an `await` on the Cast SDK between click and manifest. Two
  methodology rules learned here: stop each run's encodings before timing the
  next (or you measure your own load), and measure the fonts the app actually
  sends, not the first N attachments.

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

**The mechanism, traced 2026-09-20 rather than assumed.** It is not a stale URL
signature, which was the first and wrong guess: the very URL yt-dlp 403s on
returns `206` when curl asks for it. The difference is the *shape of the
request* - YouTube caps how many bytes one request may take. Measured against
one 674,555-byte audio format, same URL each time:

| `Range` header | result |
|---|---|
| none (whole file) | **403** |
| `bytes=0-` (open-ended) | **403** |
| `bytes=0-499999` (500 KB) | **403** |
| `bytes=0-449999` (450 KB) | **206** |
| `bytes=0-100000` | **206** |

So it is **not** "send a Range header" - the range must be bounded *and* under a
cap somewhere between 450 and 500 KB **for that one video and format, measured
once** - YouTube can move the number; the shape (bounded) is the finding. A
whole-file GET cannot work at any size.
`2026.03.17` asks for the file in **one** unranged request and is refused;
`2026.08.19` fetches the same audio in **24** bounded requests and is served.
Same video, same options, no credentials either side.

**Why the "some videos work" part is the giveaway, not a contradiction.**
`GET /stream` serves a `SubtitleCache` hit and returns *before* the daemon is
involved, so every already-translated trailer keeps working while every new one
fails. That makes a total failure of the download path look selective, and it is
why this went unnoticed: nothing in the suite downloads a fresh video.

**Four mechanisms keep it current, and each reaches a machine the others do
not:**

1. `backend/Dockerfile` upgrades it in the runtime stage, **deliberately placed
   after the `COPY --from=builder` lines** - those layers change on every code
   deploy, so Docker cannot serve the upgrade from cache. Moved above them it
   would be cached forever, which is the original bug. Caveat: a rebuild of the
   *same* commit has no changed layer above it and hits the cache; (2) covers
   that. Check the first deploy's build log for the `pip install` step not
   reading `CACHED`.
2. `lib/ytdlpUpdate.ts` re-checks daily (and 5 min after boot), logging one line
   either way, and recycles the translate daemon when the version changed -
   Python caches `yt_dlp` in `sys.modules`, so a running daemon keeps the copy
   it imported. `recycleTranslateDaemon()` returns `recycled` / `busy` / `none`
   and the log line says which: `busy` means the **old** version keeps serving
   until the daemon's next respawn; `none` (not running is the idle norm) means
   the very next spawn already imports the new one.
3. `ensure_ytdlp_current()` at the start of both batch scripts - the only one of
   the four that reaches the **Sunday PC**, where nothing else runs.
4. `Dockerfile.base` still installs it, but that is only the offline floor - the
   base is rebuilt by manual dispatch only, so its copy ages by design.

**Do not pin a version.** Pinning is how this broke: the base image froze
whatever was current when it was built, and nothing ever moved it.

#### Knowing when it breaks - `lib/downloadHealth.ts`

Staying current is not enough on its own, because the outage was never hard to
*fix* - it was impossible to *see*. Cached trailers kept serving, the suite
stayed green (nothing in it downloads a fresh video), and the only symptom was a
chip in a modal that cleared itself after six seconds.

So every real download now records whether it worked, in
`AppConfig.subtitleDownloadHealth`. **It makes no requests of its own** - no
canary, no polling: the thing that breaks is YouTube's tolerance for our
traffic, so a health check that adds traffic is the wrong shape. The daemon tags
a failure with the `stage` it came from (`download` vs `transcribe`), because a
transcription error says nothing about whether downloads work.

**The signal is a streak, not a failure.** One failure is a private or deleted
trailer; `BROKEN_AFTER = 3` consecutive ones is the path being down for
everyone. It logs loudly exactly once, when the streak crosses - logging every
failure would bury it - and `/admin/subtitles` leads with a red banner naming
the reason, plus the "a 403 here is a stale yt-dlp, not auth" hint that took an
afternoon to establish the first time. Verified by driving the state machine:
clean at 1 and 2 failures, `broken` at 3 with one log line, no second line at 4,
and a success clears the streak and logs the recovery. The transitions are pure
(`failureTransition` / `okTransition`), so "once, at the crossing" is a unit
test and a mutation row, not a hope. Whatever `kind` the daemon sends is
normalised to `FAIL_KINDS` (`normalizeFailKind`) before it is persisted, and the
stale-yt-dlp hint (`looksLikeStaleYtDlp(reason, kind)`) hangs only on a
`forbidden` kind - a challenge can arrive as a 403 whose body says "confirm you
are not a bot", and a bare regex on the text would offer the wrong remedy.

**A dead video is not evidence, and a 403 is worth one retry.** Both come from
the same measured run (51 of 63 trailers downloaded, 12 failures):

- **6 were videos that no longer exist** - old trailers taken down. Five of them
  failed BACK TO BACK in SUMMER 2026 against a `BROKEN_AFTER` of 3, so the batch
  would have mailed *the download path is broken* while that same run fetched 51
  others. `countsTowardBroken` (pure, mutation-guarded) spares `unavailable` from
  the streak - it neither advances nor clears it, because a video that no longer
  exists is a fact about that video, not about us. The counters still move, so
  "how many trailers are simply gone" stays visible on /admin/subtitles. Same
  discipline as the upstream quiet window one section up: count failures, but ask
  what they MEAN before calling them an outage.
- **6 were 403s, and they were TRANSIENT** - proven, not assumed: one of them
  (Firefly Wedding) downloaded in full on a retry minutes later, 14 MB, 79 s,
  same yt-dlp and same options. `download_audio` now makes exactly **one** extra
  attempt after a short pause, and **only** for a `forbidden` kind. A dead video
  can never succeed and retrying a bot wall deepens the block that aborting
  exists to escape, so neither is retried - a mutation row guards that direction
  specifically, because it is the one that costs something. A failing video
  therefore costs 2 requests, never a loop.

Note this does NOT weaken the stale-yt-dlp signal: that failure is total by
mechanism - an unranged whole-file GET is refused for every video - so it
produces consecutive 403s across the whole run and still crosses the streak.

**Crossing that line also mails the admins** (`lib/subtitleAlerts.ts`): once
when the path breaks, once when it recovers, once per failed Wednesday batch
exit (`persistBatchRun`, any non-zero or signal exit), once per failed Sunday
report (`POST /local-run`), and once when the Sunday run has been **silent for
`LOCAL_RUN_SILENT_DAYS` (8)** - a daily timer in `index.ts`
(`checkLocalRunSilence`) stamps `silentAlertedAt` on the stored report so it
mails once per silence, and the next report replaces the row and re-arms it.
Recipients are admins with a **verified** address only (`verifiedAdminEmails`,
pure); with SMTP unconfigured it logs `would have sent` instead. Every trigger
is a state change, never a per-failure event - an alert that fires on every
failure is the alert that gets muted. **Residual gap, documented rather than
closed**: a Scheduled Task that never fires even once after deploy leaves no
report to be silent, so the timer logs `no Sunday run has ever reported` and
sends nothing.

`stage`, `raw` and `kind` are **stripped in `routes/translate.ts` before the
payload reaches a browser**. The raw text is operator detail; putting it on
screen is what sent the owner hunting for an authentication bug that never
existed.

**And when it breaks the OTHER way - YouTube refusing the server - it holds.**
The daemon classifies every download failure (`classify_error` in
`translate_stream.py`: one definition, also behind the viewer's message) and
sends `kind` with the error. A `botwall` kind - the challenge / 429 phrases in
`BOT_WALL_SIGNS` - makes `/stream` **refuse new downloads for `BOT_WALL_HOLD_MS`**
(`lib/downloadHealth.ts`; 15 min, **a guess and labelled as one** - nothing
publishes how long a YouTube soft block lasts) with the same friendly message
plus a `holdUntil` (the chip shows it as minutes), recording nothing;
`/check-batch` queues no background checks meanwhile (`X-Check-Queue: held`) and
`/check` answers from cache only. **One bot wall is enough** - it is YouTube saying "you", not
"that video", unlike the three-strike `broken` rule. A `forbidden` (403) failure
deliberately does **not** hold: that is the stale-yt-dlp signature, each attempt
fails fast, and the daily updater or a deploy may fix it any minute - holding
would hide the recovery the whole record exists to show. `botwall` is checked
before `forbidden` because a challenge can arrive with a 403 status.
`/admin/subtitles` renders the hold as its own warning line. Guarded by
`downloadHealth.test.ts`, `test_download_hold.py` and four mutation rows (the
stream gate, the check-batch gate, the check gate, and a 403 never holding).

#### The trap that sent us down the download path unnecessarily

`GET /check-batch` queued background checks only for ids it had no row for
(`!known.has(id)`), and built its map with `Number(r.hasEnglishSubs)`, where
`Number(null)` is `0`. Two one-way consequences:

- **A row existing is not a verdict.** `PATCH /dismiss` upserts a row, and so
  does caching translated segments. Such a row has a null `hasEnglishSubs`, was
  read as "already answered", and was never checked again.
- **null and "checked, no English CC" collapsed to the same value**, so nothing
  downstream could tell them apart.

Net effect: a video whose first view raced ahead of its check got a segments row
and then took the **download** path forever - including videos that have English
CC and never needed downloading at all. Measured on `8AnNxEp733c` (the trailer
that reported the 403): `check_subtitles` returns `hasEnglish: true`, the stored
verdict was `null`, and `/check-batch` returned `{}` without queueing anything.
**Detection was never broken; only its scheduling was.**

**A JS runtime must be present.** yt-dlp enables **only deno** by default, which
this image does not have; without one it warns *"some formats may be missing"*
and takes a path it calls deprecated. `download_audio` therefore passes
`js_runtimes: {"deno": {}, "node": {}}` - the runtime image is `node:20-slim`,
so Node is already there and costs nothing. Verified: `JS runtimes: node-22.16.0`,
challenge provider available, no warning.

**The viewer never sees the raw yt-dlp string.** `friendly_error()`
(`translate_stream.py`) maps it to something actionable and the raw text goes to
stderr for the log. The raw `HTTP Error 403: Forbidden` actively misled - it
reads as "SaltyChart must log in to YouTube", which is never true.

**Local GPU translation** - `tools/local_translate.py` runs the champion split
pipeline on this PC (requirements, pipeline, Ollama management, and fallback
behaviour are in its docstring) and uploads as **`large-v3-split`** (rank 6,
above plain `large-v3`, so older results auto-upgrade on the next run; use
`--force` to re-do everything). Operational facts that live nowhere else:

- Phase-1 downloads are **serial** with a delay (`--download-delay`, default
  `DOWNLOAD_DELAY_DEFAULT`) -
  parallel downloads tripped YouTube's bot wall, so `--download-workers` is
  ignored; a bot-challenge aborts the run. YouTube auth via `--cookies
  <cookies.txt>` (Netscape format; `--cookies-from-browser` fails on modern
  Edge/Chrome - App-Bound Encryption, yt-dlp #10927).
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
Scheduler -> Properties -> Actions -> Edit (needs the Windows password; created
2026-04-08, LogonType: Password). The Sunday run ensures large-v3 completes
before Wednesday's medium batch. **Its `lastResult` is now meaningful**: 0x0 is
a run that worked, 0x2 is one where most downloads failed, 0x3 a bot-wall
abort. It showed 0x0 for four runs of 46/49 failures before the verdict existed
(`tools/logs/translate.log` has the whole history). It also posts that verdict to
the server, so `/admin/subtitles` shows *Last run reported*, and the server mails
the admins on a non-zero code and again if no report arrives for 8 days.

**The task's credentials live in its Arguments, and `local_translate.py` reads
them from nowhere else.** An earlier version of this paragraph claimed `-u`/`-p`
default to `$SALTYCHART_USER` / `$SALTYCHART_PASSWORD`; they do not - the script
contains no `os.environ` lookup at all, and a run relying on that claim exits 2
with `Provide --username and --password`. The env-var support was drafted and
reverted; the sentence describing it was not, which is precisely the drift this
guide's first rule is about. To run it by hand, pass `-u`/`-p`, or start the
Scheduled Task itself (`Start-ScheduledTask -TaskName 'SaltyChart Translate'`),
which reuses the stored credentials without anyone handling them.
**`--token` is not the answer for the weekly task**: `/api/auth` signs **7-day**
tokens (`auth.ts`), so one minted today is expired by the run after next. It is
for a one-off, like the `--within-days` check.


## Upstream service status (`/api/status`)

**Why it exists.** Two third-party services changed and broke silently in one
week - YouTube's media requests and skyhook's `User-Agent` - and in both cases a
`catch` turned the failure into a plausible empty answer. "Could not ask" and
"there is nothing there" were the same value, so nothing could tell. This router
and `lib/upstreamHealth.ts` are where those stop being the same value.

`lib/downloadHealth.ts` already solved this for YouTube and is the shape:
record what real traffic says, treat a **streak** as the signal, log and mail
exactly once at the crossing. It keeps its own store (its bot-wall hold and
stale-yt-dlp hint are YouTube-specific, and its gates are pinned by mutation
rows), so `upstreamHealth` covers everything else and `GET /report` composes
both. The transitions are a threshold-aware twin rather than shared code -
per-service thresholds are the point - and `upstreamHealth.test.ts` asserts the
two **agree at the default**, the same discipline `MODEL_RANK` follows.

- `GET  /report` - admin; every service with a server-decided `state`, plus the
  alert settings and whether SMTP is configured at all.
- `PUT  /alerts` - admin; save the alert settings. The body is *coerced*, not
  rejected: these are preferences, and the response echoes what was actually
  stored so the page cannot believe it saved an address the server dropped.
- `POST /probe` - admin; run every due check now.

**A streak is not an outage unless nothing succeeded for `MIN_OUTAGE_MS`
(10 min).** The first version crossed on `streak === brokenAfter` with no notion
of time, and skyhook proved that wrong: measured over one evening it answered 66
calls and failed 16 - a **19.5% failure rate, every one a 500**, while working
perfectly. The resolver drains at 300 ms a call, so three consecutive failures
is **0.9 seconds**, and at that rate a few hundred drain calls are near-certain
to contain such a run. It mailed *not responding* and *working again* one minute
apart. Raising the threshold (3 -> 6) was the first response and it was tuning,
not fixing: six in a row is still about two seconds. What separates a flaky
upstream from a dead one is whether **anything** has succeeded recently, so the
alert now needs both. A never-successful service counts as quiet - that one is
worth hearing about. Because the two conditions can become true in either order,
"once" is a stored flag (`downAlertedAt`) rather than an equality, and recovery
is keyed off that same flag so a recovery mail can never arrive for an outage
nobody was told about. Three mutation rows guard the three halves.

**Five states, and two of them exist only to stop a reader being misled.**
`stateOf` decides `ok` / `failing` / `down` / `unknown` / `notConfigured` **on
the server**; the page renders a verdict and never computes one, so the page and
the alert email cannot disagree. `unknown` means nothing has asked yet and must
never render as healthy - that is how skyhook stayed invisible. `notConfigured`
means nobody set the service up, which is deliberate and not a fault; a skip
touches neither counter, so an unconfigured Sonarr is never painted green *or*
red. Both are the same rule as the Sonarr page's "couldn't ask is not zero".

**Probe daily, confirm fast.** Third-party APIs break on a release cadence -
weeks or months - so probing hourly would monitor far faster than the event ever
happens, against someone else's free service. Each spec declares
`minProbeIntervalMs` (a **day** for skyhook, TMDB, SMTP and the id map; **15 min**
for Jellyfin and Sonarr, which are our own boxes and fail for ordinary reasons
several times a day). A daily probe with a 3-failure threshold would take three
days to say anything, so a service that has just failed is re-checked after
`CONFIRM_RETRY_MS` instead: a real API change fails *every* call and is
confirmed within the hour, while a transient 500 clears itself and never
reaches the threshold.

**The sweep logs when it ACTED, not every time it fires**, with a heartbeat every
six hours so silence stays unambiguous. "A scheduled job that is silent unless it
acts is indistinguishable from one that never ran" is the rule the daily jobs
follow and it is right for them - but this fires every 15 minutes and most
firings have nothing due, so applied literally it printed `0 run ... 7 not due`
four times an hour and became the only thing visible in the log, drowning the
identity sweep beside it. A rule that holds at daily cadence can invert at
quarter-hourly.

The identity re-grade, which runs beside it, **reports its own progress** for the
same reason: a drain is minutes to an hour of work and used to log nothing until
it finished, so "is it still going?" had no answer short of querying the database
by hand. Every line carries its position (`re-grade 150/725`), because a progress
line that cannot say where it is in the run is not a progress line.

**YouTube alone is `passiveOnly`, and a mutation row stops that being undone.**
Its failure mode *is* request volume, so a synthetic probe risks deepening the
bot wall it exists to detect - monitoring that causes the outage it watches for.
Its record comes from real traffic.

AniList was passive at first **and that was wrong on both counts**, which is
worth recording because the reasoning looked sound. "A probe competes with the
shared ~30/min budget" is one request against ~43,200 a day - 0.002%. And "real
traffic is frequent enough" is false: AniList is called *only* from the
`/api/anime` route, never on a timer, so a quiet server would leave that row
unchecked for ever - the exact gap probes exist to close. It is probed daily
through `pingAniList`, which goes through `fetchAniListPage` so it exercises the
same headers, budget recording and 429 handling a viewer's page load does. A 429
that exhausts the retries is reported as **healthy** - it means AniList is
talking to us and rate-limiting, which is normal under a shared IP.

That probe's first query selected only `pageInfo` and AniList answered **400 "No
field provided"**: it reported AniList down while AniList was fine. A `Page` must
select a content field; the query asks for `media(id: 1) { id }` too.

**A probe goes through our own client, never a hand-rolled request.** skyhook's
outage was our axios instance being refused while `curl` to the identical URL
returned 200; a probe that built its own request would have reported green
throughout. The TMDB probe sends the same shape `remoteIdentity.searchOne` does,
field for field.

**TMDB is graded separately from Jellyfin** even though it is reached through
it, because "Jellyfin is up but its metadata provider is failing" was the single
blindest failure in the codebase (`searchOne` swallowed it with no log at all).
A blanket axios interceptor would have merged the two.

Alert settings live in `AppConfig.alertSettings` (`lib/alertSettings.ts`):
master switch, per-service toggles, extra recipients. **`alertAdmins`
(`lib/subtitleAlerts.ts`) is the one funnel every alert in the codebase goes
through** - the download-path break and its recovery, the Wednesday batch, the
Sunday report and its silence - so the master switch and the extra recipients
are honoured there, once, rather than at each caller. They were not, at first:
the page shipped a switch that nothing read, and the deploy gate's deliberately
fake Sunday verdict (`test_local_run_report.py`) landed in the owner's real
inbox with alerts apparently on. **A control that lies is worse than no
control**, because someone who switches it off and keeps receiving mail cannot
tell a broken switch from a broken service. The read **fails open** - a missing
or unparseable row yields the defaults, alerts ON - for the same reason an
absent per-service key means enabled. The gate turns the switch off around its
fake verdict and restores it in a `finally`; **per-service toggles do not yet
reach the subtitle alerts**, only the master switch and the recipient list. **An absent per-service
key means enabled** - if absence meant off, every service added later would
arrive silent, which is the failure this whole feature exists to end. Recipients
are verified admins plus the extras, de-duplicated. **SMTP itself stays in
`.env`**: a mail password in `AppConfig` is a mail password in every backup.
Residual gap, stated on the page rather than hidden: with SMTP down, nothing can
mail to say that mail is down.

## Matching internals - how identities get made

The *rules* - identity versus availability, an id being authoritative in both
directions, air date separating right from wrong by three orders of magnitude -
are in the root `CLAUDE.md` under *Matching AniList entries to the library*,
and they still govern everything here. This section is the mechanism: the
resolver that makes the links nobody else has, how films avoid being matched
against TV, and where Jellyfin actually gets its identification from.

### Making the links nobody else has - `lib/remoteIdentity.ts`

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

**Send a real `User-Agent`, and never cache a failed lookup.** skyhook answers
**400** to axios's default agent (measured 2026-09-20: `axios/1.x` and an empty
UA both 400; `curl/8.0`, `Sonarr/4.0` and our own string all 200 on the same URL
in the same second). `skyhookShow` had a bare `catch` that turned every failure
into `{ episodes: [], tmdbId: null }` **and cached it** - so the whole TVDB
evidence tier was dead and nothing said so: rung B0 could never fire,
`hasUndatedFutureSeason` was always false, and the cross-provider candidate
merge never had a `tmdbId` to merge on. Eight stored rows carry the season
rung, from before this broke, and none since. Both halves of the fix matter -
the header, and refusing to cache a failure - because "could not ask" and "this
show has no schedule" were the same value, which is the same mistake `unknown`
availability and the empty-Sonarr-snapshot guard each exist to prevent. It now
logs one `[skyhook]` warning per failure, and two unit tests plus a mutation row
hold the caching rule.

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
- It sits **above the exact-title rung too**, and is fetched for that shape
  rather than only to rescue a rejection. An exact title with no candidate date
  used to stop at `exact title` - a rung no date vouches for, so the row grades
  `weak` - while TVDB knew the day: PSYREN and Sirotan were Sonarr auto-add
  candidates on title text alone while AniList and TVDB agreed **to the day**.
  Audited over 8 aired seasons against the 515 entries the Fribb map
  independently pairs (`tools/audit_premiere_dates.py`, 2026-09-20): **first
  seasons 345/345 inside tolerance - 100%, 298 exact to the day, none outside**;
  sequels 140/167 (83.8%).
- **It reaches a TMDB-only candidate through the id cross-walk.** The lookup
  needs a TVDB id and roughly half a search's results carry only a TMDB one;
  `completeIdentityIds` cross-walks them, but it runs AFTER the verdict, so the
  stored row ended up showing a TVDB id the ladder had never been allowed to
  use. That reads as "TVDB does not know this season" when the truth is "nobody
  asked" - the same shape as the bare `catch` that killed the whole tier. The
  cross-walk is an in-memory join on a map already loaded, so it costs no
  request, and it **never crosses the film/series namespace** (TMDB numbers them
  independently). Measured on FALL 2026: `Kizu darake Seijo yori Houfuku wo
  Komete Season2` stored tmdb 293124 alone and sat `remote: unverified`, while
  TVDB's season 2 premiere for the show that id cross-walks to is its AniList
  premiere **to the day**.
- **That rung may only UPGRADE, never refute.** All 27 known-correct entries it
  fails to vouch for are sequels, and every one is a TVDB-vs-AniList modelling
  difference rather than a wrong match - a split cour filed as ONE TVDB season
  puts Part 2 ~182 d from its own Part 1 (Dr. STONE, Uma Musume, Samurai
  Troopers and Ooi! Tonbo all land on exactly 182), and movies and specials hang
  off the parent series record. Out of tolerance it declines to fire and the
  title rung below still accepts, so those rows are exactly as they were.
  Refuting would send 16% of correct sequels to review and buy nothing the audit
  could measure.
- **Use the SEASON premiere, never the series' `firstAired`.** On the same
  corpus the series date is inside tolerance for only **13.2%** of sequels, 118
  of them more than a year off (Natsume Yuujinchou Shichi by 5,937 days) - it is
  season 1's date, and reading it as "the premiere" would have demoted nearly
  every sequel.
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
- **A multi-candidate row leaves the review queue when the date SEPARATED the
  candidates** - `dateSettlesCandidates` (`lib/seriesIdentity.ts`, beside
  `matchGrade` and for the same reason: the page asked the same question, and a
  correctness rule with two copies can disagree with itself). Queueing every
  multi-candidate row is right for Echo, whose three candidates are all titled
  "Echo" and are three different films - but it also fired on rows a date had
  settled to the day: **142 of 170** premiere-date-rung multi-candidate rows
  stored here (2026-09-21). Three conditions, each excluding a measured case:
  exactly one candidate inside tolerance (**21** rows have two or more - the
  date did not discriminate), no undated sibling (**7** do, among them `Cyborg
  009: Nemesis`, which exists twice in TVDB with one copy undated - settling it
  would undo the merge refusal by a side door), and the stored pick IS that
  candidate (**1 of 146** had stored a refuted one). Echo and the season rung
  are both untouched by construction rather than by a special case: Echo's
  nearest candidate is 46 d out so nothing lands inside, and the season rung's
  evidence is the season date rather than any candidate's own - left alone
  deliberately, because that rung was never measured for this rule.
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


### Films are resolved against films - `jellyfinFilmIndex`

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


### Jellyfin identification is controlled by `tvshow.nfo`, not folder names

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


## Accounts and admin access (`/api/auth`, `/api/admin/users`)

The rules are in the root guide under *Who is an admin, and who can reset a
password*; the argument for each is
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
account otherwise looks like a friend's), `PATCH /:id` (promote needs a verified
email on the **target**, `EMAIL_NOT_VERIFIED`; demote respects the floor,
`LAST_ADMIN`), `DELETE /:id` (refuses the last admin and refuses self; clears
lists, settings and codes in one transaction - `WatchList` has no
`onDelete: Cascade` and SQLite cannot add one without rebuilding the table),
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

**These buttons are for the one lockout self-service cannot reach.** An ordinary
account with no email already resets itself at `/reset-password` with nothing but
a username, so an admin has no part to play there. The case that needs a human is
an address whose inbox its owner has lost: they are pinned to a coded path they
can never finish, and clearing the address hands them back the easy one.

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

- `User` - plus four account-security columns: `email` (nullable, **not
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
  per-season cooldowns after a 429), `subtitleDownloadHealth` (is the trailer
  download path working - see *Knowing when it breaks* above; its
  `lastFailKind` is what arms the bot-wall hold on `/stream`),
  `subtitleLocalRunStatus` (the Sunday GPU run's own verdict, posted to
  `/local-run` at its end - the only record the server has that it ran),
  `upstreamHealth` (one row holding every upstream service's record - see
  *Upstream service status*; one read, one atomic write, no per-service key
  sprawl) and `alertSettings` (the master switch, per-service toggles and extra
  recipients; deliberately NOT the SMTP connection, which stays in `.env`),
  `subtitleBatchStatus` (the last completed
  batch translation run - `batchStatus` in `routes/translate.ts` is in-memory and
  a deploy is a restart, which is exactly when someone opens `/admin/subtitles`
  wondering whether the job ran; written at **both** exits, clean and failed,
  because "ran and failed" must stay distinguishable from "never ran"),
  `jellyfinAvailability` /
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
  rank table has **one definition per language**: `backend/src/lib/subtitleReport.ts`
  (TypeScript; `routes/translate.ts` imports it) and `MODEL_RANK` in
  `backend/scripts/translate_stream.py` (Python; `batch_translate.py` and
  `tools/local_translate.py` import it). `test_run_verdict.py` asserts the two
  are equal and that neither script redefines it - three hand-synced copies is
  how a missing `large-v3-split` once made a path treat champion output as rank
  0 and reprocess a season for nothing.

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
