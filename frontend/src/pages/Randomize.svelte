<script lang="ts">
import SeasonSelect from '../components/SeasonSelect.svelte';
import { authToken, userName as activeUserName } from '../stores/auth';
import { seasonYear } from '../stores/season';
import { get } from 'svelte/store';
import { options } from '../stores/options';
import LoadingSpinner from '../components/LoadingSpinner.svelte';
import { onMount } from 'svelte';
import { allUsers as nicknameAllUsers, selectedUsers as nicknameSelected, toggleUser as toggleNicknameUser } from '../stores/nicknameUsers';
import { checkAvailability, checkAvailabilityMany, mediaConfigured, libraryStatus, type MediaAvailability } from '../stores/jellyfin';
import { loadCastSdk, loadVideoJs, prewarm } from '../lib/jellyfinPrewarm';
import { apiFetch, apiJson, QUICK, ApiError } from '../lib/remote';

/** Set when a hide/show write failed and the optimistic change was put back. */
let hideWriteError = '';
// Reactive trigger for title-language changes
$: _lang = $options.titleLanguage;

  import type { Season } from '../stores/season';

  let season: Season = get(seasonYear).season;
  let year: number = get(seasonYear).year;

  // Push local changes back to store
  let _lastKey = `${season}-${year}`;
  $: {
    const key = `${season}-${year}`;
    if (key !== _lastKey) {
      _lastKey = key;
      seasonYear.set({ season, year });
    }
  }

  // User list for current season/year
  let watchList: any[] = [];
  let anime: any[] = [];

  // Lists derived later but need initial declaration for TS
  let unwatchedDetailed: any[] = [];

  // Sort mode for unwatched list: 'rank' (default) or 'alphabetical'
  let unwatchedSortMode: 'rank' | 'alphabetical' = 'rank';

  // Wheel DOM reference & animation state
  let wheelEl: HTMLDivElement;
  let rotation = 0; // degrees
  let spinning = false;

  // Selected item after spin
  let selected: any = null;
  // Track last selected wheel item ID to avoid immediate repeats
  let lastSelectedId: number | null = null;

  // Derived: this user's rank for the selected show (1-based), on exactly the
  // same scale as the other users' ranks shown alongside it.
  //
  // `/api/list/nicknames` computes everyone else's as `watchedRank ?? order`,
  // so an unwatched show still shows their pre-watch list position. This used
  // to require `entry.watched` and return null otherwise — and since the wheel
  // only ever holds *unwatched* shows, that meant your own number was missing
  // from the pop-up essentially always, while everyone else's was right there.
  // Mirror the server's rule instead of being stricter than it.
  $: myRank = selected
    ? (() => {
        const entry = watchList.find((w) => w.mediaId === selected.id);
        if (!entry) return null;
        if (typeof entry.watchedRank === 'number') return entry.watchedRank + 1;
        if (entry.watched) {
          // Watched but not yet persisted a rank — use the sidebar position.
          const idx = watchedRank.findIndex((it) => it.id === selected.id);
          if (idx !== -1) return idx + 1;
        }
        return typeof entry.order === 'number' ? entry.order + 1 : null;
      })()
    : null;
  let nicknameList: Array<{ userName: string; nickname: string | null; rank: number | null }> = [];

  // Upload images modal state
  let showImageUploadModal = false;

  // Custom uploaded images (session-only)
  let spinButtonImage: string | null = null;
  let backgroundImage: string | null = null;
  let imagesLoaded = false; // Flag to prevent reactive statement from clearing before load

  // --------------------------------------------------------------
  // Hide / Show all helpers for the Unwatched list
  // --------------------------------------------------------------

  // Derived: whether every unwatched entry is currently hidden.
  $: allHidden = unwatchedDetailed.length > 0 && unwatchedDetailed.every((it) => it.hidden);

  $: hasHidden = unwatchedDetailed.some((it) => it.hidden);
  $: hasVisible = unwatchedDetailed.some((it) => !it.hidden);

  // Helper to update hidden flag in bulk
  async function setHiddenForAll(targetHidden: boolean) {
    if (!$authToken) return;

    const targets = unwatchedDetailed.filter((it) => it.hidden !== targetHidden);

    watchList = watchList.map((entry) => {
      const hit = targets.find((t) => t.id === entry.mediaId);
      return hit ? { ...entry, hidden: targetHidden } : entry;
    });

    // The local change above is optimistic. Until now the write that backs it
    // was fire-and-forget with `.catch(() => {})`, so a failure left the screen
    // showing shows as hidden while the server disagreed — reload and they were
    // all back. Silent data loss, and per-show, so a partial failure left the
    // list half-applied with nothing to indicate it. Revert what didn't stick.
    const failed = await writeHidden(targets.map((t) => t.id), targetHidden);
    if (failed.length) revertHidden(failed, !targetHidden, targets.length);
  }

  /** Persist one hidden flag per show. Returns the ids that did not stick. */
  async function writeHidden(ids: number[], hidden: boolean): Promise<number[]> {
    const failed: number[] = [];
    await Promise.all(
      ids.map(async (mediaId) => {
        try {
          await apiFetch(
            '/api/list/hidden',
            {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${$authToken}` },
              body: JSON.stringify({ season, year, mediaId, hidden }),
            },
            { label: 'list/hidden', timeoutMs: QUICK }
          );
        } catch {
          failed.push(mediaId); // apiFetch already logged the reason
        }
      })
    );
    return failed;
  }

  /** Put the optimistic change back, and say so rather than diverging quietly. */
  function revertHidden(ids: number[], back: boolean, attempted: number) {
    const undo = new Set(ids);
    watchList = watchList.map((e) => (undo.has(e.mediaId) ? { ...e, hidden: back } : e));
    hideWriteError = `Couldn't save ${ids.length} of ${attempted} change${attempted === 1 ? '' : 's'} — put back.`;
    setTimeout(() => (hideWriteError = ''), 8000);
  }

  const hideAll = () => setHiddenForAll(true);
  const showAll = () => setHiddenForAll(false);

  // Hide everything the library doesn't have, so the wheel only spins on
  // shows that can actually be watched. Availability is already prefetched
  // for the whole list, so these lookups come from cache.
  let hidingNonLibrary = false;

  async function hideNotInLibrary() {
    if (!$authToken || hidingNonLibrary) return;
    hidingNonLibrary = true;
    // The lookups below are awaited, so the season could change underneath us
    // — writing then would hide the wrong season's shows.
    const forSeason = season;
    const forYear = year;
    try {
      const visible = unwatchedDetailed.filter((it) => !it.hidden);
      // One request, not one per show. `checkAvailabilityMany` omits any entry
      // it couldn't get a definite answer for, which is exactly the semantics
      // this function needs — see the "never hide on unknown" note below.
      const results = await checkAvailabilityMany(
        visible.map((it) => ({
          mediaId: it.id,
          titles: [
            it.customName,
            it.title?.english,
            it.title?.romaji,
            it.title?.native,
          ].filter(Boolean),
          airing: { status: it.status, startDate: it.startDate },
        }))
      );
      if (season !== forSeason || year !== forYear) return;
      const next = new Map(libraryAvailability);
      // Skip notAired here too, not only in the hide filter below: this map
      // drives the button's enabled state and tooltip, and recording an
      // unaired show as `false` lit "Hide Not in Library" on seasons where
      // nothing had been checked against the library at all.
      for (const [id, info] of results) {
        if (!info.notAired) next.set(id, info.available);
      }
      libraryAvailability = next;
      // Never hide on an inconclusive answer — a timeout must not make
      // shows disappear from the wheel. An `unknown` verdict never reaches
      // `results`, so an unanswered show simply isn't in it, and the explicit
      // `=== false` below refuses to act on an absent entry.
      //
      // Title-only (`matchedBy === 'title'`) matches need no guard here: they
      // report `available: true`, so this only ever *keeps* them. That is the
      // conservative direction — an unconfirmed match's danger is playing the
      // wrong series, which the popup warns about, not vanishing from the wheel.
      //
      // `notAired` is also `available: false`, but it means "can't exist yet",
      // not "we looked and it's missing". On an unaired season that is every
      // entry, so hiding on it would empty the wheel in one click.
      const missing = visible.filter((it) => {
        const info = results.get(it.id);
        return info?.available === false && !info.notAired;
      });
      if (!missing.length) return;

      watchList = watchList.map((entry) =>
        missing.some((m) => m.id === entry.mediaId) ? { ...entry, hidden: true } : entry
      );
      // Same optimistic-write rule as setHiddenForAll: revert whatever the
      // server didn't accept, rather than leaving the screen and the database
      // disagreeing until the next reload.
      const failed = await writeHidden(missing.map((m) => m.id), true);
      if (failed.length) revertHidden(failed, false, missing.length);
    } finally {
      hidingNonLibrary = false;
    }
  }

  /**
   * Toggle the `hidden` flag for a single item.
   *
   * Optimistic, with the same failure contract as the bulk paths: the write
   * goes through writeHidden, and one the server refuses is put back and
   * announced via hideWriteError. This used to be the one hide path that
   * ignored failure — the show looked hidden, the server never saved it, and
   * the next reload quietly undid it.
   */
  async function toggleHide(item: any) {
    if (!$authToken) return;
    const targetHidden = !item.hidden;

    watchList = watchList.map((w) =>
      w.mediaId === item.id ? { ...w, hidden: targetHidden } : w
    );

    const failed = await writeHidden([item.id], targetHidden);
    if (failed.length) revertHidden(failed, !targetHidden, 1);
  }

  // Fetch nickname list whenever modal opens (and selected differs)
  $: if (showModal && selected) {
    (async () => {
      try {
        const res = await fetch(`/api/list/nicknames?mediaId=${selected.id}`);
        nicknameList = res.ok ? await res.json() : [];
      } catch {
        nicknameList = [];
      }
    })();
  }

  // ── Library availability (never blocks the modal) ───────────────────
  let watchInfo: MediaAvailability | null = null;
  let showPlayer = false;
  let JellyfinPlayerModal: any = null;

  $: if (showModal && selected) {
    const id = selected.id;
    const titles = [
      selected.customName,
      selected.title?.english,
      selected.title?.romaji,
      selected.title?.native,
    ].filter(Boolean);
    const airing = { status: selected.status, startDate: selected.startDate };
    watchInfo = null;
    // Reopening a show must not land in the picker someone left open on a
    // previous one — the state belongs to this pop-up, not the page.
    closePicker();
    checkAvailability(id, titles, false, airing)
      .then((info) => {
        // Guard against a stale resolve after the user opened a different show.
        if (selected?.id !== id) return;
        watchInfo = info;
        // This pop-up stays open while its synopsis is read, so spend that time
        // on what the player will want — what is warmed, and why nothing ever
        // touches the HLS manifest, is jellyfinPrewarm.ts's module header.
        if (info.available && info.itemId && info.mediaSourceId) {
          loadPlayerModal();
          prewarm(info.itemId, info.mediaSourceId);
        }
        // Cached "not available" → re-check live, so a show downloaded a
        // minute ago appears without waiting out the cache TTLs. Skipped for
        // `notAired`: nothing was cached and nothing can be downloaded yet, so
        // this would just re-issue the lookup the gate exists to prevent.
        if (!info.available && !info.notAired) {
          checkAvailability(id, titles, true, airing)
            .then((freshInfo) => {
              if (selected?.id !== id) return;
              watchInfo = freshInfo;
            })
            .catch(() => {});
        }
      })
      .catch(() => {});
  }

  /** The player chunk is fetched early — its weight and why are on `warmPlayerAssets` below. */
  let playerModalPromise: Promise<any> | null = null;

  function loadPlayerModal(): Promise<any> {
    if (!playerModalPromise) {
      playerModalPromise = import('../components/JellyfinPlayerModal.svelte').then(
        (m) => m.default
      );
      playerModalPromise.catch(() => (playerModalPromise = null));
    }
    return playerModalPromise;
  }

  let openingPlayer = false;

  async function openPlayer() {
    if (openingPlayer) return;
    openingPlayer = true;
    try {
      JellyfinPlayerModal ??= await loadPlayerModal();
      showPlayer = true;
    } catch (err) {
      // A failed chunk load must say so rather than leaving a dead button.
      console.error('[randomize] could not load the player', err);
      alert('Could not load the player. Check your connection and try again.');
    } finally {
      openingPlayer = false;
    }
  }

  // A plain function so the reactive block that calls it neither reads nor
  // writes `showPlayer` directly (which would drag extra invalidations
  // into that statement).
  /**
   * "Not the right show?" — let the viewer pin this entry to a library item.
   *
   * This pop-up is where a wrong match is actually noticed; /admin/matching is
   * where it could be fixed, and nobody goes there. A pick is written as an
   * identity override, so it is remembered FOR EVERYONE and lands in the admin
   * review queue rather than being one person's private workaround.
   *
   * Options are LIBRARY items only — every one of them can actually play. The
   * resolver's stored candidates are mostly things we don't hold, which is
   * usually why a row is unverified in the first place.
   */
  type PickOption = {
    kind: 'tv' | 'movie';
    itemId: string;
    title: string;
    year: number | null;
    tvdbId: string | null;
    tmdbId: string | null;
  };
  let pickOpen = false;
  let pickTerm = '';
  let pickResults: PickOption[] = [];
  let pickBusy = false;
  let pickError = '';
  let pickTimer: ReturnType<typeof setTimeout> | null = null;
  let pickReqId = 0;

  /** TVDB titles often embed their own disambiguation year — "ONE PIECE (2023)"
   *  must not render as "(2023) (2023)". Same rule as /admin/matching. */
  function pickLabel(opt: PickOption): string {
    return opt.year == null || opt.title.endsWith(`(${opt.year})`)
      ? opt.title
      : `${opt.title} (${opt.year})`;
  }

  function closePicker() {
    pickOpen = false;
    pickError = '';
    if (pickTimer) clearTimeout(pickTimer);
    pickTimer = null;
  }

  function openPicker() {
    if (!selected) return;
    pickOpen = true;
    pickError = '';
    // Prefilled with the entry's own title and searched at once — the common
    // case should show options without anyone typing.
    pickTerm = selected.customName || getEnglishTitle(selected) || '';
    void runPickSearch(pickTerm);
  }

  function queuePickSearch() {
    if (pickTimer) clearTimeout(pickTimer);
    const term = pickTerm.trim();
    if (!term) {
      pickResults = [];
      return;
    }
    pickTimer = setTimeout(() => void runPickSearch(term), 500);
  }

  async function runPickSearch(term: string) {
    const reqId = ++pickReqId;
    pickBusy = true;
    pickError = '';
    try {
      const r = await apiJson<{ results: PickOption[] }>(
        `/api/jellyfin/library/search?term=${encodeURIComponent(term)}`,
        { headers: { Authorization: `Bearer ${$authToken}` } },
        { label: 'randomize/library-search', timeoutMs: QUICK }
      );
      if (reqId !== pickReqId) return; // a later keystroke already won
      pickResults = r?.results ?? [];
    } catch {
      if (reqId !== pickReqId) return;
      pickError = "Couldn't search your library.";
      pickResults = [];
    } finally {
      if (reqId === pickReqId) pickBusy = false;
    }
  }

  /** Undo — put the entry back to whatever the matcher works out on its own. */
  async function clearPick() {
    if (!selected) return;
    const id = selected.id;
    const titles = [
      selected.customName, selected.title?.english,
      selected.title?.romaji, selected.title?.native,
    ].filter(Boolean) as string[];
    const airing = { status: selected.status, startDate: selected.startDate };
    pickBusy = true;
    pickError = '';
    try {
      await apiJson('/api/jellyfin/identity/unpick', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${$authToken}` },
        body: JSON.stringify({ mediaId: id }),
      }, { label: 'randomize/identity-unpick', timeoutMs: QUICK, retries: 0 });
      closePicker();
      const info = await checkAvailability(id, titles, true, airing);
      if (selected?.id !== id) return;
      watchInfo = info;
    } catch (e) {
      const err = e as ApiError;
      pickError = err?.kind === 'http' && err.status === 409
        ? 'An admin has already settled this one.'
        : "Couldn't reset that match.";
      pickBusy = false;
    }
  }

  async function pickLibraryItem(opt: PickOption) {
    if (!selected) return;
    const id = selected.id;
    const titles = [
      selected.customName,
      selected.title?.english,
      selected.title?.romaji,
      selected.title?.native,
    ].filter(Boolean) as string[];
    const airing = { status: selected.status, startDate: selected.startDate };
    pickBusy = true;
    pickError = '';
    try {
      await apiJson(
        '/api/jellyfin/identity/pick',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${$authToken}` },
          body: JSON.stringify({ mediaId: id, itemId: opt.itemId }),
        },
        { label: 'randomize/identity-pick', timeoutMs: QUICK, retries: 0 }
      );
      closePicker();
      // Re-resolve so the Watch button points at the picked show's episode.
      // `fresh` bypasses both caches; the pop-up's own staleness guard applies
      // because the viewer may have moved on while this was in flight.
      const info = await checkAvailability(id, titles, true, airing);
      if (selected?.id !== id) return;
      watchInfo = info;
      if (info.available && info.itemId && info.mediaSourceId) {
        void loadPlayerModal();
        prewarm(info.itemId, info.mediaSourceId);
      }
    } catch (e) {
      const err = e as ApiError;
      pickError =
        err?.kind === 'http' && err.status === 409
          ? 'An admin has already settled this one.'
          : "Couldn't save that pick.";
      pickBusy = false;
    }
  }

  function closePlayer() {
    if (showPlayer) showPlayer = false;
  }

  // Loading state while fetching list & anime
  let loading = false;

  // ------------------------------------------------------------------
  // Mobile sidebar collapse state (unwatched & watched lists)
  // ------------------------------------------------------------------

  let unwatchedCollapsed = true;
  let watchedCollapsed = true;

  onMount(() => {
    if (window.matchMedia('(min-width: 1024px)').matches) {
      unwatchedCollapsed = false;
      watchedCollapsed = false;
    }
  });

  // `mediaConfigured` resolves after login rather than at mount, so this waits
  // for it instead of checking once and giving up.
  let playerAssetsWarmed = false;
  $: if ($mediaConfigured && !playerAssetsWarmed) {
    playerAssetsWarmed = true;
    warmPlayerAssets();
  }

  /**
   * The player's page-level weight: the video.js chunk (~0.66 MB built, 1.6 MB
   * unminified from the dev server). It doesn't depend on which show is picked,
   * so waiting for a pop-up throws away all the time someone spends choosing
   * one — and over the web, rather than localhost, that gap is long enough that
   * pressing Watch looks broken.
   *
   * Per-episode data (the episode's PlaybackInfo) can't be fetched this early
   * and is warmed when the pop-up opens instead.
   *
   * Only for viewers who can actually play something, on idle so it never
   * competes with the page's own images, and never on a metered connection —
   * this is a convenience, not something worth spending someone's data plan on.
   */
  function warmPlayerAssets() {
    const conn = (navigator as any).connection;
    if (conn?.saveData || /(^|-)2g$/.test(conn?.effectiveType ?? '')) return;
    const idle = (window as any).requestIdleCallback ?? ((fn: () => void) => setTimeout(fn, 1500));
    idle(() => {
      loadPlayerModal().catch(() => {});
      loadVideoJs().catch(() => {});

      loadCastSdk().catch(() => {}); // third-party CDN: warm it, never wait on it
    });
  }

  function showUnwatched() {
    unwatchedCollapsed = false;
    watchedCollapsed = true;
  }

  function showWatched() {
    watchedCollapsed = false;
    unwatchedCollapsed = true;
  }

  // ------------------------------------------------------------------
  // Guard: page only makes sense when the user is logged-in.  When the
  // token disappears (logout) we reset state *and* navigate away to the
  // home page so users don’t interact with a stale wheel.
  // ------------------------------------------------------------------

  $: if (!$authToken) {
    // Clear all derived lists and UI state
    watchList = [];
    anime = [];
    rotation = 0;
    selected = null;

    // If user somehow reached this page while logged-out, kick back home
    if (typeof window !== 'undefined' && window.location.pathname === '/random') {
      history.replaceState({}, '', '/');
      dispatchEvent(new PopStateEvent('popstate'));
    }
  }

  // Fetch list from backend
  async function fetchList() {
    if (!$authToken) {
      watchList = [];
      return;
    }
    const res = await fetch(`/api/list?season=${season}&year=${year}`, {
      headers: { Authorization: `Bearer ${$authToken}` }
    });
    if (res.ok) watchList = await res.json();
  }

  async function fetchAnime() {
    const res = await fetch(`/api/anime?season=${season}&year=${year}`);
    if (res.ok) anime = await res.json();
  }


  const fetchBoth = async () => {
    loading = true;
    try {
      await Promise.all([fetchList(), fetchAnime()]);
    } finally {
      loading = false;
    }
  };

  // Track last fetched year/season to avoid duplicate loads.
  let lastSeasonYearKey: string | null = null;

  // Initial & subsequent fetches.
  $: {
    const key = `${season}-${year}`;
    if (key !== lastSeasonYearKey) {
      lastSeasonYearKey = key;
      // The wheel's slices are about to be replaced, so the transitionend
      // that clears `spinning` never arrives — without this the Spin button
      // keeps pointer-events-none and can never be clicked again.
      spinning = false;
      fetchBoth();
    }
  }

  // ------------------------------------------------------------------
  // Nickname user list fetch & store sync
  // ------------------------------------------------------------------

  onMount(async () => {
    try {
      const res = await fetch('/api/list/users-with-nicknames');
      if (res.ok) {
        let users: string[] = await res.json();

        // Exclude the currently-logged in user from the selectable list so the
        // panel only shows *other* users.  (The active user will always see
        // their own custom names regardless of this filter.)
        const self = get(activeUserName);
        if (self) users = users.filter((u) => u !== self);

        nicknameAllUsers.set(users);
      }
    } catch (err) {
      console.error('Failed to fetch nickname user list', err);
    }
  });

  // Auto-select nickname users who have rankings (any list entry) for the current
  // season/year. Fires on initial mount once the nickname-user list is loaded and
  // again whenever season or year changes. Manual toggles persist only until the
  // next season/year change.
  // Bumped per call; a stale response (from a prior season/year) is discarded
  // when its id no longer matches — prevents rapid season-switch races from
  // applying the wrong season's selection.
  let _autoSelectReqId = 0;
  async function autoSelectByRatings(s: Season, y: number) {
    const nickUsers = get(nicknameAllUsers);
    if (nickUsers.length === 0) return;
    const reqId = ++_autoSelectReqId;
    try {
      const res = await fetch(`/api/list/users-with-ratings?season=${s}&year=${y}`);
      if (reqId !== _autoSelectReqId || !res.ok) return;
      const ratedUsers: string[] = await res.json();
      if (reqId !== _autoSelectReqId) return; // stale response — discard
      const self = get(activeUserName);
      const toSelect = ratedUsers.filter((u) => u !== self && nickUsers.includes(u));
      nicknameSelected.set(new Set(toSelect));
    } catch (err) {
      console.error('Failed to auto-select nickname users by ratings', err);
    }
  }

  $: {
    // Reactive: re-run on season/year change and once nicknameAllUsers populates.
    season;
    year;
    $nicknameAllUsers;
    autoSelectByRatings(season, year);
  }

  // Load custom images from sessionStorage
  onMount(() => {
    if (typeof sessionStorage !== 'undefined') {
      const savedSpinImage = sessionStorage.getItem('wheelSpinButtonImage');
      const savedBgImage = sessionStorage.getItem('wheelBackgroundImage');
      if (savedSpinImage) spinButtonImage = savedSpinImage;
      if (savedBgImage) backgroundImage = savedBgImage;
    }
    imagesLoaded = true; // Mark as loaded so reactive statement can now save changes
  });

  // Persist custom images to sessionStorage when they change (only after initial load)
  $: if (imagesLoaded && typeof sessionStorage !== 'undefined') {
    if (spinButtonImage) sessionStorage.setItem('wheelSpinButtonImage', spinButtonImage);
    else sessionStorage.removeItem('wheelSpinButtonImage');

    if (backgroundImage) sessionStorage.setItem('wheelBackgroundImage', backgroundImage);
    else sessionStorage.removeItem('wheelBackgroundImage');
  }

  // Separate entries into watched/unwatched for easier handling.
  //  * watchedEntries is needed for the ranking sidebar.
  //  * We no longer hide watched shows from the left sidebar – that list now
  //    shows *all* items but greys-out the ones already watched.

  $: watchedEntries = watchList.filter((w) => w.watched);
$: unwatchedEntries = watchList.filter((w) => !w.watched && !w.hidden);

  // Build wheel items with full anime data, but only for entries that have
  // NOT been watched yet so we never spin on already-watched shows.
  $: wheelItems = unwatchedEntries
    .map((w) => {
      const data = anime.find((a) => a.id === w.mediaId);
      return data ? { ...data, customName: w.customName ?? null } : null;
    })
    .filter(Boolean);

  // Warm the availability cache for every wheel item as soon as the
  // list is ready, so the popup's watch row is there instantly instead of
  // popping in ~1s after open. The store dedups + caches per mediaId, so
  // re-runs of this reactive block are no-ops.
  // mediaId → is it in the library (absent = not checked yet). Drives both
  // the popup row and the "Hide Not in Library" button's enabled state.
  let libraryAvailability = new Map<number, boolean>();

  /**
   * Record one availability answer.
   *
   * Deliberately a plain function, not an assignment inside the `$:` block
   * below: Svelte treats a reactive statement that writes one of its own
   * dependencies as needing "extra invalidations", so every single response
   * marked `watchList`/`anime`/`unwatchedEntries`/`wheelItems` dirty and
   * re-ran this block — one full recompute of the wheel pipeline per show.
   */
  function recordAvailability(id: number, available: boolean) {
    if (libraryAvailability.get(id) === available) return;
    libraryAvailability = new Map(libraryAvailability).set(id, available);
  }

  /**
   * Extracted from the reactive block below so the Retry button can call it.
   * Previously the only thing that could trigger a lookup was `wheelItems`
   * changing, so a failed check stayed failed for as long as the page was open
   * — the page had no way back short of a reload.
   */
  function refreshLibraryAvailability() {
    if (!wheelItems.length) return;
    checkAvailabilityMany(
      wheelItems.map((item) => ({
        mediaId: item.id,
        titles: [
          item.customName,
          item.title?.english,
          item.title?.romaji,
          item.title?.native,
        ].filter(Boolean),
        // Unaired entries are answered locally and never sent upstream.
        airing: { status: item.status, startDate: item.startDate },
      }))
    )
      .then((results) => {
        for (const [mediaId, info] of results) {
          // Definite answers only — the unknown/notAired invariant is spelled
          // out on the hide path above.
          if (!info.unknown && !info.notAired) recordAvailability(mediaId, info.available);
        }
      })
      .catch(() => {});
  }

  function retryLibraryCheck() {
    refreshLibraryAvailability();
  }

  $: if (wheelItems.length) refreshLibraryAvailability();

  // Only enabled while there's actually something to hide, so the button
  // greys out once it has done its job (same feel as Hide All / Show All).
  $: hasNonLibraryVisible = unwatchedDetailed.some(
    (it) => !it.hidden && libraryAvailability.get(it.id) === false
  );

  // (Watched ranking is handled separately – see watchedRank below)

  // Detailed list used for the left sidebar.  It now shows *all* shows in the
  // watch list (both watched & unwatched) so users can always see the full
  // season list.
  $: fullDetailed = watchList
    .map((w) => {
      const data = anime.find((a) => a.id === w.mediaId);
      return data
        ? {
            ...data,
            customName: w.customName ?? null,
            watched: w.watched ?? Boolean(w.watchedAt),
            hidden: Boolean(w.hidden)
          }
        : null;
    })
    .filter(Boolean);

  // Filtered list for the sidebar: only items that are still UNwatched.
  $: unwatchedDetailed = fullDetailed.filter((i) => !i.watched);

  // Apply sorting based on user selection
  $: unwatchedSorted = (() => {
    const list = [...unwatchedDetailed]; // Create a copy to avoid mutating original

    if (unwatchedSortMode === 'alphabetical') {
      list.sort((a, b) => {
        const titleA = getDisplayTitle(a).toLowerCase();
        const titleB = getDisplayTitle(b).toLowerCase();
        return titleA.localeCompare(titleB);
      });
    }
    // For 'rank' mode, keep the original order (no sorting needed)

    return list;
  })();

  // Client-side ranking list for watched items.  Initially seeded from
  // watchedDetailed (sorted by watchedAt) and updated whenever the user
  // drags items in the ranking sidebar.
  let watchedRank: any[] = [];

  // Seed watchedRank whenever the underlying watched list changes *and* the
  // rank array does not already include the same set of IDs.  This preserves
  // the user’s manual ordering across reactive re-computations triggered by
  // other state (e.g. title-language switch, rename, etc.).
  $: {
    const ids = watchedEntries.map((w) => w.mediaId);
    const rankIds = watchedRank.map((i) => i.id);
    if (ids.length !== rankIds.length || ids.some((id) => !rankIds.includes(id))) {
      // Build fresh detailed list in default watchedAt order
      const detailed = watchedEntries
        .map((w) => {
          const data = anime.find((a) => a.id === w.mediaId);
          return data
            ? {
                ...data,
                customName: w.customName ?? null,
                watchedAt: w.watchedAt ?? null,
                watched: true,
                watchedRank: w.watchedRank ?? null
              }
            : null;
        })
        .filter(Boolean)
        .sort((a, b) => {
          if (a.watchedRank != null && b.watchedRank != null) return a.watchedRank - b.watchedRank;
          if (a.watchedRank != null) return -1;
          if (b.watchedRank != null) return 1;
          const t1 = a.watchedAt ? new Date(a.watchedAt).getTime() : 0;
          const t2 = b.watchedAt ? new Date(b.watchedAt).getTime() : 0;
          return t1 - t2;
        });

      watchedRank = detailed;
    }
  }

  // Derived values for wheel rendering
import SliceWorker from '../workers/slice-worker?worker';


  import WatchedRankingSidebar from '../components/WatchedRankingSidebar.svelte';
import { onDestroy } from 'svelte';
const sliceWorker: Worker = new SliceWorker();

  // -----------------------------
  // Audio helpers (ping + tick)
  // -----------------------------

  const audioCtx: AudioContext | null = typeof window !== 'undefined'
    ? new (window.AudioContext || (window as any).webkitAudioContext)()
    : null;

  function playTone(frequency: number, duration = 0.1, type: OscillatorType = 'sine', gainLevel = 0.3) {
    if (!audioCtx) return;
    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(frequency, now);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(gainLevel, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    osc.connect(gain).connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + duration + 0.05);
  }

  function playPing() {
    playTone(880, 0.25, 'sine', 0.4);
  }

  function playTick() {
    /*
     * More organic click made from a short burst of white noise passed through
     * a low-pass filter with exponential volume decay.  This avoids the
     * robotic “beep” character of pure oscillators while staying file-less.
     */
    if (!audioCtx) return;

    const duration = 0.07; // seconds

    // Create noise buffer
    const buffer = audioCtx.createBuffer(1, audioCtx.sampleRate * duration, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      // White noise in [-1,1]
      data[i] = Math.random() * 2 - 1;
    }

    // Buffer source
    const source = audioCtx.createBufferSource();
    source.buffer = buffer;

    // Low-pass filter to make it less harsh (cut ~1 kHz)
    const filter = audioCtx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(1000, audioCtx.currentTime);

    // Gain envelope for quick decay
    const gain = audioCtx.createGain();
    const now = audioCtx.currentTime;
    gain.gain.setValueAtTime(0.5, now); // initial volume 50 %
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

    source.connect(filter).connect(gain).connect(audioCtx.destination);
    source.start(now);
    source.stop(now + duration);
  }

  // Quick, soft click played when the user presses the Spin button.
  function playStartClick() {
    if (!audioCtx) return;
    // Simple triangle blip – clearer than filtered noise; very short.
    playTone(500, 0.04, 'triangle', 0.22);
  }

  // ------------------------------------------------------------
  // Celebration helpers (called when wheel stops)
  // ------------------------------------------------------------

  function celebrate() {
    playCelebrationTune();
    launchConfetti();
  }

  function playCelebrationTune() {
    if (!audioCtx) return;

    /*
     * Softer “trumpet-ish” celebration riff:
     *   • Triangle waveform for a brassy but less harsh timbre.
     *   • Gentle low-pass filter sweeps on each note.
     *   • Reduced gain so it sits underneath the UI sounds.
     */

    if (!audioCtx) return;

    const notes = [523.25, 659.25, 783.99, 1046.5]; // C-major arpeggio

    notes.forEach((freq, i) => {
      setTimeout(() => {
        const now = audioCtx.currentTime;

        // Oscillator
        const osc = audioCtx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, now);

        // Low-pass filter to mellow the tone (trumpet-like)
        const filter = audioCtx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(1800, now);
        filter.frequency.linearRampToValueAtTime(1200, now + 0.3);

        // Gain envelope
        const gain = audioCtx.createGain();
        gain.gain.setValueAtTime(0.22, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);

        osc.connect(filter).connect(gain).connect(audioCtx.destination);
        osc.start(now);
        osc.stop(now + 0.45);
      }, i * 200);
    });
  }

  function launchConfetti() {
    if (typeof window === 'undefined') return;

    const canvas = document.createElement('canvas');
    canvas.style.position = 'fixed';
    canvas.style.top = '0';
    canvas.style.left = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.pointerEvents = 'none';
    canvas.style.zIndex = '90';
    document.body.appendChild(canvas);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const confettiCount = 160;
    const confetti: { x: number; y: number; vx: number; vy: number; size: number; color: string; rot: number; vr: number }[] = [];
    const colors = ['#f87171', '#fbbf24', '#34d399', '#60a5fa', '#a78bfa', '#f472b6'];

    for (let i = 0; i < confettiCount; i++) {
      confetti.push({
        // Start near center bottom half so they burst upward from wheel area
        x: canvas.width / 2 + (Math.random() - 0.5) * 120,
        y: canvas.height * 0.6,
        // radial burst velocity upward
        vx: (Math.random() - 0.5) * 6,
        vy: -(Math.random() * 6 + 4),
        size: Math.random() * 6 + 4,
        color: colors[Math.floor(Math.random() * colors.length)],
        rot: Math.random() * 360,
        vr: (Math.random() - 0.5) * 10
      });
    }

    let lastTime = performance.now();
    function draw(now: number) {
      const dt = (now - lastTime) / 16.666; // 60fps units
      lastTime = now;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      confetti.forEach((p) => {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vy += 0.12 * dt; // gravity stronger for longer duration
        p.rot += p.vr * dt;

        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate((p.rot * Math.PI) / 180);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
        ctx.restore();
      });

      animationFrame = requestAnimationFrame(draw);
    }

    let animationFrame = requestAnimationFrame(draw);

    // Clean up after 5 seconds
    setTimeout(() => {
      cancelAnimationFrame(animationFrame);
      canvas.remove();
    }, 5000);
  }

  let sliceAngle = 0;
  let sliceData: { start: number; end: number; color: string }[] = [];

  sliceWorker.onmessage = (ev) => {
    sliceAngle = ev.data.sliceAngle;
    sliceData = ev.data.sliceData;
  };

  // Only recompute slice angles when item COUNT changes — not on name/visibility updates
  let _lastWheelCount = -1;
  $: {
    const count = wheelItems.length;
    if (count !== _lastWheelCount) {
      _lastWheelCount = count;
      sliceWorker.postMessage({ count });
    }
  }

  // radial distance for label (in SVG units, radius is 50)
  const LABEL_R_OUTER = 48; // near rim
  const LABEL_CHAR_LIMIT = 24;

  function spin() {
    if (!wheelItems.length || spinning) return;

    // Drop keyboard focus from whatever was clicked (usually this button) —
    // a still-focused Spin button re-activates on any later Space/Enter
    // press, which reads as the wheel "spinning by itself".
    (document.activeElement as HTMLElement | null)?.blur?.();

    // Ensure AudioContext is resumed (required after user gesture).
    if (audioCtx?.state === 'suspended') {
      audioCtx.resume();
    }

    // Soft initial click on user interaction (after context resumed)
    playStartClick();
    spinning = true;

    let idx = Math.floor(Math.random() * wheelItems.length);
    if (wheelItems.length > 1 && lastSelectedId !== null && wheelItems[idx].id === lastSelectedId) {
      // Re-roll once to avoid immediate repeat.  Second random value guarantees change.
      idx = (idx + 1 + Math.floor(Math.random() * (wheelItems.length - 1))) % wheelItems.length;
    }
    const segAngle = 360 / wheelItems.length;

    const POINTER_OFFSET = 0; // pointer located at 12 o’clock (top-center)

    // Desired angle of selected slice centre relative to pointer
    const targetAngle = (wheelItems.length - idx - 0.5) * segAngle + POINTER_OFFSET;

    // Current wheel angle (0-359)
    const currentAngle = ((rotation % 360) + 360) % 360;
    let delta = targetAngle - currentAngle;
    if (delta <= 0) delta += 360;
    // add at least 720° extra spins every time
    delta += 720;

    if (wheelEl) {
      wheelEl.style.transition = 'none';
      wheelEl.getBoundingClientRect(); // force reflow
      wheelEl.style.transition = 'transform 4s cubic-bezier(.33,.85,.25,1)';
    }

    rotation += delta;
    selected = wheelItems[idx];
    lastSelectedId = selected.id;

    // ------------------------------------------------------------------
    // Schedule tick sounds for every slice the pointer crosses while the
    // wheel is spinning.  We approximate the timing by distributing the
    // ticks evenly across the 4 s CSS transition duration.
    // ------------------------------------------------------------------

    // Number of slice boundaries crossed during rotation
    const ticks = Math.floor(delta / segAngle);
    const durationMs = 4000; // CSS transition duration

    // Limit audible ticks so they don’t become an overwhelming buzz when many
    // slices are present.  We cap to ~25 clicks by skipping evenly.
    const MAX_AUDIBLE_TICKS = 40;
    const skipFactor = Math.max(1, Math.ceil(ticks / MAX_AUDIBLE_TICKS));

    // Inverse of ease-out cubic (matches CSS cubic-bezier curve reasonably well)
    const easeOutCubicInv = (p: number) => 1 - Math.cbrt(1 - p);

    for (let i = 1; i <= ticks; i++) {
      if (i % skipFactor !== 0) continue; // skip excess ticks
      const angleFrac = i / ticks;
      const timeFrac = easeOutCubicInv(angleFrac);
      setTimeout(playTick, timeFrac * durationMs);
    }
  }

  let showModal = false;

// Global key handler (attached while modal is open) so the Enter key triggers
// the same action irrespective of which element currently has focus.
function handleModalKey(e: KeyboardEvent) {
  // While the player is open it owns the keyboard (Space/Esc/[/]) —
  // Enter here would mark-watched and close the modal underneath it, and Escape
  // is how you leave the player, not the pop-up behind it.
  if (showPlayer) return;
  if (pickOpen) {
    // Pick mode owns the keyboard too: Enter is someone typing into the
    // library search, and this window-level handler would mark the show
    // watched and close the pop-up out from under them. Escape leaves the
    // picker rather than the whole pop-up.
    if (e.key === 'Escape') {
      e.preventDefault();
      closePicker();
    }
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    markWatched();
  } else if (e.key === 'Escape') {
    // The pop-up's own overlay carried a keydown handler on a tabindex="-1"
    // div that never received focus, so Escape did nothing. This listener is
    // already window-level and already lifecycle-managed below, so Escape only
    // ever needed to be handled here.
    e.preventDefault();
    showModal = false;
  }
}

// Clean-up in case the component is destroyed while the modal is open
onDestroy(() => {
  window.removeEventListener('keydown', handleModalKey);
});

// Dynamically attach / detach the listener whenever modal visibility changes.
$: {
  if (showModal) {
    window.addEventListener('keydown', handleModalKey);
  } else {
    window.removeEventListener('keydown', handleModalKey);
    // The player lives outside this dialog, so closing the parent has to tear
    // it down explicitly — a stuck `showPlayer` would make handleModalKey
    // swallow Enter for every future popup.
    closePlayer();
  }
}

  /**
   * Mark the currently selected series as watched.
   *
   * 1. Update local state so the UI reflects the change immediately.
   * 2. Notify backend so the change is persisted.
   */
  async function markWatched() {
    if (!selected) return;

    // Close the modal immediately so the UI feels responsive.
    showModal = false;

    // Update local + remote state without blocking the UI. The helper updates
    // local lists synchronously, while the fetch runs in the background.
    toggleWatched(selected.id, true);
  }

  /**
   * Hide the currently selected series from the wheel. This is called from the
   * modal and provides an alternative to marking the series as watched when the
   * user decides they don't want to see it in the randomizer.
   */
  async function hideSelectedSeries() {
    if (!selected) return;

    // Find the corresponding entry in unwatchedDetailed that has the full structure
    // including the hidden property that toggleHide expects
    const entry = unwatchedDetailed.find((item) => item.id === selected.id);

    if (entry) {
      // Close modal immediately for responsive UI
      showModal = false;

      // Call existing toggleHide which handles optimistic update + API call
      toggleHide(entry);
    }
  }

  function handleSpinImageFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (evt) => {
      spinButtonImage = evt.target?.result as string;
    };
    reader.readAsDataURL(file);
  }

  function handleBackgroundImageFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (evt) => {
      backgroundImage = evt.target?.result as string;
    };
    reader.readAsDataURL(file);
  }

  function handleSpinImageDrop(e: DragEvent) {
    e.preventDefault();
    const target = e.currentTarget as HTMLElement;
    target.classList.remove('border-primary');

    const file = e.dataTransfer?.files?.[0];
    if (!file || !file.type.startsWith('image/')) return;

    const reader = new FileReader();
    reader.onload = (evt) => {
      spinButtonImage = evt.target?.result as string;
    };
    reader.readAsDataURL(file);
  }

  function handleBackgroundImageDrop(e: DragEvent) {
    e.preventDefault();
    const target = e.currentTarget as HTMLElement;
    target.classList.remove('border-primary');

    const file = e.dataTransfer?.files?.[0];
    if (!file || !file.type.startsWith('image/')) return;

    const reader = new FileReader();
    reader.onload = (evt) => {
      backgroundImage = evt.target?.result as string;
    };
    reader.readAsDataURL(file);
  }

  /** Toggle watched flag for a given mediaId */
  async function toggleWatched(id: number, watched: boolean) {
    if (watched) {
      const addToTop = $options.addWatchedTo === 'TOP';

      if (addToTop) {
        // Mark as watched: set new item to rank 0, increment all others
        watchList = watchList.map((w) =>
          w.mediaId === id
            ? {
                ...w,
                watched,
                watchedAt: new Date().toISOString(),
                watchedRank: 0  // New items go to top (rank 0)
              }
            : w.watched
            ? { ...w, watchedRank: w.watchedRank != null ? w.watchedRank + 1 : null }  // Increment existing ranks
            : w
        );
      } else {
        // Mark as watched: add to bottom with highest rank
        const maxRank = Math.max(-1, ...watchList.filter(w => w.watched).map(w => w.watchedRank ?? -1));
        watchList = watchList.map((w) =>
          w.mediaId === id
            ? {
                ...w,
                watched,
                watchedAt: new Date().toISOString(),
                watchedRank: maxRank + 1  // New items go to bottom
              }
            : w
        );
      }
    } else {
      // Mark as unwatched: remove from watched and renormalize all ranks
      watchList = watchList.map((w) =>
        w.mediaId === id
          ? { ...w, watched: false, watchedAt: null, watchedRank: null }
          : w
      );

      // Renormalize ranks after removal
      const remainingWatched = watchList
        .filter((w) => w.watched)
        .sort((a, b) => (a.watchedRank ?? 0) - (b.watchedRank ?? 0));

      watchList = watchList.map((w) => {
        if (!w.watched) return w;
        const newRank = remainingWatched.findIndex((rw) => rw.mediaId === w.mediaId);
        return { ...w, watchedRank: newRank };
      });
    }

    // Keep the watchedRank sidebar in sync immediately so the user sees the
    // new entry without waiting for the reactive regeneration to kick in.
    if (watched) {
      // Avoid duplicates in case the item is already present.
      if (!watchedRank.some((it) => it.id === id)) {
        const data = anime.find((a) => a.id === id);
        const entry = watchList.find((w) => w.mediaId === id);
        if (data && entry) {
          const addToTop = $options.addWatchedTo === 'TOP';

          if (addToTop) {
            // Add new item at the beginning and update all ranks
            watchedRank = [
              {
                ...data,
                customName: entry.customName ?? null,
                watched: true,
                watchedAt: entry.watchedAt ?? null,
                watchedRank: 0
              },
              ...watchedRank.map((item) => ({
                ...item,
                watchedRank: (item.watchedRank ?? 0) + 1
              }))
            ];
          } else {
            // Add new item at the end
            watchedRank = [
              ...watchedRank,
              {
                ...data,
                customName: entry.customName ?? null,
                watched: true,
                watchedAt: entry.watchedAt ?? null,
                watchedRank: watchedRank.length
              }
            ];
          }
        }
      }
    } else {
      // Remove from local ranking list when un-watched and renormalize ranks
      watchedRank = watchedRank
        .filter((it) => it.id !== id)
        .map((item, index) => ({
          ...item,
          watchedRank: index
        }));
    }

    if ($authToken) {
      try {
        await fetch('/api/list/watched', {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${$authToken}`
          },
          body: JSON.stringify({ season, year, mediaId: id, watched })
        });

        // Persist the full watched-rank ordering too. /watched alone always
        // stores the new row at the bottom server-side, which would discard the
        // TOP placement (and the renormalized order after an unwatch) the user
        // just saw. Mirrors the drag handler's rank PATCH.
        const idOrder = watchedRank.map((it) => it.id);
        if (idOrder.length) {
          await fetch('/api/list/rank', {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${$authToken}`
            },
            body: JSON.stringify({ season, year, ids: idOrder })
          });
        }
      } catch (err) {
        console.error('Failed to update watched flag', err);
      }
    }
  }

  // Helper to build SVG arc path
  function polar(cx: number, cy: number, r: number, ang: number) {
    const rad = (ang - 90) * (Math.PI / 180);
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  }

  function arcPath(cx: number, cy: number, r: number, start: number, sweep: number): string {
    const startPt = polar(cx, cy, r, start);
    const endPt = polar(cx, cy, r, start + sweep);
    const large = sweep > 180 ? 1 : 0;
    return `M ${cx} ${cy} L ${startPt.x} ${startPt.y} A ${r} ${r} 0 ${large} 1 ${endPt.x} ${endPt.y} Z`;
  }

  function getDisplayTitle(item: any): string {
    if (item.customName) return item.customName;
    const lang = $options.titleLanguage;
    if (lang === 'ROMAJI') return item.title?.romaji || item.title?.english || item.title?.native || '';
    if (lang === 'NATIVE') return item.title?.native || item.title?.english || item.title?.romaji || '';
    return item.title?.english || item.title?.romaji || item.title?.native || '';
  }
  // Like getDisplayTitle, but ignores any customName.
  function getBaseTitle(item: any): string {
    const lang = $options.titleLanguage;
    if (lang === 'ROMAJI') return item.title?.romaji || item.title?.english || item.title?.native || '';
    if (lang === 'NATIVE') return item.title?.native || item.title?.english || item.title?.romaji || '';
    return item.title?.english || item.title?.romaji || item.title?.native || '';
  }
  // For modal display — ignores the user's title-language preference.
  function getEnglishTitle(item: any): string {
    return item.title?.english || item.title?.romaji || item.title?.native || '';
  }
  // For modal display — ignores the user's title-language preference.
  function getRomajiTitle(item: any): string {
    return item.title?.romaji || item.title?.english || item.title?.native || '';
  }
  function normalizeTitle(title: string): string {
    return title.toLowerCase().replace(/[\s\W_]+/g, '');
  }
  function titlesAreSame(item: any): boolean {
    const english = normalizeTitle(getEnglishTitle(item));
    const romaji = normalizeTitle(getRomajiTitle(item));
    return english === romaji;
  }
  function shortTitle(item: any): string {
    const title = getDisplayTitle(item);
    return title.length > LABEL_CHAR_LIMIT ? title.slice(0, LABEL_CHAR_LIMIT - 1) + '…' : title;
}


</script>

<main class="pb-0 flex flex-col gap-8">
  <!-- Controls aligned to header (matches the width pattern on Home and Compare) -->
  <div class="w-full sm:max-w-[calc(100vw-32rem)] 2cols:sm:max-w-[calc(100vw-40rem)] sm:mx-auto">
    <SeasonSelect
      bind:season
      bind:year
      showListToggle={false}
      showSequelToggle={false}
      hideSequels={false}
      hideInList={false}
      showSearch={false}
    />
  </div>

  <!-- Container: wheel grows to fill remaining space -->
  <div class="relative w-full flex justify-center items-center overflow-visible flex-1" style="min-height: min(95vmin, calc(100dvh - 195px));">
    <div class="flex flex-col items-center mx-auto">
      {#if loading}
        <LoadingSpinner size="lg" />
      {:else if !wheelItems.length}
        <div class="mt-24 text-center opacity-70">My List for this season is empty.</div>
      {:else}
        <!-- Background image (spans from unwatched list to nicknames panel) -->
        {#if backgroundImage}
          <div
            class="absolute lg:left-[calc(16rem+7px)] 3cols:lg:left-[calc(20rem+7px)] lg:right-[calc(21rem+7px)]"
            style="
              height: min(95vmin, calc(100dvh - 195px));
              background-image: url({backgroundImage});
              background-size: cover;
              background-position: center;
              z-index: 0;
            "
          ></div>
        {/if}

        <!-- Wheel -->
        <div
          id="wheel-wrapper"
          class="relative mx-auto overflow-visible select-none"
          style="
            /* 52 header + 72 selector + 52 extra + 19 buffer → 195px total */
            width: min(95vmin, calc(100dvh - 195px));
            height: min(95vmin, calc(100dvh - 195px));
            margin-bottom: 5px; /* keep a sliver of space below wheel */
            z-index: 1;
          "
        >
          <!-- Clipped wheel -->
          <div class="overflow-hidden rounded-full w-full h-full">
        <svg
          bind:this={wheelEl}
          viewBox="-50 -50 100 100"
          style="width:100%;height:100%;will-change:transform;backface-visibility:hidden;transform:translateZ(0) rotate({rotation}deg);"
          class="transition-transform pointer-events-none"
        on:transitionend={() => {
          if (spinning) {
            spinning = false;
            celebrate();
            // Slight delay before showing modal so confetti is visible underneath
            setTimeout(() => (showModal = true), 50);
          }
        }}
      >
        <!-- draw slices -->
        {#each sliceData as s}
          <g transform="rotate({s.start})">
            <path d={arcPath(0, 0, 50, 0, sliceAngle)} fill={s.color} />
          </g>
        {/each}

        <!-- draw labels on top -->
        {#each wheelItems as item, i (item.id)}
          {#key $options.titleLanguage + '-' + item.id}
          <!-- rotate label to centre of slice.
               Polar helper uses 0° at 12 o’clock, but CSS/SVG rotate() uses 0° at 3 o’clock → offset -90° -->
          <g transform={`rotate(${sliceAngle * i + sliceAngle / 2 - 90})`}>
            <text
              fill="white"
              font-size="2.5"
              text-anchor="start"
              alignment-baseline="middle"
              transform={`rotate(180) translate(-${LABEL_R_OUTER},0)`}
              style="pointer-events:none;user-select:none;-webkit-user-select:none;stroke:#000;stroke-width:.25;paint-order:stroke;white-space:pre;">
              {shortTitle(item)}
            </text>
          </g>
          {/key}
        {/each}
        </svg>
      </div>


      <!-- Central Spin button -->
      <button
        class={`spin-button group btn btn-primary btn-circle active:shadow-inner active:scale-95 transition-transform duration-75 absolute inset-0 m-auto w-28 h-28 md:w-36 md:h-36 shadow-lg flex items-center justify-center text-2xl select-none ${spinning ? 'pointer-events-none opacity-75' : ''} ${spinButtonImage ? 'has-image' : ''}`}
        on:click={spin}
        style="z-index: 10; {spinButtonImage ? `--button-bg-image: url(${spinButtonImage});` : ''}"
      >
        {#if !spinButtonImage}Spin{/if}

        <!-- Upward pointer protruding from top half of button -->
        <svg
          class={`absolute left-1/2 top-0 -translate-x-1/2 -translate-y-2/3 w-12 h-12 md:w-16 md:h-16 pointer-events-none ${spinning ? 'opacity-75' : ''}`}
          style="z-index: -1;"
          viewBox="0 0 24 30"
        >
          {#if spinButtonImage}
            <defs>
              <pattern id="triangleImagePattern" x="0" y="0" width="100%" height="100%" patternUnits="userSpaceOnUse">
                <image href={spinButtonImage} x="0" y="0" width="24" height="30" preserveAspectRatio="xMidYMid slice" />
              </pattern>
            </defs>
            <path d="M12 0 L22 28 H2 Z" fill="url(#triangleImagePattern)" />
          {:else}
            <path d="M12 0 L22 28 H2 Z" fill="currentColor" class="text-primary" />
          {/if}
        </svg>
      </button>
    </div>
  {/if}
    
  </div> <!-- end wheel column -->

    <!-- Unwatched list sidebar -->
    <aside
      class="fixed z-40 top-0 bottom-0 left-0 bg-base-200 pr-4 pl-4 py-3 shadow-lg flex flex-col w-full max-w-[20rem] lg:absolute lg:mt-0 lg:w-64 3cols:lg:w-80 transform transition-transform duration-300 overflow-hidden lg:translate-x-0"
      class:-translate-x-full={unwatchedCollapsed}
      style="max-height: calc(100dvh - 0px);"
    >
      {#if unwatchedDetailed.length}
        <div class="mb-4 pr-2">
          <!-- Row 1: Title and Sort -->
          <div class="flex items-center justify-between mb-2">
            <h3 class="text-lg font-bold text-center md:text-left">Unwatched</h3>

            <!-- Hide tab (mobile only) -->
            <button
              class="lg:hidden absolute right-0 top-1/2 -translate-y-1/2 bg-base-200 rounded-r px-1 py-6 shadow flex items-center justify-center z-50"
              style="width: 1.25rem;"
              aria-label="Hide Unwatched list"
              on:click={() => (unwatchedCollapsed = true)}
            >
              <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <!-- Chevron pointing left (<) -->
                <path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
            </button>

            <!-- Sort dropdown -->
            {#if $authToken}
              <select bind:value={unwatchedSortMode} class="select select-xs">
                <option value="rank">Rank</option>
                <option value="alphabetical">A-Z</option>
              </select>
            {/if}
          </div>

          <!-- Row 2: Hide/Show All buttons -->
          {#if $authToken}
            <div class="flex items-center gap-2">
              <button
                type="button"
                class="btn btn-xs btn-outline normal-case filter brightness-75 hover:brightness-100"
                on:click={hideAll}
                disabled={!hasVisible}
              >
                Hide All
              </button>
              <button
                type="button"
                class="btn btn-xs btn-outline normal-case filter brightness-75 hover:brightness-100"
                on:click={showAll}
                disabled={!hasHidden}
              >
                Show All
              </button>
              {#if $mediaConfigured}
                <button
                  type="button"
                  class="btn btn-xs btn-outline normal-case filter brightness-75 hover:brightness-100"
                  on:click={hideNotInLibrary}
                  disabled={!hasNonLibraryVisible || hidingNonLibrary}
                  title={$libraryStatus === 'unreachable'
                    ? "Can't reach the media server, so nothing is known to be missing"
                    : $libraryStatus === 'checking'
                    ? 'Still checking which shows the library has…'
                    : hasNonLibraryVisible
                    ? "Hide every unwatched show the library doesn't have (confirmed matches only)"
                    : 'Nothing to hide — every unwatched show is in the library'}
                >
                  {#if hidingNonLibrary}<span class="loading loading-spinner loading-xs"></span>{/if}
                  Hide Not in Library
                </button>

                <!-- Which kind of nothing this is. A disabled button looks the
                     same whether every show is present or the lookup never
                     answered, and those were indistinguishable on screen — the
                     reason a real outage read as normal operation. -->
                {#if hideWriteError}
                  <span class="text-xs text-error" data-hide-write-error>{hideWriteError}</span>
                {/if}
                {#if $libraryStatus === 'checking'}
                  <span class="text-xs opacity-60 flex items-center gap-1" data-library-status="checking">
                    <span class="loading loading-spinner loading-xs"></span>
                    Checking your library…
                  </span>
                {:else if $libraryStatus === 'unreachable'}
                  <span class="text-xs text-warning flex items-center gap-2" data-library-status="unreachable">
                    Can't reach the media server
                    <button type="button" class="btn btn-xs btn-outline normal-case" on:click={retryLibraryCheck}>
                      Retry
                    </button>
                  </span>
                {/if}
              {/if}
            </div>
          {/if}
        </div>
        <ul class="flex-1 overflow-y-auto flex flex-col gap-3 pr-1">
          {#each unwatchedSorted as item (item.id)}
            <!-- svelte-ignore a11y-no-noninteractive-element-to-interactive-role -->
            <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
            <li
              class={`flex items-center gap-3 group transition rounded p-1 ${
                item.watched
                  ? 'opacity-40 pointer-events-none'
                  : item.hidden
                  ? 'opacity-40'
                  : 'cursor-pointer hover:bg-primary/20 hover:shadow-md'
              }`}
              role="button"
              tabindex={item.watched || item.hidden ? -1 : 0}
              on:click={() => {
                if (!item.watched && !item.hidden) {
                  selected = item;
                  showModal = true;
                }
              }}
              on:keydown={(e) => {
                if ((e.key === 'Enter' || e.key === ' ') && !item.watched && !item.hidden) {
                  e.preventDefault();
                  selected = item;
                  showModal = true;
                }
              }}
            >
              <img
                src={item.coverImage?.small ?? item.coverImage?.medium ?? item.coverImage?.large}
                alt=""
                class="w-12 h-16 object-cover rounded shrink-0"
                loading="lazy"
              />

              {#key $options.titleLanguage + '-' + item.id}
                <span
                  class="text-sm flex-1 whitespace-normal break-words force-wrap"
                  title={getDisplayTitle(item)}
                  data-lang={$options.titleLanguage}
                  >{item.customName || getDisplayTitle(item)}</span
                >
              {/key}

              <!-- Eye toggle -->
              <button
                type="button"
                title={item.hidden ? 'Show in Randomize' : 'Hide from Randomize'}
                class={`shrink-0 ml-auto mr-2 relative p-4 -m-3 rounded-full hover:bg-base-300 transition \
                  ${item.hidden ? '' : 'opacity-0 group-hover:opacity-100'}`}
                on:click|stopPropagation={() => toggleHide(item)}
              >
                {#if item.hidden}
                  <!-- Closed eye (red) -->
                  <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5 text-error" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.418 0-8.19-2.865-9.543-7  .563-1.792 1.597-3.365 2.929-4.582M6.24 6.24c1.843-1.207 4.034-1.957 6.498-1.957 4.418 0 8.19 2.865 9.543 7-.27.859-.607 1.686-1.005 2.472M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    <path stroke-linecap="round" stroke-linejoin="round" d="M3 3l18 18" />
                  </svg>
                {:else}
                  <!-- Open eye -->
                  <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5s8.268 2.943 9.542 7c-1.274 4.057-5.065 7-9.542 7S3.732 16.057 2.458 12z" />
                    <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                {/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </aside>

    {#if unwatchedCollapsed}
      <!-- Restore tab for Unwatched list (mobile only) -->
      <button
        class="lg:hidden fixed z-50 left-0 top-1/2 -translate-y-1/2 bg-base-200 rounded-l px-1 py-6 shadow flex items-center justify-center"
        style="width: 1.25rem;"
        aria-label="Show Unwatched list"
        on:click={showUnwatched}
      >
        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <!-- Chevron pointing left (<) -->
          <!-- Chevron pointing right (>) -->
          <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </button>
    {/if}

    <!-- Watched ranking sidebar container -->
    <div
      class="fixed z-40 top-0 bottom-0 right-0 bg-base-200 pl-4 pr-3 py-3 shadow-lg flex flex-col w-full max-w-[20rem] lg:absolute lg:top-0 lg:bottom-0 lg:mt-0 lg:right-4 lg:w-80 transform transition-transform duration-300 overflow-hidden lg:translate-x-0"
      class:translate-x-full={watchedCollapsed}
    >
      <!-- Hide tab (mobile only) -->
      <button
        class="lg:hidden absolute left-0 top-1/2 -translate-y-1/2 bg-base-200 rounded-l px-1 py-6 shadow flex items-center justify-center z-50"
        style="width: 1.25rem;"
        aria-label="Hide Watched list"
        on:click={() => (watchedCollapsed = true)}
      >
        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <!-- Chevron pointing right (>) -->
          <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </button>

      <div class="flex-1 min-h-0 overflow-hidden pr-1">
        <WatchedRankingSidebar
          list={watchedRank}
      on:update={(e) => {
        // e.detail is an ordered array of anime IDs
        const idOrder = e.detail;
        // Reorder watchedRank to reflect emitted order
        watchedRank = idOrder.map((id) => watchedRank.find((it) => it.id === id)).filter(Boolean);

        // ------------------------------------------------------------------
        // Keep the primary watchList array in sync with the new ranking so
        // future reactive computations (e.g. after marking another show as
        // watched) preserve the user-defined order instead of falling back to
        // the default list ordering.
        // ------------------------------------------------------------------

        watchList = watchList.map((entry) => {
          const idx = idOrder.indexOf(entry.mediaId);
          // Only update rank for entries that are part of the watched list.
          return idx !== -1 ? { ...entry, watchedRank: idx } : entry;
        });

        // Persist watched ranking via dedicated endpoint
        if ($authToken) {
          fetch('/api/list/rank', {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${$authToken}`
            },
            body: JSON.stringify({ season, year, ids: idOrder })
          });
        }
      }}
          on:unwatch={(e) => toggleWatched(e.detail, false)}
          on:view={(e) => {
            // Double-click on watched item opens modal
            selected = e.detail;
            showModal = true;
          }}
        />
      </div>
    </div>

    {#if watchedCollapsed}
      <!-- Restore tab for Watched list -->
      <button
        class="lg:hidden fixed z-50 right-0 top-1/2 -translate-y-1/2 bg-base-200 rounded-r px-1 py-6 shadow flex items-center justify-center"
        style="width: 1.25rem;"
        aria-label="Show Watched list"
        on:click={showWatched}
      >
        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <!-- Chevron pointing left (<) -->
          <path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
      </button>
    {/if}

    <!-- Nickname user picker panel (aligned with Watched sidebar) -->
    <div class="absolute top-0 mt-0 w-52 max-h-[80vh] overflow-y-auto bg-base-200/90 rounded-lg shadow-lg p-3 text-sm space-y-1 z-30 hidden lg:block right-[calc(21rem+7px)]">
      <!-- Add watched position preference -->
      <div class="mb-4 pb-3 border-b border-base-300">
        <h3 class="font-semibold mb-2">Add Watched to:</h3>
        <div class="flex flex-row gap-3">
          <label class="flex items-center gap-1 cursor-pointer">
            <input
              type="radio"
              class="radio radio-xs"
              name="addWatchedPosition"
              value="TOP"
              bind:group={$options.addWatchedTo}
            />
            Top
          </label>
          <label class="flex items-center gap-1 cursor-pointer">
            <input
              type="radio"
              class="radio radio-xs"
              name="addWatchedPosition"
              value="BOTTOM"
              bind:group={$options.addWatchedTo}
            />
            Bottom
          </label>
        </div>
      </div>

      <h3 class="font-semibold mb-2">Nicknames from:</h3>

      {#if $nicknameAllUsers.length}
        {#each $nicknameAllUsers as user}
          <label class="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              class="checkbox checkbox-xs"
              checked={$nicknameSelected.has(user)}
              on:change={() => toggleNicknameUser(user)}
            />
            {user}
          </label>
        {/each}
      {:else}
        <p class="italic opacity-60">No other users yet</p>
      {/if}
    </div>
  </div> <!-- end flex container -->

  {#if showModal && selected}
    <dialog open class="modal">
      <div class="modal-box w-full max-w-3xl">
        <button class="btn btn-sm btn-circle btn-ghost absolute right-2 top-2" on:click={() => (showModal = false)}>✕</button>

        <!-- Main title: custom name if exists, otherwise English title -->
        <h3 class="font-bold text-lg mb-1">
          {selected.customName || getEnglishTitle(selected)}
          {#if myRank != null}
            <span class="text-base font-normal opacity-70">(#{myRank})</span>
          {/if}
        </h3>

        <!-- Always show English title below (non-bold) -->
        <p class="mb-1 text-base text-base-content/70">
          {getEnglishTitle(selected)}
        </p>

        {#if pickOpen}
          <!-- Pick mode REPLACES the pop-up body rather than floating over it.
               `.modal-box` is itself a scroll container, so a dropdown inside
               it produced two competing scrollbars, clipped the results, and
               pushed Mark as Watched out of reach. Here the results list owns
               the only scrollbar and it is bounded, so a long list scrolls in
               place instead of running off the page. -->
          <div class="flex gap-4 mt-3" data-pick-dropdown role="group"
            aria-label="Pick the right show from your library">
            <!-- The AniList cover STAYS on screen: matching is a comparison,
                 and hiding the thing being matched made it guesswork. -->
            <img class="w-28 shrink-0 self-start rounded hidden sm:block"
              src={selected.coverImage?.large ?? selected.coverImage?.medium}
              alt={getDisplayTitle(selected)} />
            <div class="flex flex-col gap-2 flex-1 min-w-0">
            <p class="text-sm opacity-70">
              Which show in your library is this? Your pick is used for everyone,
              and flagged for the admin to confirm.
            </p>
            <!-- What it resolves to RIGHT NOW. Without this the list is a set
                 of options with no indication which one is live, so there is
                 no way to tell a correction from a no-op. -->
            <p class="text-sm" data-pick-current>
              {#if watchInfo?.libraryTitle}
                Currently matched to <span class="font-semibold">{watchInfo.libraryTitle}</span>
                {#if watchInfo.matchedBy === 'title'}<span class="opacity-60">(by title, unverified)</span>{/if}
              {:else}
                <span class="opacity-70">Not matched to anything in your library yet.</span>
              {/if}
            </p>
            <!-- svelte-ignore a11y-autofocus -->
            <input class="input input-bordered input-sm w-full" data-pick-input autofocus
              placeholder="Search your library…" bind:value={pickTerm}
              on:input={queuePickSearch} />
            {#if pickError}
              <p class="text-sm text-warning" data-pick-error>{pickError}</p>
            {/if}
            <ul class="h-72 overflow-y-auto flex flex-col gap-0.5 border border-base-300 rounded p-1"
              data-pick-results>
              {#each pickResults as opt (opt.itemId)}
                <li>
                  <button type="button" disabled={pickBusy}
                    class="w-full text-left flex gap-2 items-center px-2 py-1 rounded hover:bg-base-200 disabled:opacity-50"
                    class:bg-base-200={opt.itemId === watchInfo?.seriesId}
                    on:click={() => pickLibraryItem(opt)}>
                    <!-- Proxied: <img> can't send a bearer header, so the
                         token rides the query like the stream/subtitle
                         proxies. A missing poster 404s and just shows blank. -->
                    <img class="w-8 h-12 object-cover rounded bg-base-300 shrink-0" alt=""
                      loading="lazy"
                      src={`/api/jellyfin/library/image/${opt.itemId}?token=${encodeURIComponent($authToken ?? '')}`} />
                    <span class="flex-1 min-w-0 break-words">{pickLabel(opt)}</span>
                    {#if opt.itemId === watchInfo?.seriesId}
                      <span class="badge badge-sm badge-ghost shrink-0" data-pick-current-option>current</span>
                    {/if}
                    <span class="text-xs opacity-50 shrink-0">{opt.kind === 'movie' ? 'film' : 'series'}</span>
                  </button>
                </li>
              {:else}
                <li class="opacity-60 p-2 text-sm">
                  {#if pickBusy}
                    Searching…
                  {:else if pickTerm.trim()}
                    <!-- "Nothing matched" reads as a broken search. Name the
                         term and the honest reason: the library really may not
                         have it, and no amount of retyping will change that. -->
                    No match for “{pickTerm.trim()}” in your library — try a
                    shorter word, or the show may simply not be there yet.
                  {:else}
                    Type part of a title to search your library.
                  {/if}
                </li>
              {/each}
            </ul>
            <div class="flex justify-between items-center gap-2">
              <!-- Reversible by design: a pick a viewer can't undo is worse
                   than no pick. Always offered — "put it back" is a valid
                   answer even when nothing here looks right. -->
              <button class="btn btn-sm btn-outline btn-warning normal-case" data-pick-clear
                disabled={pickBusy} on:click={clearPick}>
                Reset to the automatic match
              </button>
              <div class="flex items-center gap-2">
                {#if pickBusy}<span class="loading loading-spinner loading-xs"></span>{/if}
                <button class="btn btn-sm btn-outline normal-case" data-pick-cancel on:click={closePicker}>
                  Cancel
                </button>
              </div>
            </div>
            </div>
          </div>
        {:else}

        <!-- Only show Romaji title if different from English (non-bold) -->
        {#if !titlesAreSame(selected)}
          <p class="mb-4 text-base text-base-content/70">
            {getRomajiTitle(selected)}
          </p>
        {:else}
          <div class="mb-4"></div>
        {/if}

        {#if nicknameList.length}
          <div class="mb-6">
            <h4 class="font-semibold mb-1 text-sm">Other users' nicknames:</h4>
            <ul class="list-disc list-inside space-y-1 text-sm">
              {#each nicknameList.filter(n => $nicknameSelected.has(n.userName) && n.userName !== $activeUserName) as n}
                <li>
                  <span class="font-medium">{n.userName}</span>:
                  {#if n.nickname}
                    {` ${n.nickname}`} {#if n.rank != null}(<span class="opacity-70">#{n.rank}</span>){/if}
                  {:else}
                    {#if n.rank != null}
                      (<span class="opacity-70">#{n.rank}</span>)
                    {/if}
                  {/if}
                </li>
              {:else}
                <li class="italic opacity-60">None selected</li>
              {/each}
            </ul>
          </div>
        {/if}
        <img src={selected.coverImage?.extraLarge ?? selected.coverImage?.large ?? selected.coverImage?.medium} alt={getDisplayTitle(selected)} class="w-56 mx-auto mb-6" />
        {#if watchInfo?.available}
          <div class="flex flex-col items-center gap-1 mb-4">
            <!-- The player chunk is heavy (weight on `warmPlayerAssets`), so on
                 anything but localhost there is a real gap between the click
                 and the modal. Without this the button looks broken. -->
            <button
              class="btn btn-sm btn-accent"
              class:btn-disabled={openingPlayer}
              on:click={openPlayer}
            >
              {#if openingPlayer}
                <span class="loading loading-spinner loading-xs"></span>
                Opening…
              {:else}
                ▶ Watch here (via Jellyfin)
              {/if}
              {#if watchInfo.seasonNumber != null && watchInfo.episodeNumber != null}
                — S{watchInfo.seasonNumber}E{watchInfo.episodeNumber}
              {/if}
            </button>
            {#if watchInfo.libraryTitle}
              <!-- Everything here is the library's own metadata for the episode we
                   resolved, so a wrong match or wrong season is visible
                   before you click play. -->
              <span class="text-xs opacity-60">
                Library: {watchInfo.libraryTitle}
                {#if watchInfo.seasonNumber != null && watchInfo.episodeNumber != null}
                  · S{watchInfo.seasonNumber}E{watchInfo.episodeNumber}
                {/if}
                {#if watchInfo.episodeTitle}
                  · {watchInfo.episodeTitle}
                {/if}
              </span>
              {#if (watchInfo.matchedBy === 'title' && watchInfo.titleTier !== 0) || watchInfo.unverified}
                <!-- Matched on a *partial* title, with no id to confirm it. That
                     is how a 2026 entry once resolved to a 2004 series of
                     similar name ("Firefly Wedding" → "Firefly"), so say so
                     rather than present it as fact.
                     Tier 0 — a normalised exact title — is deliberately not
                     warned about. It used to be, which meant the common and
                     entirely correct case ("Mebius Dust" → "Mebius Dust", whose
                     only sin is that the community AniList→TVDB map hasn't
                     caught up with a three-week-old show) carried the same
                     warning as the genuinely dangerous prefix hits. A warning
                     that fires on the ordinary case is a warning nobody reads. -->
                <span
                  class="text-xs text-warning/80"
                  title={watchInfo.unverified
                    ? 'Matched by an id we looked up ourselves rather than one from the community map, and nobody has confirmed it yet. Check the title above is really the show you meant.'
                    : 'Matched on a partial title, and no AniList/TVDB id links this entry to that series. Check the title above is really the show you meant.'}
                >
                  ⚠ unconfirmed match
                </span>
              {/if}
            {/if}
          </div>
        {:else if $mediaConfigured && watchInfo?.unknown}
          <p class="text-center text-xs opacity-50 mb-4">Couldn't reach the media server — try again shortly</p>
        {:else if $mediaConfigured && watchInfo?.notAired}
          <!-- Never looked up: an unaired series can't be in the library, and
               asking only ever produced false positives. -->
          <p class="text-center text-xs opacity-50 mb-4" data-not-aired>Not aired yet</p>
        {:else if $mediaConfigured && watchInfo && !watchInfo.available}
          <p class="text-center text-xs opacity-50 mb-4">
            Not in library{watchInfo.libraryTitle
              ? ` (found "${watchInfo.libraryTitle}" but not this season)`
              : ''}
          </p>
        {/if}
        {#if $mediaConfigured && $authToken && watchInfo && !watchInfo.unknown && !watchInfo.notAired && !watchInfo.idConfident}
          <!-- Offered only when the identity is UNCERTAIN — a resolver guess or
               a title match. A community-map id, a human decision or a manual
               override needs no correcting, and that holds even when we don't
               hold the show: the question is "do we know what this is", not
               "can you watch it". The correction belongs where the mistake is
               seen: a pick is
               remembered for everyone and queued for admin review, so one
               viewer fixing it fixes it for the next. Hidden from guests —
               the write needs a token, and a control that 401s is worse than
               no control. Opening it swaps the pop-up into pick mode rather
               than dropping a menu inside it; `.modal-box` scrolls its own
               overflow, so an absolutely-positioned panel fought that scroll
               and pushed the action buttons out of reach. -->
          <div class="flex justify-center mb-4">
            <button class="btn btn-sm btn-outline normal-case" data-pick-open
              on:click={openPicker}>
              {watchInfo.available ? 'Not the right show?' : 'Find it in my library'}
            </button>
          </div>
        {/if}
        <div class="modal-action relative flex justify-center">
          {#if selected.watched || watchList.find(w => w.mediaId === selected.id)?.watched}
            <!-- Watched series: only show unwatch button (same pink color as Hide Series) -->
            <button class="btn btn-secondary" on:click={() => { showModal = false; toggleWatched(selected.id, false); }}>
              Mark as Unwatched
            </button>
          {:else}
            <!-- Unwatched series: show hide and watch buttons -->
            <button class="btn btn-secondary absolute left-0" on:click={hideSelectedSeries}>
              <span class="flex flex-col items-center leading-tight">
                <span>Hide Series</span>
                <span class="text-xs opacity-70">(Unwatched)</span>
              </span>
            </button>
            <button class="btn btn-primary" on:click={markWatched}>Mark as watched</button>
          {/if}
        </div>
        {/if}
      </div>
    </dialog>
  {/if}

  <!-- In-page player (lazy-loaded chunk; stacks above the show modal) -->
  {#if showPlayer && watchInfo?.itemId && watchInfo?.mediaSourceId && selected}
    <svelte:component
      this={JellyfinPlayerModal}
      itemId={watchInfo.itemId}
      mediaSourceId={watchInfo.mediaSourceId}
      title={selected.customName || getEnglishTitle(selected)}
      episodeTitle={watchInfo.episodeTitle ?? ''}
      on:close={closePlayer}
    />
  {/if}

  <!-- Image Upload Modal -->
  {#if showImageUploadModal}
    <dialog open class="modal">
      <div class="modal-box w-full max-w-2xl">
        <button class="btn btn-sm btn-circle btn-ghost absolute right-2 top-2"
                on:click={() => showImageUploadModal = false}>✕</button>

        <h3 class="font-bold text-lg mb-4">Upload Custom Images</h3>

        <!-- Spin Button Image Section -->
        <div class="mb-6">
          <h4 class="font-semibold mb-2">Spin Button Image</h4>
          <div class="flex flex-col gap-2">
            {#if spinButtonImage}
              <div class="relative w-32 h-32 mx-auto">
                <img src={spinButtonImage} alt="Spin button preview" class="w-full h-full object-cover rounded-full" />
                <button class="btn btn-xs btn-circle btn-error absolute -top-2 -right-2"
                        on:click={() => spinButtonImage = null}>✕</button>
              </div>
            {:else}
              <div
                role="region"
                aria-label="Drop image here or upload"
                class="border-2 border-dashed border-base-300 rounded p-4 text-center transition"
                on:dragover={(e) => { e.preventDefault(); e.currentTarget.classList.add('border-primary'); }}
                on:dragleave={(e) => { e.currentTarget.classList.remove('border-primary'); }}
                on:drop={handleSpinImageDrop}
              >
                <p class="text-sm mb-2">Drop image here or upload</p>
                <input type="file" accept="image/*" on:change={handleSpinImageFile}
                       class="file-input file-input-sm w-full" />
              </div>
            {/if}
          </div>
        </div>

        <!-- Background Image Section -->
        <div class="mb-6">
          <h4 class="font-semibold mb-2">Background Image</h4>
          <div class="flex flex-col gap-2">
            {#if backgroundImage}
              <div class="relative w-48 h-48 mx-auto">
                <img src={backgroundImage} alt="Background preview" class="w-full h-full object-cover rounded" />
                <button class="btn btn-xs btn-circle btn-error absolute -top-2 -right-2"
                        on:click={() => backgroundImage = null}>✕</button>
              </div>
            {:else}
              <div
                role="region"
                aria-label="Drop image here or upload"
                class="border-2 border-dashed border-base-300 rounded p-4 text-center transition"
                on:dragover={(e) => { e.preventDefault(); e.currentTarget.classList.add('border-primary'); }}
                on:dragleave={(e) => { e.currentTarget.classList.remove('border-primary'); }}
                on:drop={handleBackgroundImageDrop}
              >
                <p class="text-sm mb-2">Drop image here or upload</p>
                <input type="file" accept="image/*" on:change={handleBackgroundImageFile}
                       class="file-input file-input-sm w-full" />
              </div>
            {/if}
          </div>
        </div>

        <div class="modal-action justify-center">
          <button class="btn btn-primary" on:click={() => showImageUploadModal = false}>Done</button>
        </div>
      </div>
    </dialog>
  {/if}

  <!-- Upload Images Button (aligned with background image left edge, desktop only) -->
  <button
    class="btn btn-sm btn-outline absolute bottom-4 z-20 normal-case hidden lg:block lg:left-[calc(16rem+7px+1rem)] 3cols:lg:left-[calc(20rem+7px+1rem)]"
    on:click={() => showImageUploadModal = true}
    type="button"
  >
    Upload Images
  </button>

<!-- Nickname panel moved further down so its absolute positioning lines up
     with the Watched sidebar (they share the same relative offset based on
     DOM order). -->
</main>

<style>
  /* Ensure extremely long words wrap while still preferring spaces */
  .force-wrap {
    overflow-wrap: anywhere; /* allows break inside long words only if needed */
  }

  /* Button background image via pseudo-element to layer above triangle */
  .spin-button.has-image::before {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: 9999px; /* fully rounded like btn-circle */
    background-image: var(--button-bg-image);
    background-size: cover;
    background-position: center;
    z-index: 0;
  }

  .spin-button.has-image {
    color: transparent;
  }
</style>
