# Exploratory pass - using SaltyChart as a person

`run_all.py` answers *"does this mechanism work?"* - one flow at a time, from a
clean load, asserted by whoever wrote the feature. This pass answers the
questions that shape can't reach: does the app hold together across a *sequence*,
does anything throw where nobody looks, and does it make sense to a person who
has never seen it.

**This is not a script to automate.** It is a charter for an agent driving a real
browser and behaving like a user.

**Every confirmed finding graduates into the coded suite** - a regression test
plus a `mutation_audit.py` row declaring the substring its failure must contain.
Not "if it recurs": the whole point of finding a bug by hand is that nothing was
watching that spot, and fixing it without leaving a guard behind means the next
pass has to find it again. Pass 1 found six and left six guards.

Run it: before a release, after any change to Home/Randomize/Compare or the
modals, and whenever the suite has been green for a while and you don't trust it.

**Correct this file as part of fixing what it found.** It rots faster than
anything else in the repo, because fixing a finding changes the behaviour the
charter tells you to expect. Within hours of pass 1 it already carried two
instructions that would have made the next agent re-file a withdrawn finding,
and one reference pinned to a source line number that its own fix had moved
(hence the ban on those - cite an identifier). So: past-tense the
finding, record the fix, and **re-read every session step whose expected value
the fix changed**. `test_audit_anchors.py` enforces only the mechanical half -
that cited files exist and that nobody cites a line number.

---

## The bar a finding has to clear

This repo's rule is that a result nobody watched fail isn't trustworthy. Same
applies to your own observations. Record a finding only when:

1. **It reproduces from a fresh page load** - not from the accumulated state that
   surfaced it. If it happens once and won't repeat, write *"seen once, not
   reproducible"*. Don't drop it and don't dress it up.
2. **Evidence is attached** - the console line, the network entry, the measured
   number, the two values that disagree. Never "looks wrong".
3. **You located it in the source.** If you can't find it in the code, label it
   unexplained rather than guessing at a cause.
4. **You judged dev-vs-prod.** Vite serves unminified, rate limiters carry
   `skip: () => _isDev`, and the dev DB has ~660 junk fixture users. None of
   those are bugs.

Then: **report what you did NOT reach**, as plainly as what you found. A clean
report can mean "no bugs" or "I never got there", and only you can tell the
difference.

---

## Traps that produced false findings (read this first)

Every one of these cost real time on the first pass. Each looked like a bug.

- **`performance.getEntriesByType('resource')` silently truncates.** The buffer
  defaults to 250 entries; Home fires ~470 (373 images). Late calls -
  `/api/list`, `check-batch` - fall off the end, and reading the buffer "proves"
  they never fired. They did. Count requests with a Playwright `page.on('request')`
  listener, never from the page's own resource timings.
- **`browser_console_messages({all: true})` returns the whole browser profile's
  history,** including errors from code that no longer exists - this profile
  still carries `jassub` and `loadLibass` errors from a renderer deleted weeks
  ago. Always pass `all: false` for the current page, and check the reported
  error *count* rather than eyeballing the list.
- **YouTube's `static.doubleclick.net/instream/ad_status.js` fails on every
  trailer open.** It is their ad script being blocked. It is not ours. Filter
  `/doubleclick|ad_status|ERR_ADDRESS/` out of console captures.
- **The Randomize wheel renders titles as SVG `<text>` behind a clipping div.**
  `getByText('...')` resolves to the wheel label and hangs for 30 s on a click
  that can never land. Target the list column's `span` instead.
- **`vjs-live-control` exists in the DOM with `aria-label="Seek to live"` even on
  VOD.** It is `display: none`. Enumerating control-bar labels makes a healthy
  VOD player look like it's in live mode. Check `getComputedStyle`, and check
  `video.duration` / `video.seekable`.
- **Season buttons are `Fall` in `textContent` and `FALL` in `innerText`**
  (CSS uppercase). Playwright's `hasText` uses innerText; `document.querySelector`
  loops see the other. Match case-insensitively.
- **A blocked overlay reports as a 30 s click timeout, not as an error.** When
  Playwright says "X intercepts pointer events", that *is* the finding - read the
  element it names.
- **`/[a-f0-9]{32}/` matches a git SHA in a normalize.css comment**, so a naive
  "is the API key in the DOM?" check reports a leak on every page. Print the
  surrounding context before believing it.
- **`button:has-text("TRAILER")` also matches the *"watched trailer"* add
  button,** so a loop that thinks it is opening trailers silently adds shows to
  My List. The trailer control is the **cover-image button** inside the card.
  This produced a clean-looking pass on a path that was never exercised, and the
  claim had to be withdrawn and re-measured.
- **`page.reload()` on a page wedged behind a modal can be raced by the
  measurement that follows it.** Pass 2 briefly concluded a wedge survived a
  reload; a fresh `goto` recovered the page completely. If a reload appears not
  to help, navigate instead before believing it.
- **Your own script can create the bug you then report.** A loop that clicked
  "Mark as watched" and then X faster than a human left rows in a state a real
  user can't produce. If a defect only appears under automation timing, say so
  rather than filing it.
- **Setting a `<select>`'s `.value` in JS skips handlers a real change would
  fire.** Use Playwright's `selectOption`, then re-verify anything you concluded.
- **Two sidebars exist**: `WatchListSidebar` on Home, `WatchedRankingSidebar` on
  Randomize. Findings about "the sidebar" must name which.
- **Go at human speed or you will invent bugs.** Clicking a popup button and
  then its X 1.8 s apart produced a DB state no person can reach. Several
  actions here need 2-3 s to commit and close. Budget real waits, use
  `type({delay})` rather than `fill`, and log in through the form.
- **`.modal` is always in the DOM** in DaisyUI - matching it proves nothing.
  Filter on computed `display`/`opacity`/size, or query a control the open modal
  actually owns (e.g. `input[placeholder="Enter name..."]`).
- **In-page state is not persisted state.** The sidebar's collapsed flag, and
  anything else held in a component variable, survives SPA navigation but not a
  reload - so "it looks fine in my browser" and "it's broken on first load" can
  both be true. Always re-check from a fresh load in a clean context.
- **A page that hangs on `click` may just be a wedged tab** from earlier
  contexts, not a blocked overlay. Check the servers with curl first, then open a
  fresh context before concluding anything.
- **A large `scrollWidth` is not horizontal scroll.** `overflow-x: clip` (set on
  `html, body` in `app.css`, deliberately, so `position: sticky` still works)
  clips without creating a scroll container. Prove scrollability by moving
  `scrollX`, never by comparing widths. This produced a false finding on pass 1.
- **`mutation_audit.py` refuses to run on a dirty tree**, and it is right to -
  it reverts with `git checkout --`, which would delete uncommitted work. So you
  cannot audit a fix before committing it. To watch a new test fail beforehand,
  apply the mutation by hand with Edit, run the single test, and revert by hand.
- **Verify a guard in both directions on real data.** For the unaired gate that
  meant: unaired season -> 0 lookups, *and* an aired season -> still 1. A guard
  tested only where it should fire can be a guard that always fires.

---

## Guardrails

- **Throwaway accounts only.** Sign up as `explore_<unix-ts>`. Never mutate
  `drohack`'s real list.
- **`/admin` is read-only.** Load it, confirm the picker populates and no API key
  appears in the DOM. Never save config - that writes the live Jellyfin URL/key.
- **AniList budget.** Stay on cached seasons; a cold key is **3** upstream
  requests against a degraded **30/min per-IP** limit. At most one deliberate
  cold-season click per pass, with `X-RateLimit-Remaining` read before and after.
  That figure was 100 until 2026-08-06, when `Page.pageInfo` was found to report
  `lastPage: 100` for a 3-page season and the paging was changed to stop on a
  short page. If you ever see a burst of `AniList 429 for <key> pNN` lines with
  NN above ~5, that regressed and the whole budget guardrail is void.
- **Player budget: 2-3 short sessions, each explicitly stopped.** Escape closes
  the player *and* fires `POST /api/jellyfin/playback/stop` - verify that request
  actually goes out. Jellyfin's ffmpeg writes segments until the whole episode is
  done regardless of the playhead, so an orphaned session remuxes ~1 GB for
  nobody. No seek-heavy scrubbing, no restart loops.
- **Collect, don't fix.** Finding and fixing in one motion is how you stop
  looking.
- Close the browser at the end (a previous run stranded 37 Chromium processes)
  and delete any screenshot the moment you've read it. `.playwright-mcp/` is
  gitignored but accumulates - clear your own files.

---

## Sessions, ordered by how common the behaviour is

Weight your effort this way. Browsing the grid is most of what happens here;
Admin is one person, rarely.

**1. Browsing the season.** Scroll the whole grid; open trailer after trailer,
including back-to-back and closing early. Search: partial title, wrong case,
padded whitespace, a misspelling, a show that isn't in this season, then clear
it. Toggle Hide 18+ / sequels / in-My-List. Switch seasons and years and come
back. Watch for covers stuck at the blur-up, autoplay fighting the previous
video, and whether "X days until *season*" matches the calendar.

**2. The returning visitor** - the most common user and the least tested, since
the suite seeds fresh state every time. Reload; navigate away and back; reopen
the tab. Does the remembered season survive (1 h TTL)? Do Options survive - in
the DOM *and* in storage *and* on the server? Does the list still read as
in-My-List? Try `Ctrl+Shift+R`, which resets the remembered season.

**3. Building and tending a list.** Add ~8 shows across two seasons **by
clicking**. Then: add -> switch season -> switch back; add -> hard reload; add ->
remove from the sidebar; mark watched -> reorder by drag -> reload. Validate by
reading the same fact off three surfaces - grid highlight, sidebar, and
`GET /api/list` - and requiring all three to agree.

**4. Randomize.** Spin several times. Open the pop-up, hide a show, then Hide
All / Show All / Hide Not in Library, checking the wheel matches the visible list
after each. **There is no nickname control in the pop-up** - its only controls are
X, HIDE SERIES (UNWATCHED) and MARK AS WATCHED; nicknames are set from Home's
sidebar by **double-clicking** a row (single and right click do nothing). And
**you cannot change season, or log out, with the pop-up open**: it is a real
`<dialog open class="modal">` and it intercepts pointer events on the toolbar.
Confirm that as a property rather than trying to perform it - Playwright reports
it as a 30 s click timeout naming the dialog. Try the custom
Spin button image (drag-drop into `sessionStorage`; a 3 MB data URL stores fine,
so the quota worry pass 1 raised was unfounded - a much larger one may still
throw).

**Count `/api/jellyfin/availability*` per page load**, and expect a number that
depends on the season:
- an **aired** season -> exactly **1** (one batch, never one per show)
- an **unaired** season -> exactly **0** (nothing is looked up; see the `isUnaired`
  gate). If you see a lookup here, that guard has regressed and fuzzy titles will
  start offering the wrong series again.

**5. Watching an episode.** Pop-up -> the *Watch here* button -> playback advances. Speed-step
with `[` and `]`, switch subtitle track, switch quality, seek forward and back,
Escape out. Confirm the stop request fires. Reopen to see whether the second open
is quicker.

**6. Comparing.** Compare a throwaway account against a seeded one. Check the
diff badges against what the two lists actually contain. Flip each side between
pre-watch and post-watch **independently** - that combination isn't covered
anywhere. Try a username that doesn't exist.

**7. A first-time visitor.** Clear storage. Can you tell what this is? Click what
a curious person clicks, then type `/random`, `/compare`, `/admin` into the URL
bar. Watch for gating that half-applies and 401 spam. Then sign up for real and
meet the **empty state** - empty wheel, empty Compare, empty sidebar - which
every automated test seeds past.

**8. On a phone, 390x844,** then 768. Tap targets under ~44 px, modals
overflowing, the wheel's usable size, whether the grid is reachable at all on
arrival. **Check logged-in and logged-out separately** - they differ sharply
here (only the logged-in view has a sidebar). Guest Compare and Randomize need
no phone pass at all: both routes redirect a guest to `/` before rendering.
For horizontal scroll, test `window.scrollTo(500, 0)` and see whether `scrollX`
actually moves - **not** `scrollWidth > innerWidth`, which is non-zero on this
app by design and produced a false finding on pass 1 (`overflow-x: clip` clips
without creating a scroll container).

**9. Ordinary clumsiness.** Double- and triple-click submit buttons. Spam Spin.
Browser back/forward after opening modals. Escape a trailer mid-load. Log out
with a modal open. Two tabs on one account. Throttle the network and reload.

---

## What each pass should produce

A findings list ranked by user impact - *what I did -> expected -> actual ->
evidence -> where in the code -> dev-only or real* - plus the coverage ledger and
the list of what went unreached. Append anything confirmed to the log below.

---

## Findings log

### Found after pass 1 - all three fixed

**A sequel whose season lived inside the *same* TVDB series resolved to S1E1.**
*BLEACH: Thousand-Year Blood War - The Calamity* matched
`Library: Bleach - S1E1 - The Day I Became a Shinigami` - right series, wrong
season, and no season marker in the title for `detectSeasonNumber` to read.

This is **not** an id-tier coverage gap, which is what makes it different from
the fuzzy-match problems above. Checked in `anilistTvdbMap`:

| AniList | title | TVDB |
|---|---|---|
| 185874 | TYBW - The Calamity | **74796** |
| 169755 | TYBW - Soukoku-tan (previous cour) | **74796** |

TVDB models the whole of TYBW as later *seasons of the original Bleach*, so even
a perfect id match lands on series 74796 and still has to choose a season. The
id tier cannot help here by construction.

**Fixed by matching on air date instead of the title.** `relations` (a `PREQUEL`
edge to 169755) was the first idea, but the chain runs back through every cour to
the 2004 original, so "prequels deep" is not a TVDB season number - it would have
swapped one confidently-wrong episode for another.

`startDate` is the better key: language-independent, needs no marker, and the
same fact on both sides. `getFirstEpisode` now picks the episode whose
`PremiereDate` is nearest, within +/-31 days (a cour is ~90, so there is wide
clearance). Against this entry it picks **S17E41, 0 days off** - and note it
lands *mid-season*, on the cour boundary, which a season number cannot express.
A miss is also treated as evidence: a usable date plus dated episodes plus
nothing within a month means the library holds a different part of the
franchise, so it reports unavailable rather than falling back to episode 1.

The tiers are now: air date -> season marker in the title -> first episode
overall. **Note the persisted cache**: answers live in `AppConfig`
`jellyfinAvailability` for up to an hour *across restarts*, so a matcher fix
would otherwise keep serving old answers through the deploy. `MATCH_ALGO_VERSION`
is stamped on every entry and mismatches are dropped on load; bump it whenever
matching changes.

**The Jellyfin player pop-up was much smaller than the trailer pop-up** - its
`modal-box` was `w-full max-w-5xl`, a hard 64rem/1024px cap at any screen size,
against the trailer's scaling `w-[95%] md:w-5/6 lg:w-4/5`. Fixed by giving it the
trailer's widths plus `max-h-[95vh]`, with `min-h-0 flex-1` on the video row so a
wide-but-short window can't push the control bar off the bottom.

**The 76-day look-ahead was switching the default too early** - two weeks after
the *current* season's premieres you stopped landing on the season actually
airing, and (since the unaired gate above) that default view is one where nothing
can be in the library by definition. Now **50 days**: on Aug 2, 60 days from Oct
1, the app opens on the airing SUMMER 2026. `LOOKAHEAD_DAYS` in `stores/season.ts`.

That change also produced the sharpest lesson of the day. Declaring the constant
next to `computeInitialSeason()` looked obviously fine, type-checked clean, and
**rendered the entire app blank** - the store initialises eagerly at module load,
so the `const` was still in its temporal dead zone: `Cannot access
'LOOKAHEAD_DAYS' before initialization`. `test_frontend_smoke` caught it in about
six seconds. Module-level constants used during module initialisation must be
declared at the top of the file, and this is the fourth runtime-only failure in
this repo that no type check could see.

### Pass 2 - 2026-08-06 (local dev)

Sessions 1, 2, 3, 4, 6, 7, 8 and most of 9. Session 5 skipped (`test_player.py`
covers it in 10 steps and it is the most expensive session in server resources);
the cold-season load skipped deliberately on budget. **Five behaviour defects,
all fixed with a guard; two of them were pass-1 fixes reachable through a new
door, which is what this log exists to detect.**

| # | finding | fix + guard |
|---|---|---|
| 1 | **The wrong theme was painted on every load for a logged-in user, and a guest's chosen theme was discarded at signup.** `data-theme` went `light` at 76 ms, `/api/options` resolved at 85 ms, `dark` at 87 ms; with the response delayed 300 ms the wrong-theme window was **504 ms**, so it scales with server latency. Separately: pick NIGHT as a guest, sign up, and the DOM said `light`, the server `SYSTEM`, localStorage `NIGHT` - three surfaces disagreeing permanently, and logging out then flipped the site to dark | **NOT YET FIXED** - see the open items below |
| 2 | **A phone dismissal of the My List sidebar stopped persisting** once the sidebar had ever been explicitly opened; every load put the full-screen sidebar back over the grid (25/25 sampled viewport points) | explicit `on:collapse` signal - see the pass-1 table above |
| 3 | **An oversized wheel image wedged Randomize behind a modal that could not be closed.** A 19 MB PNG threw `QuotaExceededError` from an unguarded `sessionStorage.setItem` *inside a Svelte update flush*, so the rest of the flush never ran and `showImageUploadModal = false` stopped reaching the DOM - Done, the X and Escape all dead, until a reload. Nothing stored, nothing said | guarded `persistImage()` + a `data-image-too-large` message; flow `wheel image quota` |
| 4 | **Escape did not close the Upload Custom Images modal** - a third modal pass 1's Escape work missed. It is a `<dialog open>`, not `showModal()`, so it never had native Escape behaviour while its `.modal` backdrop still covered the screen | added to `handleModalKey`'s priority order; same flow |
| 5 | **Un-watching left a stale `watchedRank`** - see the reversed withdrawal below | `list.ts` nulls + compacts; `test_api_smoke.py` step 14 |

Smaller, all fixed: Compare's user dropdown rendered svelte-select's default
"No options" because `noOptionsMessage` and `dropdownClass` are **not props of
svelte-select 5** (the console said so on every visit; v5 uses an `empty` slot);
every trailer button's accessible name was the constant `"Trailer thumbnail"`, so
a screen reader announced all 109 cards identically; a logged-out visitor fired
the rate-limited `/api/list/users-with-ratings` for a picker it never sees; a
guest saw the Admin tab bar above the "only available to the site admin" notice.
`stores/season.ts` told the reader to keep its TTL in sync with a backend TTL it
named as 1 h when the backend's is 6 h.

**Recorded and deliberately not changed** (a decision, not an oversight): the
rename/remove modal is reachable only by **double-clicking** a sidebar row, with
no affordance; submit buttons are not disabled in flight, so a triple-click sent
3 `POST /auth/login`; cross-tab logout does not stop the other tab's writes
(stateless JWT, no revocation). On tap targets: the measurement sampled the
20x20 `<input>`, but each is wrapped in its `<label>`, so the real target is
wider and only the ~20 px *height* is under the WCAG 2.2 AA 24x24 floor -
**re-measure the label, not the input, before acting on it.**

**Still open after pass 2:**

- **The theme defect (row 1) is unfixed.** Root cause is confirmed: the token
  branch of `authToken.subscribe` in `stores/options.ts` never *reads* the
  localStorage mirror, and never *writes* it during load because `isLoading`
  gates the persist subscriber - so the mirror the comment says exists "so the
  theme survives the gap" is written and never used on the one path that needs it.
- Four more defects in that same file, **found by reading and not yet
  reproduced**: a logout during an in-flight login fetch applies the previous
  account's options; there is no request-id guard on the `/api/options` fetch, so
  a rapid account switch can PUT one user's options onto another's row; the
  debounced save is not cancelled on an auth change and fires with a stale token;
  and a `null` JSON body throws inside `deepMergeOptions` and silently resets to
  defaults. Reproduce each before fixing it.
- `check-batch` sends ~91 ids whose response is always discarded when the
  leftovers call lands after it. **Left alone on purpose:** the fix is to merge
  rather than replace, which weakens the staleness guard that stops two seasons
  mixing, and the saving is one DB-only request measured at ~5 ms. Not worth it.
- Never reached: `/admin/matching` as an admin (promoting a throwaway user in the
  **dev DB only** is pre-authorised), Randomize's nickname-panel toggles,
  Compare's Share-as-image, and the `2cols`/`3cols` wide-desktop breakpoints.

### Pass 1 - 2026-08-01 (local dev, `1f5b20c`)

**All six were fixed the same day, and every one now has a regression test and a
`mutation_audit.py` row** - though for months that sentence was only two-thirds
true: the unaired, Escape and no-results fixes got their guards immediately,
while check-batch chunking, the Server-busy chip, the phone sidebar and the
"small three" had none, and this file claimed otherwise. The gap is closed now:
`test_ui_interactions` flows cover all six, and the rows (named, not numbered -
row numbers shift as the table grows) are "check-batch is sent everything in
one request again", "a failed translation is console-only again", "the phone
sidebar opens over the whole page again" + "a desktop visit records itself as
'chose expanded'", "a guest's options stop reaching localStorage", and "a
typo'd Compare user renders as silence again". Every one was watched to fail
for its named reason and to pass on clean code. Writing the phone-sidebar guard
found a live regression: the reactive prefs-save persisted the *width default*
as though the user chose it, so one desktop visit put the full-screen sidebar
back on every later phone load - fixed by only persisting an explicit choice. So the entries below describe **what the app did
before the fix, not what it does now** - they are kept in the past tense with
their original evidence, because that evidence is what lets the next pass tell a
*regression* from a *new* bug. If you reproduce one of these, it has come back.

What each fix was:

| # | fix |
|---|---|
| unaired lookups | `isUnaired()` in `stores/jellyfin.ts` gates both entry points; unaired entries resolve `{available:false, notAired:true}` with **no request**. Pop-up says "Not aired yet"; Hide-Not-in-Library ignores them |
| Escape / close | `<svelte:window on:keydown>` in `AnimeGridTranslate` + `Escape` added to Randomize's existing window handler; a real X button on the trailer modal |
| check-batch | `Home.svelte` chunks at 100 and merges, staleness guard covering the whole set |
| Server busy | transient chip beside the CC toggle, auto-clears after 6 s, never gates playback |
| phone sidebar | `collapsed` is a bound prop defaulting to collapsed below `sm`, persisted in `prefs-<user>`; toggle tabs given 44 px targets. **Pass 2 found a third door onto the same bug** and it is fixed differently: `sidebarChoiceMade` used to be *inferred* by diffing the value in a reactive block that runs before `loadPrefs`, so a stored value disagreeing with the width default made the inference wrong and a dismissal was never persisted. It is recorded at the click now (`on:collapse`), which removes the ordering dependency instead of reshuffling it |
| small three | no-results message; options always mirrored to `localStorage`; "No user named ..." on Compare |

Confirmed at the time (all since fixed - see the table above):

- **The My List sidebar opened over the whole screen on every phone page load,
  for logged-in users.** At 375x667 with full mobile emulation the `<aside>` is
  375x667 at (0,0), opaque, and 25/25 sampled viewport points land on it -
  `collapsed` in `WatchListSidebar.svelte` initialised to `false` with no width
  check and no persistence. One tap on the 24x64 px chevron dismisses it and the page is
  perfectly usable after that (this is why it can look fine in a session that has
  already dismissed it) - but **every fresh load puts it back**. Guests are
  unaffected. Scope this claim carefully: it is "you must dismiss it on every
  load", not "the app is unusable".
- ~~**81 px of horizontal body scroll at 390 px**~~ - **WITHDRAWN, measurement
  error.** `document.body.scrollWidth - innerWidth` is 96 px at 375 px, but
  `app.css` sets `html, body { overflow-x: clip }`, which clips *without*
  creating a scroll container. Verified: `window.scrollTo(500, 0)` leaves
  `scrollX` at 0, so a user cannot actually scroll sideways. `scrollWidth`
  proves nothing on its own - **test whether `scrollX` can change.**
- **Escape closed neither the trailer modal nor the Randomize pop-up.** The
  handler sat on a `tabindex="-1"` overlay div that never receives focus. The
  trailer modal had **no close button at all** - the backdrop was the only way
  out. Escape *did* work on the Jellyfin player, so the behaviour was
  inconsistent across three modals.
  **Why the suite missed it, and the lesson:** `test_ui_interactions` step 9 was
  named "Escape closes" and printed "pressing Escape -> expect modal gone", but
  then fell back to clicking the backdrop and asserted on *that*. It passed for
  months with Escape entirely broken. The fallback is gone now and the step also
  asserts the X button exists. **When a test offers an alternative path on
  failure, it is asserting the alternative, not the thing in its name.**
- **`check-batch` is sent ~126 IDs and the server slices to 100.** Home posts
  `[...current, ...prev]` unchunked. Six videos in the dropped tail had English CC
  recorded in the DB that the page never learned about - each one becomes an
  unnecessary Whisper translation on open.
- **"Server busy, try again shortly" never reaches the user.** At
  `MAX_CONCURRENT` (2) the SSE error sets `translationLoading = false`, which is
  the only thing gating the status chip, so the message is logged to the console
  and nothing renders. Indistinguishable from "this trailer has no subtitles".
  *Low priority in practice*: the nightly local GPU run pre-translates
  aggressively, so few trailers reach the live path at all, and it takes three
  concurrent uncached opens to trigger.
- **A no-match search rendered nothing** - no "no results" message, just an empty
  page below the toolbar.
- **The id tier is healthy; fuzzy matching is dangerous exactly where the id tier
  can't help.** Measured with `check_match_corpus.py`:

  | season | id-confirmed | title-only | not in library |
  |---|---|---|---|
  | SPRING 2026 (aired) | **10** | 1 | 43 of 54 |
  | FALL 2026 (unaired - *the season the app opens on*) | **0** | **7** | 52 of 59 |

  For an aired season the id tier does 10 of 11 matches and title-only is rare.
  For an unaired season the community AniList->TVDB map has no entries yet, so
  every match is a fuzzy guess against a library that cannot contain the show -
  and **all 7 were wrong**: *Firefly Wedding* -> **Firefly**, *Dragon Ball Super:
  Beerus* -> **Dragon Ball**, plus five right-series/wrong-season hits offering
  S1E1. The lookahead (now 50 days - see the pass-2 finding above) can make
  this the default view late in a season.

  Two contributing causes: `matchByTitle`'s prefix tier accepts a 5-char
  normalised prefix (`witch`  subset of  `witchontheholynight`), and `detectSeasonNumber`
  recognises only `Nth Season` / `season N` / `第N期` - not `Part 2`, roman
  numerals (`II`), trailing digits (`Edgerunners 2`) or named arcs - while
  `expandCandidates` *does* strip `part N`, so those match the base series and
  are then handed episode 1. The pop-up shows `Library: <title>` and
  `(!) unconfirmed match`, which is what keeps this from being critical.

  Note the corpus tool checked 59 FALL entries where a raw `/api/anime` sample
  gave 83 across all formats (14 "available"), so the tool **under-reports
  exposure** relative to what Randomize actually shows.

  **The fix is upstream of the matcher**: a series that has not aired cannot be
  in the library, so it should never be looked up at all. The payload already
  carries what's needed - every entry has `startDate` *and* a `status` enum:

  | season | entries | status breakdown |
  |---|---|---|
  | FALL 2026 | 83 | **83 x `NOT_YET_RELEASED`** |
  | SPRING 2026 | 113 | 82 `FINISHED` + 31 `RELEASING`, zero unreleased |

  Skipping `NOT_YET_RELEASED` removes every false positive on the default season,
  costs nothing on aired seasons, and saves 83 library lookups per page load.
- **Theme never reached `localStorage.options` for a logged-in user** - server
  said `LIGHT`, DOM applied `light`, localStorage stayed `SYSTEM` indefinitely.
- **A non-existent username on Compare silently kept the previous comparison**,
  with no feedback, under a heading naming the user who was just typed.

Verified working (don't re-litigate without new evidence): list persistence
across reload and season switches, with grid/sidebar/API agreeing; exactly one
`availability/batch` call per Randomize load; SPA back/forward; Compare's diff
arithmetic; triple-click add is idempotent; the player (first frame ~2 s, seek to
120 s resumed cleanly, Escape stopped the session *and* fired
`playback/stop`); Randomize's empty state; the search box's `<label for>`;
`check-batch` and `/api/list` firing on 6/6 loads; Hide All / Show All / Hide Not
in Library (all persist across reload); mark-as-watched (`watched` + `watchedAt`
+ `watchedRank` all set); the two-step password reset round trip; `/admin`
correctly gated for non-admins with no key in the DOM; progressive loading on a
throttled 50 KB/s link (toolbar, skeletons and 82 cards by second 2); a 3 MB
Spin-button data URL storing without a quota error.

**Season fetch timing**, measured with curl: warm **8.9 ms**, cold
**186 s** - the latter with the AniList budget already drawn down to 7/30 by
testing. It returned 200 with real data; a cold season is 6-12 pages and each
can independently hit the limiter, so this is the documented design rather than
a violation of it. Worth knowing the user sees skeleton shimmer for that whole
time with no "we're being rate-limited" message.

Also verified, at deliberately human pace (see *Traps* - the first attempt at
several of these failed on my speed, not the app):

- **Drag-to-reorder ranking** - dragged the last watched item to the top; DOM
  order, API ranks (0,1,2) and a single ordered `PATCH /list/rank` all agreed,
  and it survived a reload.
- **Two tabs, same account** - tab A adds (8->9); tab B, still showing a stale 8,
  adds too; result is **10**, both survive a reload. The add path is additive,
  not a stale whole-list overwrite. This was the highest-risk data-loss scenario
  here and it is clean.
- **Player subtitle + quality switching** - subtitle menu correctly defaulted to
  `English - Default - ASS` out of 8 tracks; switching to German rebuilt the
  stream and resumed at 15.3 s; switching to 480p changed the element from
  1280x720 to **854x480** and resumed at 28.4 s. Three `playback/stop` calls for
  two rebuilds plus the close - exactly the documented behaviour. No console
  errors throughout.
- **Rename-on-add** - "Set Custom Name" modal, Enter submits, persists as
  `customName` and shows in the sidebar after a reload.

Nothing on the original list is now untested.

~~Withdrawn: three entries once showed `watchedRank: 0` with `watched: false`~~
- **WITHDRAWAL REVERSED by pass 2, and it was a real defect.** Pass 1 could not
reproduce it by clicking, concluded "harness artifact", and moved on. It is
reachable by **one click**: the un-watch X on Randomize's *Watched* sidebar
cleared `watched` and `watchedAt` and left `watchedRank` behind. Nothing else
could clear it - the follow-up `PATCH /list/rank` filters on `watched: true` and
its `ids` array omits the row just un-watched - so a later re-watch revived the
old rank and two watched entries ended up sharing one, after which the ranking
sidebar's comparator returns 0 for the pair and silently falls back to pre-watch
order. Fixed server-side in `list.ts`: un-watch nulls the rank *and* compacts the
survivors, because the append computes `watchedCount - 1` and that is only sound
while the ranks are dense. Guarded by `test_api_smoke.py` step 14 and two
mutation rows.

**The lesson is about the withdrawal, not the bug.** "I clicked it and it didn't
happen" is not the same as "it cannot happen" - pass 1 had the state in front of
it, in a DB read, and reasoned it away. When a measurement disagrees with your
model of the code, prefer re-reading the code.
