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
  (`@silvermine/videojs-chromecast`) and **works in production**, where the
  reverse proxy serves the site over HTTPS. It is **not testable in local dev**:
  `setupChromecast` gates on `window.isSecureContext`, and the Vite dev server
  is plain HTTP, so the button is never offered there. Absence of a cast button
  locally is the guard doing its job, not a regression - confirm against the
  deployed site before chasing it. The SDK is warmed on `/random` and never
  awaited (it is the one asset whose latency is someone else's internet).
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

**`/admin/users`** - who can sign in, and who can administer. A fourth question
alongside identity, scope and production: *access*. What lives nowhere else:

- **`createdAt` and the list count are columns, not decoration.** Signup is open
  to the internet, so a stranger's account otherwise looks exactly like a
  friend's, and an account with data in it is a different deletion decision from
  an empty one.
- **One column per action, and a live filter above the table.** Four buttons
  shared an `Actions` cell at first; they wrapped onto three lines and squeezed
  every other column to nothing. The filter matches username **or** email as you
  type, and the count reads `3 of 47` while filtering - a bare list of three
  otherwise looks like the whole site. Headers sort (names A-Z, counts and dates
  largest-first on the first click), and accounts with no address sort last
  rather than piling at the top on an empty string.
- **Both recovery buttons CLEAR; neither sets.** Setting a password would have to
  be relayed and would leave the admin knowing it. Clearing hands control back:
  the owner sets the next one at the reset page, which for an ordinary account
  needs only a username. The confirm dialogs say which of those two follow-ups
  applies, because "done" alone leaves an account nobody can get into.
- **Your own row links into Options instead of duplicating anything.** It fires
  a `sc:open-account` window event that `App.svelte` and `OptionsModal` both
  listen for; the modal opens with the Account section already expanded. A
  one-way event, so neither component needs a handle on the other - and Options
  asks for the current password, which the clear buttons deliberately do not.
- **Every refusal renders as its own message.** `LAST_ADMIN` and
  `ADMIN_RESET_BLOCKED` are deliberate policy, and a reader who cannot tell
  "refused on purpose" from "broke" goes hunting a bug that is not there. The
  buttons also pre-disable with a `title` explaining why, but **the backend is
  the guard** - the UI asking is a courtesy, same discipline as
  `/admin/sonarr`'s *Include anyway*.
- **Mail status sits at the top**, because every recovery path on the page
  depends on it and "why did nothing arrive" is the question it answers. *Send
  test email* mirrors the Jellyfin/Sonarr connection tests.

**`AdminShell` owns two account-level states**, deliberately, so they appear on
whichever admin page you happen to open rather than only the one that caused
them. The **nag** (you are an admin with no verified email, so there is no way
back into your account) and the **first-run claim form**, which renders *ahead
of the admin gate* - nobody is an admin yet, so the gate would refuse the very
person meant to claim it. Both read `GET /api/auth/account`.

**Options modal - Account section.** Email with its verification step, and
change-password; both require the current password. Setting an address is
opting *in* to protection, and it only counts once a code sent to it comes
back - an unverified address must never protect anything, or a typo locks the
account onto a coded path with no reachable inbox. Reopening the modal with a
stored-but-unverified address lands on the code box rather than forgetting a
half-finished verification. Changing a password rotates `tokenVersion`, so the
server hands back a fresh token to keep *this* device signed in while ending
every other session.

**`ResetPassword.svelte` has two paths and never guesses which.**
`/reset-request` decides: a code step, the old one-step form, or a `blocked`
dead end for an admin with no address. That last step matters more than it
looks - without it such an admin sits at a form refusing every submission,
which reads as a broken page rather than a policy.

**The five admin pages share `components/AdminShell.svelte`** - one `<main>`,
one `Admin` heading, one tab strip, one admin gate. They previously had three
different widths (`max-w-2xl`, `max-w-[100rem]`, `w-full sm:w-3/4`), and the
Sonarr one used a bare `<div>` with no heading and **no gate**, so a non-admin
got a load error where the others say plainly that the page is admin-only.
Tabbing resized the content and dropped the title. **The frame is one width for
all three**; a page wanting narrow content constrains its own children (the
Connection form caps its cards at `max-w-2xl`) - making width a shell prop just
moved the inconsistency up a level.

**`/admin/sonarr`** - what is about to be added to Sonarr, and what already was.
A separate page from `/admin/matching` on purpose: that one asks **identity** (which real
series is this - permanent), this one asks **scope** (do we auto-add it, and what
is about to be grabbed - constantly changing). The backend keeps the two apart
for the same reason. What lives nowhere else:

- **The headline must never collapse "couldn't ask" into zero.** With Sonarr
  unreachable it says *"Cannot tell what would be added"*, not "0 still to add" -
  the latter reads as "nothing is about to happen", which is the worst available
  misreading. The first version did exactly that and was caught in a browser,
  with the build and svelte-check both green. Same discipline as `unknown` on the
  Jellyfin availability path.
- **The excluded list is grouped by the gate that dropped each entry**, because a
  count is not reviewable: "39 proposed" says nothing, "50 dropped on a
  prequel/parent edge" says whether the filter is sane. Each row has an *Include
  anyway* button (the force-include overlay, the only override direction).
- **`noUsableTvdbId` rows link to `/admin/matching?season=&year=`** - the one
  real seam between the two pages, since an unresolved id is a matching problem.
  That page reads the query params **once at mount**, falling back to the calendar
  season on anything unrecognised, so a stale link cannot fight a reviewer
  mid-review.
- The size estimate is a **median** (0.38 GB/episode, measured 2026-08-04 over a
  random 500-episode sample) with a p90 alongside it, and entries with no episode
  count are labelled as assumed rather than folded silently into the total. It
  also states that it assumes today's mixed-quality library - a 720p-only Sonarr
  profile makes it an over-estimate.
- **Grouped by season, alphabetical inside.** A season with nothing on the list
  says why *and when that changes* ("0 on the list, 38 waiting to air - the
  earliest joins around 16 Sept"), which turns the most alarming number on the
  page into a schedule. Posters come from `coverImage.medium`, already in
  `SeasonCache`, so they cost no extra fetch.
- **Air-date outliers are marked.** Measured across WINTER/SPRING/SUMMER 2026,
  **116 of 119 proposals sit within 14 days of their season's median premiere**,
  so a row outside that is genuinely unusual - it is the one that gets grabbed
  alone weeks early, or waits long after its season is in. **That 14 is NOT
  `DEFAULT_WITHIN_DAYS`**: the air window measures distance from *today* and
  decides membership, this measures distance from the *season median* and only
  decorates. Do not unify them.
- **Entries dropped as sequels say whether you hold the previous one** (25 of 50
  did, measured 2026-08-09). Display only - the first-seasons-only rule is
  unchanged, and auto-including on that signal is a separate decision.
- **Every row carries a Match badge** from `matchGrade` (`lib/seriesIdentity.ts`)
  - the same ladder the Watch pop-up's correction picker uses, so the two
  surfaces cannot drift on what "certain" means. `weak` and `viewerPick` are
  warning-coloured because those are the ones that can be wrong.
- **"Ours" is counted from BOTH the marker tag and our own push record**, and the
  line says so, because neither is complete: the record does not follow a new
  database, and a series since deleted carries no tag. It must be the *marker*
  tag (`saltychart`) and never any of our applied tags - we apply `anime` too,
  and `anime` is on 692 series here, so "any tag" rendered two shows the owner
  had for years as ours. Hand-tagging a series is a legitimate way to claim it.
- **The history line may say "added by us" only because a `pushed` row needs a
  201 from Sonarr.** The Custom List version could not: its date was when the
  page first *read* your library, which on a pre-existing library every row
  shared, so "added" would have misdescribed the whole collection. "You already
  had" stays a separate count for the same reason, and the line reads "None added
  by us yet" rather than a bare 0, because 0 there means the job has never run.
- **A series added once never reappears as pending.** `pushedAlready` is read
  from our own record, not the live library, so a series you later delete keeps
  saying "added by us" instead of drifting back to "will be added". If it ever
  does drift back, the one-and-done guarantee has broken.
- **"Everything we have tried" lists the failures first.** `bad TVDB id` and
  `add failed` both mean nothing was added and both retry, so they are the only
  rows anyone can act on - burying them under a hundred successful adds is how a
  persistent bad id goes unnoticed for a season. A `bad TVDB id` row links to
  `/admin/matching`, because that is where it gets fixed.
- **An unverified row's button reads "Include anyway" and opens a confirm** that
  names the grade and what the id matched against - a generic "are you sure" is
  noise, whereas *"matched against Unanswered//butterfly"* is judgeable. The
  backend 409s regardless (`UNVERIFIED_MATCH`); the dialog exists so the click is
  informed, not so it is possible. A UI that forgot to ask would still be safe.
- The season picker is a **what-if**: it previews any season while the job still
  works from the current one and the next, and the banner says so. Its
  `on:change` handler splits the value **inside `load()`**, not in a `$:`
  statement - reactive declarations have not flushed when the handler runs, which
  produced `?season=&year=NaN` and a 400.

**`/admin/subtitles`** - what the trailer subtitle pipeline has actually
produced. A **third** question again: not identity (`/admin/matching`) and not
scope (`/admin/sonarr`), but production - and its data is keyed by YouTube video
id rather than by series. **Trailers only**; Jellyfin episode subtitle tracks are
a different subsystem with no cache table and are deliberately not reported.
Four blocks: overall tiles, the schedule, a this-season/next-season summary
sharing columns, then one table of trailers per season. What lives nowhere else:

- **Overall covers the whole `SubtitleCache`, the seasons below do not**, and the
  page says so. Most of that table is seasons that aired long ago, so the two
  scopes disagreeing is correct rather than a bug. The tiles carry percentages
  because the raw counts only ever grow, and the page spells out that "trailers
  tracked" is *what we have looked at* - a cache size - not how many trailers
  exist. It is deliberately not a tile for that reason.
- **The page states the batch's eligibility rules rather than re-implementing
  them** (format in TV/TV_SHORT/OVA/ONA/SPECIAL so movies are out, not 18+, no
  SEQUEL/PREQUEL/SIDE_STORY/SPINOFF edge, has a YouTube trailer - and the sequel
  test is the broad one, which also drops a first season that later spawned a
  sequel). It also says that **on-demand translation ignores all of it**, which
  is why the cache holds rows for movies and sequels the batch would never take.
  The rules live in `filter_eligible`, `backend/scripts/batch_translate.py`;
  copying them into TypeScript would be a fourth home for a rule already in
  three files.
- **Never say "below champion" on screen** - that was internal jargon and read as
  meaningless. The tile is *"not on our best model"*, and it states that such a
  translation still works and is a queue length rather than a fault count.
- **`belowChampion` counts stored translations, not badges.** A row badged
  `youtubeCc` can still hold an old `medium` translation, and the local GPU run
  decides on cached segments and model rank alone - `check_server_cache` in
  `tools/local_translate.py` never consults `hasEnglishSubs`. Gating the per-row
  flag on `state === 'translated'` made the per-season totals disagree with the
  overall figure; caught by cross-checking the filter count against the summary
  column in a browser.
- **One table, not one per season.** Grouping and column-sorting fight each
  other - a sort that restarts every few rows is not a sort - so season is a
  column plus a filter, and the per-season comparison keeps its own summary
  block.
- **Sort helpers take `(key, sortKey, sortAsc)`, and that is load-bearing.**
  Svelte only re-evaluates a template expression when a variable *named in that
  expression* changes, so `arrow(key)` reading component state inside its body
  rendered once and froze while the rows underneath re-sorted correctly. The
  same applies to `aria-sort`.
- **Buttons use `btn-outline`, headers use `link` (not `link-hover`).** DaisyUI
  renders `btn-ghost` with a transparent background *and* border until hover, so
  at rest it is indistinguishable from plain text - a real complaint about this
  page's first version. `link-hover` has the identical problem for sortable
  headers. `btn-ghost` is still used ~19 times elsewhere in the app.
- **The champion card says "last upload seen", never "last run".** The Sunday job
  is a Windows Scheduled Task on someone's PC; the server cannot observe it, and
  a run that found nothing new leaves no trace. Saying "last run" would turn a
  quiet success into an apparent failure.
- **An uncached season says so, in both the summary row and its table** - never
  a row of zeroes. Same discipline as the Sonarr headline's "couldn't ask" is not
  "nothing to do".
- **Every state gets a visible badge**, including settled ones, and each badge's
  `title` explains it - the `/admin/sonarr` lesson, where badging only the
  interesting rows left a table that read as mostly rendering failures. The two
  actionable states sort to the top, per season.
- **Both row actions state their real cost.** *Turn our subs off* says "for
  everyone", because `PATCH /dismiss` is global; the delete confirm names the
  model and line count and warns that the next play re-translates at `small` - a
  **downgrade**. It is for clearing a wrong translation, not forcing an upgrade.
- **The delete button keys off "is there something to delete"** (a non-null
  segment count), not off the state badge - so a row badged *YouTube CC* that
  also carries cached segments still offers it.
- `PATCH /dismiss` is called **without a token**, deliberately: it is
  unauthenticated because the player's CC toggle is guest-facing, and adding auth
  for this page would break subtitle toggling for logged-out viewers.

**`/admin/matching`** - the human end of the matching pipeline. Its full UI
contract (filter modes, provenance rules, the changed-vs-untouched Confirm
discriminator) is the header comment in `pages/AdminMatching.svelte`; the
resolution rules it fronts are in *Matching AniList entries to the library* in
the root guide. What lives nowhere else:

- Shows what needs review for a season, with a per-row state verdict **derived
  from the stored acceptance rung**, so the column can never contradict what
  verified the match. The match control is Sonarr-import style: picking fills,
  and only Confirm saves.
- **Rows sort by display title.** The API returns AniList id order, which reads
  as arbitrary.
- **Run sweep now** fires `POST /identity/sweep` and polls the sweep summary
  until the run finishes. It updates the status line only - rows never reload
  out from under a review in progress - and reports `remaining`/`retired`
  honestly.
- A **two-row summary table**: the season on screen, and every cached season.
  They share columns so the two scopes are read by comparison and the numbers
  align by construction. Two earlier tile layouts drifted out of alignment the
  moment one group gained a line the other lacked.
- **Two header tiers**, because the data is two levels deep:
  `by id + by title + not in library + no match = entries`, and
  `never searched + ready to retry + on cooldown + retired = queued`.
- **`queued` is not a slice of the first four** - an entry with no id can
  title-match today and still be owed a lookup. The legend under the table says
  so, because a reader asked which numbers were subsets of which and flat
  columns could not answer.
- Each unmatched row captions its own standing: "auto-searched 2 d ago -
  retries in ~5 h".

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

