# CLAUDE.md - SaltyChart frontend

**Nested guide.** This file loads automatically when you work with files under
`frontend/`. It holds the per-surface UI reference, moved out of the root guide
so it is not paid for on every unrelated session.

The root `CLAUDE.md` stays authoritative for everything project-wide - the
working conventions, the *Frontend Service* overview (tech, pages, stores, and
`src/lib/remote.ts`), *Matching AniList entries to the library*, and the
pre-completion checks including the `shareCompare()` / `shareMyList()` manual
verification. Read it first; nothing here overrides it.

---

## Additional UI features (grouped by surface)

**Global *Options* modal** (gear icon in header). Persists in the `options`
store + `/api/options` when authenticated, `localStorage` for guests. Theme
(`LIGHT`/`NIGHT`/`SYSTEM`/`HIGH_CONTRAST`), title language, autoplay,
hide-from-Compare, nickname user picker.

**Season toolbar** (`SeasonSelect.svelte`): search box (client-side fuzzy),
Hide 18+, Hide sequels, Hide in "My List".

**Main Anime grid refinements**: the marker runs the *other* way from what this
line claimed for months - an entry **not** yet in My List carries an
`bg-accent/10` tint overlay plus `cursor-grab` and `draggable`, and an entry
already in the list is the plain one (measured: 104 tinted of 109). So the tint
means "addable", not "added". 18+ badge, **progressive loading** on Home (each section gates only
its own fetch - skeleton shimmer per section, per-section error + Retry, one
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
  * an `unknown` verdict is never acted on - it means "couldn't ask", and one
    slow moment must not empty the wheel;
  * `notAired` neither triggers hides nor lights the button - "can't exist
    yet" is not "confirmed missing";
  * title-only matches report `available: true`, so bulk-hide can only ever
    *keep* an unconfirmed match;
  * the library lookup has a visible state (`libraryStatus`: idle / checking /
    ok / unreachable -> "Checking your library..." / "Can't reach the media
    server" + Retry) - an unreachable server used to render identically to
    "everything you own is in the library";
  * a failed hide write is put back (`writeHidden` returns the ids that
    didn't stick, `revertHidden` restores them and says so) - the one failure
    here that loses state rather than hiding information. This covers every
    hide path: the per-row eye toggle kept its own fire-and-forget fetch for
    months after the bulk paths were fixed, which is why the shared helper is
    asserted per-path, not once.
- "Nicknames from" panel auto-checks users with entries for the current
  season (`/api/list/users-with-ratings`), re-runs on season change; manual
  toggles reset on season change.
- When Jellyfin is configured, the show pop-up gains a **Watch here - SxEy** button
  (`JellyfinPlayerModal.svelte`) plus a "Library: <matched title>" caption so
  a bad match is visible; title-only matches are marked **unconfirmed**.
  Season-aware: a "2nd Season" entry resolves to that season's E1 and is
  honestly unavailable if the library lacks it. A **"Not the right show?"**
  control - offered only when the identity is *uncertain* (a resolver guess or
  a title match), since a community-map id or a human decision needs no
  correcting. That keys off `idConfident` on the availability verdict, not on
  availability itself: the question is "do we know what this is", not "can you
  watch it", so an entry we're sure of shows no control even when the library
  doesn't hold it. Reading "Find it in my library" when nothing matched, it searches the
  held library and pins the entry to what the viewer picks - remembered for
  everyone and queued for admin review. It **replaces the pop-up body** rather
  than opening a menu inside it: `.modal-box` is its own scroll container, so a
  floating panel produced two competing scrollbars, clipped the results and
  pushed *Mark as watched* out of reach. The results list owns the only
  scrollbar and is bounded, so a long list scrolls in place. The AniList cover
  stays on screen beside it and each option shows its **library poster** -
  matching is a comparison, and hiding either side made it guesswork. It states
  what the entry resolves to now and tags that option `current`, so a viewer
  can tell a correction from a no-op. *Reset to
  the automatic match* undoes a pick. Enter belongs to the search box, not the
  pop-up's mark-watched handler (a window listener; the player guards the same
  way), and pick mode never survives the pop-up it belongs to. Logged-in viewers only: the write needs
  a token, and a control that 401s is worse than no control. Availability for all wheel
  items comes from **one `/availability/batch` request** through
  `checkAvailabilityMany()` (`stores/jellyfin.ts`), which omits any entry it
  couldn't definitely answer - so `?.available === false` refuses to act on
  an unanswered show.

**The player** (`JellyfinPlayerModal.svelte`) - a thin wrapper around
video.js 8, lazy-loaded in its own chunk; keep it that way. video.js owns the
control bar, menus, fullscreen, hotkeys, errors. The wrapper adds only: the
HLS source, the play-session lifecycle, the JWT on every request, and the
**`]` / `[` keys stepping playback speed by 0.10x across 0.2x-4.0x** - every
media server's own player is locked to coarser steps, which is why this
player exists. Speed keys don't count as user activity (the bar stays
hidden); `playbackRates` feeds the same steps to video.js's menu. Enabled
options: `skipButtons` +/-10s, `enableSmoothSeeking`, `experimentalSvgIcons`,
`persistTextTrackSettings` (defaults seeded once).

- **Seeking is the browser's job.** Jellyfin's `main.m3u8` is a complete VOD
  playlist and the server repositions its own transcoder on an out-of-range
  request - there is no client-side reposition machinery. What remains is
  **recovery**: scrubbing races Jellyfin's segment cleanup (jellyfin#16608)
  and can wedge a session permanently, so the player rebuilds around a fresh
  `playSessionId` at most twice. Two distinct failures need two detectors -
  a stopped clock (10 s without `currentTime` movement) and a stopped *picture*
  with the clock running (`totalVideoFrames` frozen 8 s - reported from the
  field; a clock watchdog can't see it). The four load-bearing details
  (fresh PlaybackInfo, arm only after progress, reset `recoveries` on decoded
  frames only, re-baseline the frame count after restart) are commented at
  the watchdog in the component - each one was learned by watching an
  uncapped restart loop or a false recovery.
- **Subtitles are burned in by Jellyfin** (`SubtitleProfiles: [{ Format:
  'ass', Method: 'Encode' }]`), composited on the GPU with libass and the
  episode's own fonts. This replaced a client-side renderer whose every
  failure was silent (an opaque canvas over healthy video, a double-unwrapped
  `.default` downgrading ASS to WebVTT, empty frames reporting success) -
  pixels can be *tested*, which is what `test_player` step 8 does. Measured
  cost: +0.4 s first segment, 2-4x smaller segments, zero client code. What
  it costs: one re-encode generation, and a **stream restart** on any track
  or quality change (~1.1 s) - every Jellyfin client behaves that way.
- **Both control-bar menus restart the stream** (subtitles are in the picture,
  the tier is baked into the encode). Subtitle selection prefers a plain
  English dialogue track - `sdh|dubtitle|sign|song` set aside, ASS over SRT,
  the file's `default` flag only breaking ties (releases ship signs-only
  tracks marked default). **"Off" must be sent as `subtitleStreamIndex=-1`** -
  omitting the parameter makes Jellyfin pick a default and burn it back in.
  Quality: auto (the source's own ceiling, from a probe PlaybackInfo), 1080p,
  720p, 480p. A rebuild **stops the session it abandons** - before that,
  every track change left an orphan ffmpeg remuxing ~1 GB for nobody, and
  `/Sessions` can't reveal it (this proxy never reports playback, which is
  also what keeps it out of watch history). The two bugs that once made
  restart a no-op (replaying the same URL; the watchdog firing into the
  deliberate rebuild - hence `RESTART_GRACE_MS`) are commented at
  `restartStream()`.
- **Warm-up is two-staged** (`lib/jellyfinPrewarm.ts`): the video.js chunk on
  landing at `/random` (idle-callback, skipped on saveData/2G - Home browsers
  never pay for a player they don't open), and the episode's PlaybackInfo
  when the pop-up opens, cached by itemId+quality+track. **It never touches
  the HLS manifest** - a pre-started stream would remux a whole episode to
  disk for a pop-up nobody plays (jellyfin#16608 again). With both, Watch
  costs only the stream start (~2.4 s, of which ~1.7 s is Jellyfin's segment
  0). `loadVideoJs()` must stay shared - a private `import('video.js')`
  wouldn't be covered by the preload.
- The Watch button shows an "Opening..." spinner while the chunk loads - test
  player latency on something other than localhost before judging it.
  Nothing waits on subtitles any more; the only app-owned wait is the
  "Switching to..." indicator during a genuine rebuild. video.js's big play
  button is hidden while Jellyfin builds the first segment and reappears only
  on **`NotAllowedError`** (a real autoplay block needing a click);
  `AbortError` is routine interruption during rebuilds and must not show it -
  details at the `sc-autoplay-blocked` handling in the component.
- Picture-in-picture is disabled. Chromecast is wired
  (`@silvermine/videojs-chromecast`) but **cannot work over plain LAN HTTP**
  the Cast SDK needs a secure context; serving HTTPS lights it up with no
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
  `html, body { overflow-x: clip }` in `app.css` - `overflow: hidden` creates
  a scroll container that breaks `position: sticky`.
- Unified controls: season/year row, then `{yourName}:` + pre/post on the
  left, `2nd user:` + combobox + pre/post on the right. Default sort is
  `rankA` (your ranking), not `diff`. Desktop caps content at the same
  `calc(100vw - 40rem)` 2cols cap as Home (an older note here claimed 50rem -
  the code says otherwise); heatmap legend + Share-as-image are desktop-only.
  Pre/post-watch order is toggleable per user independently.

**Misc**
- The header logo's `?` badge tooltip shows the deployed version - the
  `YYYYMMDD-<sha>` tag injected by CI (`APP_VERSION` build-arg ->
  `VITE_APP_VERSION`); local builds show `dev`.
- First load uses a **50-day look-ahead** (`LOOKAHEAD_DAYS`,
  `computeInitialSeason()` in `stores/season.ts`): if the next season starts
  within 50 days it is shown instead. It was 76, which flipped the default
  two weeks after the current season's premieres - most of a season spent
  looking at one where nothing had aired.
- "X days until [next season]" derives locally from the browser date
  (`nextSeasonInfo()`; season starts Jan/Apr/Jul/Oct 1).
- Ctrl+Shift+R / Ctrl+F5 hard-reloads and resets the cached season selection;
  the last selected season/year is otherwise remembered for an hour.

