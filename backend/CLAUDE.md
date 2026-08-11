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
that lives in three files - one of them `tools/local_translate.py`.

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
- `POST /identity/resolve` - admin only; `{ mediaIds[], years?, titles? }` (max 200) ->
  what we believe about each and where it came from. Pairs with
  `/availability/batch` on `/admin/matching`: that says *whether* a show
  resolved, this says *which id* and whether a human confirmed it. Unmatched
  rows carry `retry` (`eligible` / `cooldown` + `nextRetryAt` / `retired`,
  from `retryStateFor` - the tier arithmetic's one home) and `tier` from
  `classifyMatch` (`id`/`title`/`notHeld`/`noMatch`, the sweep's own
  classifier, so the admin panel's per-season and all-seasons rows agree by
  construction). `years` and `titles` are the optional mediaId-keyed maps those
  two computations need, sent by the page because nothing stored on a miss row
  records them. Carries `sweep` - the last resolver
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

- `GET /api/translate/check-batch?videoIds=id1,id2,...` - bulk DB lookup for English sub status (up to 100 IDs); returns only confirmed positives; queues background Python checks for uncached IDs
- `GET /api/translate/check?videoId=&mediaId=`  - checks English subs + subtitle dismiss state; cached
- `GET /api/translate/stream?videoId=&mediaId=&start=` - SSE subtitle stream; serves from cache on repeat plays. Optional `start=<sec>` begins transcription at the viewer's playhead (live CPU savings); `start>0` runs are partial and not cached
- `PATCH /api/translate/dismiss?videoId=`       - persist subtitle on/off preference; no auth, all users
- `POST /api/translate/upload`                  - upload pre-translated subtitles; admin only, respects model rank
- `DELETE /api/translate/cache?videoId=`        - delete a cached translation; admin only
- `POST /api/translate/batch`                   - trigger batch pre-translation; admin only, JWT required
- `GET /api/translate/batch/status`             - batch job progress/logs; admin only

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
`youtube_transcript_api` must be installed locally (`pip install
youtube-transcript-api`) - without it every check silently returns false.

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

**Local GPU translation** - `tools/local_translate.py` runs the champion split
pipeline on this PC (requirements, pipeline, Ollama management, and fallback
behaviour are in its docstring) and uploads as **`large-v3-split`** (rank 6,
above plain `large-v3`, so older results auto-upgrade on the next run; use
`--force` to re-do everything). Operational facts that live nowhere else:

- Phase-1 downloads are **serial** with a delay (`--download-delay`, 5 s) -
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
before Wednesday's medium batch.


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


## Database schema

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
