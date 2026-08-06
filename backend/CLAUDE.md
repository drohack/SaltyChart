# CLAUDE.md - SaltyChart backend

**Nested guide.** This file loads automatically when you work with files under
`backend/`. It holds reference material for the two largest backend subsystems,
moved out of the root guide so it is not paid for on every unrelated session.

The root `CLAUDE.md` stays authoritative for everything project-wide - the
working conventions, the measurement rules, the secrets rule, *Matching AniList
entries to the library*, the schema, and deployment. Read it first; nothing
here overrides it.

Rules that bind from **outside** this directory deliberately stay in the root
file, because a rule that isn't loaded when it matters is not a rule: the
Jellyfin API key never reaching a browser, the `tools/bench_player.py`
transcode-cache hazard, and the YouTube download pacing that keeps batch runs
off the bot wall.

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

