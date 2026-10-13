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
hide-from-Compare. (Not the nickname picker - that is Randomize's own panel.)

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
  in Library / Hide Not English** (the last two only when Jellyfin is
  configured, using the batch availability cache), and a "N shown, M hidden"
  count beside the Unwatched heading (`data-unwatched-counts`). **Hide Not
  English** hides every show that cannot be watched in English here: one the
  library lacks, aired or not (so it is a superset of Hide Not in Library, by
  request - an unaired show whose file landed early is judged like any other),
  or one whose episode has neither full English subtitles nor English audio - the
  verdict's `english` field is `none` or `signsOnly`, from the same backend
  rules as /admin/sonarr's audit. A dub (`engAudio`), `unknown`, or
  a held show whose verdict predates the field keeps the show (`isNotEnglish`;
  flow 38 pins all eight kinds). The four buttons sit on two rows
  (`data-hide-controls`) - on one line the library pair ran off the sidebar.
  Invariants, each with its story commented in
  `Randomize.svelte` / `stores/jellyfin.ts`:
  * an `unknown` verdict is never acted on - it means "couldn't ask", and one
    slow moment must not empty the wheel;
  * "not in the library" means no video file, aired or not. Unaired shows are
    asked like any other (with AniList's `status`), and the server's "no"
    carries `notAired` so the pop-up can say why. They used to be answered in
    the browser and never asked: DARK MACHINE, four days out, survived both
    buttons while Chitose 2nd Cour already had its episode on disk;
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
  toggles reset on season change. The panel (with "Add Watched to") is
  **desktop-only by decision**: a folded bar floating over the wheel on phones
  and tablets was built, and the owner judged it clutter - the defaults serve
  there. Don't re-add it below `lg`. It **folds to its top row** - the whole row is the button
  (`data-options-toggle`), folded it still shows the Top/Bottom choice, and the
  fold is kept in `localStorage` (`randomizeOptionsCollapsed`, per browser: a
  layout preference, not account data). Unfolded it is exactly its old height;
  flow 41 compares the two.
- **The wheel and its area have separate sizes** (`.wheel-area` in
  Randomize's `<style>`). `--area-size` follows the window's height only; the
  area's min-height and the background read it, and the docked lists stretch
  to it. `--wheel-size` is that, and from `lg` also no wider than the space
  between the DOCKED lists (window less 37rem + 14px, 41rem from `3cols`, less
  2rem); the area's padding centres the wheel in that gap. The wheel used to
  follow the height alone, so narrowing a desktop window slid it under the
  lists (247px at 1100x950). **Keep them two variables**: the first fix used
  one, and the lists shrank with the wheel (760px to 391px tall at 950px
  high). Flow 43 holds both.
- **On a phone the two side lists' restore tabs show only while BOTH lists
  are shut.** The lists are 20rem wide, so on a 320px screen each list's hide
  tab sat exactly under the other list's restore tab (both pinned to the same
  edge): tapping "hide" opened the other list, and the wheel could never be
  reached. Flow 42 taps by coordinate, as a finger does.
- **The pop-up body has a fixed height on `sm`+** (`--body-h`, the poster
  actually drawn): Watch and the actions are its `auto` bottom row and never
  move, and the titles + nicknames above scroll in what is left. With six
  nickname rows the column was ~548px and pushed Hide and Mark out of view on
  every window up to 1366x768; flow 40 seeds six nicknamers to hold that.
- **The show pop-up's layout is a grid**: one column on a phone (nicknames,
  cover, then Watch and the actions), and from `sm` the cover on the left with
  the English/romaji names and nicknames at the top of the right column - only
  the main title spans the box - and Watch + the actions together at its foot. Stacked it was ~705px tall with a Watch button and two nickname
  rows, which put Watch and Mark as watched below the fold on a 1366x768 laptop
  (~657px of page) inside a box 768px wide. **Side by side, it is sized from
  the video player's pop-up and is never the taller of the two** (by request):
  `.show-popup` in Randomize's `<style>` mirrors `JellyfinPlayerModal`'s box
  (16:9 video plus 81px of chrome, measured at nine window sizes), the poster
  takes that height less 7.5rem for the padding and a two-line title, and the
  box is `w-fit` around it. Caps: 460px wide (AniList serves every cover 460
  wide - more would upscale into blur), 40vw (keeps Hide and Mark on one row),
  ratio 0.68 (the narrowest cover measured). Measured 2026-10-11: 288x409 at
  1366x657 (pop-up 501px vs the player's 544px), 460x652 at 1920x969 (744px vs
  831px). Where the player is shorter than the right column's text (~428px, at
  640x700, 768x1024 and 1280x520) the box stops at the player's height and its
  foot scrolls by under 20px, buttons still in view. **Change the player's box
  and this follows only if `.show-popup` is changed too** - flow 40 step 7
  opens the real player (stream aborted) to catch the drift. **The
  close X is `sticky`, not `absolute`**: `.modal-box` scrolls its own overflow,
  and on a phone the absolute X scrolled away with the content (y=-114 at
  375x667), leaving only Mark as watched and Hide Series, which both write.
  Hide and Mark sit in normal flow at either end of the action row - Hide used
  to be `absolute left-0` beside a centred Mark, and on a phone the two
  overlapped by 37px. The box is capped at `100dvh`, not DaisyUI's `100vh`,
  which on a phone is the viewport with the address bar hidden. Flow 40 pins the
  phone close, the overlap, and the laptop fit.
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
- **A replaced episode heals before Watch is pressed.** Jellyfin re-ids a file
  Sonarr replaced, so a cached `itemId` can die while the page is open. The
  pop-up's prewarm already asks `/playback`; on `ITEM_GONE` (`isItemGone` in
  `lib/jellyfinPrewarm.ts`) it drops the session's cached answer
  (`forgetAvailability`), re-asks with `fresh: true` and repoints Watch. If the
  player itself hits it, it shows a message instead of a black screen and
  `on:itemGone` reopens it once on the new item.


**The trailer player** (the modal in `AnimeGridTranslate.svelte`) - a YouTube
iframe with our subtitle overlay and CC controls as siblings. Three rules, each
from a bug that shipped:

- **We fullscreen our own wrapper, never the iframe**, and the iframe carries no
  `allowfullscreen` so YouTube hides its own button. A fullscreen element is the
  root of what gets rendered, so YouTube's button took the iframe and left our
  subtitles and every control unrendered. `JellyfinPlayerModal` solves the same
  problem by re-parenting into `player.el()`; that is not available here,
  because a cross-origin iframe has no DOM to append to. Escape therefore has to
  check `document.fullscreenElement` before closing the modal, or leaving
  fullscreen also takes the trailer away - the same guard the Jellyfin player has.
- **The control cluster is always mounted; only the SUBTITLE controls inside
  it are gated, on `hasEnglishSubs`.** It was gated on `translationLoading ||
  translating || translationError`, which made it *unmount itself*: a failed
  translation clears the first two and the error clears after 6 s, so the CC
  toggle, the settings gear and fullscreen vanished permanently. Chrome fades
  with `controlsVisible`; it never stops existing. **Fullscreen sits outside the
  CC gate**: the iframe carries no `allowfullscreen`, so our button is the only
  way to fullscreen a trailer, and the first fix wrapped it in the gate and took
  fullscreen away from every YouTube-CC trailer - an audit caught it, and Path A
  of `test_subtitle_paths.py` now pins it (with the Escape-keeps-the-modal rule).
  A refusal during a bot-wall hold shows its `holdUntil` as minutes in the chip
  (`withHoldHint`): "try again later" is not actionable, "about 12 min" is.
- **The subtitle cue is a centred child of a full-width row, not an
  `absolute left-1/2` box.** An absolutely positioned box shrink-to-fits against
  the space from its `left` edge to the container edge, so anchoring at 50%
  capped every cue at *half* the player and `max-width` did nothing - that is why
  the text never spread across the picture. Size and position scale from
  `playerWidth` against a 1536px reference, and the two scale **differently**:
  position is pure geometry (no floor, so "a tenth up" stays a tenth), font size
  keeps a legibility floor or a phone gets 7px text. Do not add
  `text-wrap: balance` - it was tried, and it split one-line cues into two even
  halves using 50% of the width.

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
  'ass', Method: 'Encode' }]`), rendered with libass and the episode's own
  fonts and re-encoded (on the CPU: Jellyfin's hardware acceleration is off
  on this deployment). This replaced a client-side renderer whose every
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
  tracks marked default). **A forced English track is the fallback, not
  excluded**: SKYANiME flags its only English track forced and it is full
  dialogue, so skipping forced tracks played those episodes unsubtitled.
  `test_ui_interactions` flow 37 pins it on the real track shapes.
  **"Off" must be sent as `subtitleStreamIndex=-1`** -
  omitting the parameter makes Jellyfin pick a default and burn it back in.
  Quality: auto (the source's own resolution, from a probe PlaybackInfo, with
  a bitrate ceiling the server sets above the file - `autoTier`, see
  `backend/CLAUDE.md`), 1080p, 720p, 480p. A rebuild **stops the session it
  abandons** - before that,
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

- **"Adds to Sonarr"** is a per-account toggle (`data-act="sonarr-trusted"`):
  a trusted account's list puts its shows on the Sonarr auto-add even when the
  rules skip them. Admins read "always". Off by default because signup is open.
  On `/admin/sonarr` such rows say "on N trusted lists", and a sequel says "new
  season only" (it is added monitoring only its newest season).

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

**The six admin pages share `components/AdminShell.svelte`** - one `<main>`,
one `Admin` heading, one tab strip, one admin gate. Three of them once had three
different widths (`max-w-2xl`, `max-w-[100rem]`, `w-full sm:w-3/4`), and the
Sonarr one used a bare `<div>` with no heading and **no gate**, so a non-admin
got a load error where the others say plainly that the page is admin-only.
Tabbing resized the content and dropped the title. **The frame is one width for
every page in it**; a page wanting narrow content constrains its own children (the
Connection form caps its cards at `max-w-2xl`) - making width a shell prop just
moved the inconsistency up a level.

**One status per show, on both `/admin/sonarr` and `/admin/matching`.** The
server decides it (`backend/src/lib/entryStatus.ts`); both pages render it with
the same pieces (`lib/entryStatus.ts`, `StatusBadge`, `StatusChips`, `AirDate`)
and neither recomputes it. Each page used to have its own vocabulary, and they
disagreed: matching left entries with no id out of its queue and never saw a
Sonarr rejection, and the Sonarr page hid failures, unaired shows and missing
ids in collapsed sections. **Colour means the result, never the format**:

| colour | level | e.g. |
|---|---|---|
| red | `broken` - can't work until someone acts | no id, Sonarr rejected it, aired with no video, no English on episode 1 |
| yellow | `check` - probably fine, nothing verified it | a guess, ambiguous, title-only, an auto-match no date confirmed, a viewer pick |
| blue | `waiting` - not aired, more than 14 days out | no id yet, joins the list on a date |
| green | `ok` - nothing to do | added, will be added, matched |

**Needs attention = wanted and red or yellow**, where wanted = the auto-add rules
take it, a trusted user listed it, or someone pressed Include. A problem on a
show nothing wants keeps its colour but stays out of the queue. **Red means
Randomize hides it**: "not in the library" and "no English" come from the same
availability verdict Randomize's Hide Not English reads. Randomize also hides a
show that has not aired, which keeps its countdown and its own colour here
(nothing is wrong with it), so beside the *On my list* toggle the page prints
"Hide Not English on Randomize hides N of these: X red, Y not aired yet" (`data-randomize-hides`, from each row's
`watchable` and `unaired`) - the two counts match by construction (`test_sonarr`
step 13). Handles: `data-level`, `data-code`, `data-chip`, `data-attention-row`,
`data-entry-row`, `data-air`, `data-randomize-hides`.

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
- **Nothing is in a dropdown.** Top to bottom: **Needs attention** (every wanted
  show that is red or yellow, both seasons, plus open failures no row accounts
  for - `report.attention`), the filter chips and an **On my list** toggle (the
  admin's own list - the set their Randomize shows), one table per season with
  **every wanted show** sorted worst first then by premiere, and an always-open
  **Not auto-added** section for what a rule skipped, each naming the rule, with
  *Include* (the force-include overlay, the only override direction). Every row
  prints its reason in a **Why** column; a reason you have to hover for is
  hidden. The only `<details>` left is the push history, whose open failures
  also appear above - flow 28 fails if a collapsed section holds show rows.
- **Every TVDB and TMDB id is a link** (`components/ExternalIdLink.svelte`,
  shared with `/admin/matching`). It renders the bare number, so the columns look
  the same, but both pages exist to answer "is this id the right series?" and
  that was unanswerable while the id was plain text: **TVDB has no by-id page** -
  `thetvdb.com/series/471609` is a 404, the public URL is a slug
  (`/series/psyren-sairen`) - so checking one meant guessing the show's name and
  searching. `dereferrer/series/<id>` is TVDB's own by-id redirect (verified
  2026-09-20). TMDB numbers films and shows separately, so `tmdbKind` picks
  `/tv/` or `/movie/`; getting that wrong silently opens the wrong title.
- **`/admin/matching` opens on the season that needs review, not the calendar
  one.** It defaulted to `SEASONS[Math.floor(now.getMonth() / 3)]`, so in late
  September it opened on SUMMER - aired, settled, nothing to do - while FALL sat
  ten days out holding all 33 rows that needed a human. It now switches to the
  coming season `LOOKAHEAD_DAYS` (30 - the one in `AdminMatching.svelte`, not
  the site-wide 50 in `stores/season.ts`) before it starts: `isWithinAirWindow` lets
  the Sonarr auto-add grab 14 days ahead, and an identity has to be right
  *before* something acts on it, so 30 gives a fortnight of lead over that. An
  explicit `?season=` still wins - `/admin/sonarr` deep-links here.
- **A row whose problem is the match links to `/admin/matching?season=&year=`**
  (*Fix match*) - no id, a guess, Sonarr rejecting the id, a TMDB-only match.
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
- **The match grade is part of the status**, not its own column: a `weak` or
  `viewerPick` identity is yellow with its reason in Why. The grade itself is
  still `matchGrade` (`lib/seriesIdentity.ts`), shared with the Watch pop-up.
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
- **A failure whose show has since been re-matched reads `replaced`**, muted,
  and is not counted in "need attention" (the backend's `superseded` flag) -
  otherwise a fixed match left the red badge up for ever.
- **"Everything we have tried" is a log**, failures first, collapsed - every
  open failure in it is also on its show's row (joined by AniList id, so a show
  re-matched to no id keeps its failure - `pushForEntry`) or in Needs attention.
  Its *Fix the match* link carries the entry's season.
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
- **Unaired premieres are a blue countdown** (`AirDate`), bold inside the 14-day
  window; an aired date stays quiet.
- **One English column** in every row table (they share one colgroup and one
  row component, `SonarrEntryRow`): the backend's `english.label` - `subs` / `dub` / `subs + dub`
  / `no English`, with a count when only some episodes have English - green when
  `ok`, red otherwise, blank when Sonarr does not hold the show. The page never
  computes it. A separate subtitle section existed first and was removed: it hid
  fully subbed series and read as "everything is broken". **Refresh Jellyfin**
  sits beside Re-read Sonarr with a one-line status (`data-lib-status`); it runs
  the library check (also daily on the server). Handles: `data-english`,
  `data-lib-check`, `data-lib-status`.

**`/admin/subtitles`** - what the trailer subtitle pipeline has actually
produced. A **third** question again: not identity (`/admin/matching`) and not
scope (`/admin/sonarr`), but production - and its data is keyed by YouTube video
id rather than by series. **Trailers only**; Jellyfin episode subtitle tracks are
a different subsystem with no cache table and are deliberately not reported.
Four blocks: overall tiles, the schedule, a this-season/next-season summary
sharing columns, then one table of trailers per season. What lives nowhere else:

- **Download health leads the page, and only shouts when it is bad.** A stale
  yt-dlp broke every new trailer's download for months and the only place it
  ever showed was a 6-second chip inside a modal. `report.download.broken` (a
  streak of `BROKEN_AFTER`, not one failure - a private trailer is not an outage) renders a
  red banner naming the raw reason, and a 403 adds "almost always an
  out-of-date yt-dlp, not an authentication problem" because that is the wrong
  turn it sent someone down the first time. Healthy, it is one quiet line.
  A **hold** (`report.download.holdingUntil`) is its own warning line above
  that, shown with or without the red banner: one bot wall holds new downloads
  before three failures accrue, and the line quotes the viewer-facing message so
  the admin recognises what viewers are being told.
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
- **The champion card keeps "last upload seen" AND shows "last run reported".**
  The Sunday job is a Windows Scheduled Task on someone's PC and the server
  cannot observe it, so the upload timestamp is never called a run. The run now
  posts its own verdict (`schedule.lastLocalRun`: exit code, the `Done:` line,
  counts) and the card renders it, red on a non-zero code, "never" if it has not
  reported. Both stay: a run that uploaded nothing and a run that did not happen
  used to look identical, and that is how four failed Sundays went unseen.
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

### /admin/subtitles can start a run

The trigger had existed from the beginning - `POST /api/translate/batch`, admin
only, with a 409 guard shared with the auto-scheduler and a `batch/status`
endpoint for progress - but the only control for it lived in the **gear/Options
modal**, under "Subtitle Pre-Translation", which is a surprising home for a job
that translates a season: that modal is otherwise entirely per-viewer
preferences (theme, title language, autoplay). The page that is actually ABOUT
the subtitle pipeline rendered the schedule, the live tail and the last run's
exit code - everything except the button.

**There is now exactly one control, and that is the point.** The Options-modal
block was removed rather than left beside this one: two buttons calling one
endpoint drift, and these two already had. The old one sent a raw `fetch` with
no timeout or retry, carried its own season dropdown that could disagree with
whatever the reader was looking at, reported a 409 "already running" as an
*error* rather than following the run, and never said which model it would use.

It says **"Run now (medium)"** on purpose. The server is CPU-only and its image
carries `small` and `medium`; the champion `large-v3-split` is Demucs +
large-v3 + qwen3.5:9b on a GPU and cannot run there at all. A button that
quietly produced a lower rank than the Sunday job is the confusion the
`modelName` ladder exists to prevent, so the model is in the label and the
limitation is stated under it.

It disables itself while a run is going (the fire-and-forget failure this page's
siblings already taught us), follows the run by re-reading the report the page
is already built from rather than a second source that could disagree with it,
and treats a 409 as "follow that one instead" rather than an error - the
scheduler may have started it.

**A test must never mail a human.** A batch exiting non-zero alerts the admins,
and alerts default to the owner, so the browser flow switches the master alert
off around its dry run and restores it in a `finally`. Leaving alerts off after
a crashed test is the silent half of that bug. **It restores only once the
batch's exit is recorded** (`wait_for_batch_exit`): restoring as soon as the
assertions passed raced the still-running dry run, and on 2026-10-12 its exit
(9009 - the dev box cannot find the Python it spawns) mailed the owner.

**`/admin/matching`** - the human end of the matching pipeline. Its full UI
contract (the filter chips, provenance rules, the changed-vs-untouched Confirm
discriminator) is the header comment in `pages/AdminMatching.svelte`; the
resolution rules it fronts are in *Matching AniList entries to the library* in
the root guide. What lives nowhere else:

- **Each row's status comes from `/api/sonarr/report`** (fetched for the season
  on screen), so a show reads the same here as on /admin/sonarr and Sonarr's
  verdicts - a rejected id, "can't add, no TVDB id" - are on the card. When the
  report fails, the identity half from `/identity/resolve` stands in, every
  problem counts as wanted, and the page says so. Needs attention is grouped by
  problem, worst first. The match control is Sonarr-import style: picking
  fills, and only Confirm saves.
- **Rows sort by display title.** The API returns AniList id order, which reads
  as arbitrary.
- **Run sweep now** fires `POST /identity/sweep` and polls the sweep summary
  until the run finishes. It updates the status line only - rows never reload
  out from under a review in progress - and reports `remaining`/`retired`
  honestly. The line also says what the **TVDB check** did (`data-gap-fill`:
  checked, filled, verified by date, waiting for a Confirm, handed back to the
  community map, could not reach TVDB), because a background pass with no
  visible trace is indistinguishable from one that never ran.
- A Sonarr caption of **"not added until the match is verified"** is the
  `unverifiedMatch` reason: the rules want the show but nothing has dated its
  id. The daily TVDB check upgrades it when a date appears; Confirm does it now.
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

**`data-*` attributes are this codebase's test handles.** Randomize's picker has
carried a set for a long time (`data-pick-open`, `data-library-status`,
`data-not-aired`); the surfaces that had none were exactly the ones no test had
ever driven. Six more were added with the flows that drive them:
`data-list-row` / `data-rank-row` (the two drag sidebars, whose rows otherwise
have no identity at all), `data-user-row` + `data-act` + `data-row-notice`
(`/admin/users`, where **two buttons in adjacent columns both read `Clear`** and
one of them clears an email), `data-svc-row` + `data-svc-state` + `data-probe-now`
+ `data-alert-master` (`/admin/status`), `data-reset-step` + `data-reset-error`
(the reset page, whose two password fields share a placeholder) and
`data-nickname-row`. Extend that set rather than keying a new test to button
text - a copy edit should not be able to turn a test green by accident.

Fixed on the way past: both drag sidebars emitted `<title id="drag-title">`
inside *every* row, so the id was duplicated and each row's `aria-labelledby`
pointed at the first row's title. It is `drag-title-{item.id}` now.

**Misc**
- The header logo's `?` badge tooltip shows the deployed version - the
  `YYYYMMDD-<sha>` tag injected by CI (`APP_VERSION` build-arg ->
  `VITE_APP_VERSION`); local builds show `dev`.
- First load uses a **50-day look-ahead** (`LOOKAHEAD_DAYS` in
  `stores/season.ts` - the admin matching page has its own, 30,
  `computeInitialSeason()` in `stores/season.ts`): if the next season starts
  within 50 days it is shown instead. It was 76, which flipped the default
  two weeks after the current season's premieres - most of a season spent
  looking at one where nothing had aired.
- "X days until [next season]" derives locally from the browser date
  (`nextSeasonInfo()`; season starts Jan/Apr/Jul/Oct 1).
- Ctrl+Shift+R / Ctrl+F5 hard-reloads and resets the cached season selection;
  the last selected season/year is otherwise remembered for an hour.

**`/admin/status`** - is every upstream service still answering us? A sixth
question, distinct from the other five tabs: not identity, scope, production or
access, but whether the things this site is built on are reachable at all. One
row per service with a state badge, the last success, the last failure with its
status code, and whether that service's alerts are on; plus the alert settings
(master switch, per-service toggles, extra recipients) and a "Check now" button.

- **The verdict comes from the server.** `state` is decided by `stateOf` in
  `lib/upstreamHealth.ts`; this page renders it and never recomputes it, so the
  page and the alert email can never disagree. Same division as the subtitles
  page, where `broken` and `staleYtDlp` are the backend's call.
- **`unknown` and `notConfigured` are rendered as themselves, never as OK.**
  "Nothing has asked yet" and "nobody set this up" are the two states the whole
  page exists to keep visible - folding either into green is exactly how skyhook
  stayed invisible for weeks, and the same mistake as an unreachable Sonarr
  reading "0 still to add". A row that is off on purpose says so too.
- **The SMTP row states the circular case out loud**: with mail down, nothing
  can mail to say mail is down, so while that row is red the absence of alerts
  means nothing.
- A TypeScript cast cannot appear in a template expression - `lang="ts"` applies
  to the `<script>` block only, so an inline `as HTMLInputElement` is a *syntax*
  error, not a type error. Handlers that need one live in the script block.
