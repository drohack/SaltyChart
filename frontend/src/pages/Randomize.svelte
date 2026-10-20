<script lang="ts">
import SeasonSelect from '../components/SeasonSelect.svelte';
import { authToken, userName as activeUserName } from '../stores/auth';
import { seasonYear } from '../stores/season';
import { get } from 'svelte/store';
import { options } from '../stores/options';
import LoadingSpinner from '../components/LoadingSpinner.svelte';
import { onMount, tick } from 'svelte';
import { allUsers as nicknameAllUsers, selectedUsers as nicknameSelected, toggleUser as toggleNicknameUser } from '../stores/nicknameUsers';
import { checkAvailability, checkAvailabilityMany, forgetAvailability, mediaConfigured, libraryStatus, type MediaAvailability } from '../stores/jellyfin';
import { loadCastSdk, loadVideoJs, prewarm, playbackInfo, isItemGone } from '../lib/jellyfinPrewarm';
import { apiFetch, apiJson, QUICK, SEASON, ApiError } from '../lib/remote';

/** Set when a hide/show write failed and the optimistic change was put back. */
let hideWriteError = '';
// Reactive trigger for title-language changes

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
  let wheelEl: SVGSVGElement;
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
  // to require `entry.watched` and return null otherwise - and since the wheel
  // only ever holds *unwatched* shows, that meant your own number was missing
  // from the pop-up essentially always, while everyone else's was right there.
  // Mirror the server's rule instead of being stricter than it.
  $: myRank = selected
    ? (() => {
        const entry = watchList.find((w) => w.mediaId === selected.id);
        if (!entry) return null;
        if (typeof entry.watchedRank === 'number') return entry.watchedRank + 1;
        if (entry.watched) {
          // Watched but not yet persisted a rank - use the sidebar position.
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
    // showing shows as hidden while the server disagreed - reload and they were
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
    hideWriteError = `Couldn't save ${ids.length} of ${attempted} change${attempted === 1 ? '' : 's'} - put back.`;
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
    // - writing then would hide the wrong season's shows.
    const forSeason = season;
    const forYear = year;
    try {
      const visible = unwatchedDetailed.filter((it) => !it.hidden);
      // One request, not one per show. `checkAvailabilityMany` omits any entry
      // it couldn't get a definite answer for, which is exactly the semantics
      // this function needs - see the "never hide on unknown" note below.
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
      for (const [id, info] of results) next.set(id, info.available);
      libraryAvailability = next;
      // Never hide on an inconclusive answer - a timeout must not make
      // shows disappear from the wheel. An `unknown` verdict never reaches
      // `results`, so an unanswered show simply isn't in it, and the explicit
      // `=== false` below refuses to act on an absent entry.
      //
      // Title-only (`matchedBy === 'title'`) matches need no guard here: they
      // report `available: true`, so this only ever *keeps* them. That is the
      // conservative direction - an unconfirmed match's danger is playing the
      // wrong series, which the show pane warns about, not vanishing from the wheel.
      //
      // An unaired show is asked like any other: "not in the library" means no
      // file, whatever the calendar says. Unaired shows used to be kept without
      // asking, so DARK MACHINE (premiering in four days, 2026-10-10) survived
      // both hide buttons - while Chitose 2nd Cour already had its episode on
      // disk. Show All undoes a hide.
      const missing = visible.filter((it) => results.get(it.id)?.available === false);
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
   * Hide every unwatched show that cannot be watched in English here: one the
   * library does not hold, or one whose episode has neither a full English
   * subtitle track nor English audio (a signs-and-songs-only track does not
   * count). The subtitle verdict is the backend's `english` field, from the
   * same rules as /admin/sonarr's subtitle audit, so the two never disagree.
   *
   * A superset of Hide Not in Library, by request: a show you do not have is no
   * more watchable in English than a raw, and one that has not aired has no
   * episode to have English. Like every bulk hide here it never acts on an
   * unanswered show - `unknown`, or a held show whose verdict predates the
   * `english` field, keeps the show visible.
   */
  let hidingNotEnglish = false;

  async function hideNotEnglish() {
    if (!$authToken || hidingNotEnglish) return;
    hidingNotEnglish = true;
    const forSeason = season;
    const forYear = year;
    try {
      const visible = unwatchedDetailed.filter((it) => !it.hidden);
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
      for (const [id, info] of results) recordEnglish(id, info);
      const notEnglish = visible.filter((it) => isNotEnglish(results.get(it.id)));
      if (!notEnglish.length) return;

      watchList = watchList.map((entry) =>
        notEnglish.some((m) => m.id === entry.mediaId) ? { ...entry, hidden: true } : entry
      );
      // Same optimistic-write rule as the other bulk paths.
      const failed = await writeHidden(notEnglish.map((m) => m.id), true);
      if (failed.length) revertHidden(failed, false, notEnglish.length);
    } finally {
      hidingNotEnglish = false;
    }
  }

  /**
   * Is this a definite "can't watch it in English here"? Yes for a show the
   * library definitely lacks (the same test as Hide Not in Library, aired or
   * not), and for a held show whose episode is explicitly `none` or
   * `signsOnly`. No for `unknown`, a dub (`engAudio`), and a held show whose
   * verdict has no `english` field yet - those are "don't know" or "fine".
   * `watchable` in backend/src/lib/entryStatus.ts is this rule for /admin/sonarr.
   */
  function isNotEnglish(info: MediaAvailability | undefined): boolean {
    if (!info || info.unknown) return false;
    if (info.available === false) return true;
    return info.english === 'none' || info.english === 'signsOnly';
  }

  /**
   * Toggle the `hidden` flag for a single item.
   *
   * Optimistic, with the same failure contract as the bulk paths: the write
   * goes through writeHidden, and one the server refuses is put back and
   * announced via hideWriteError. This used to be the one hide path that
   * ignored failure - the show looked hidden, the server never saved it, and
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

  // Fetch nickname list whenever the show pane opens (and selected differs). Guarded by
  // the id it was asked for: opening a second show before the first answered
  // let the first show's nicknames land last.
  $: if (showModal && selected) loadNicknames(selected.id);

  async function loadNicknames(mediaId: number) {
    try {
      const list = await apiJson<any[]>(`/api/list/nicknames?mediaId=${mediaId}`, {}, {
        timeoutMs: QUICK, label: 'nicknames'
      });
      if (selected?.id === mediaId) nicknameList = list;
    } catch {
      if (selected?.id === mediaId) nicknameList = [];
    }
  }

  // -- Library availability (never blocks the pane) -------------------
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
    // previous one - the state belongs to this pane, not the page.
    closePicker();
    // The pane leaves the lists clickable while an episode plays, so another
    // show can be opened mid-episode. `watchInfo = null` above unmounts the old
    // player (its onDestroy stops the transcode), but a still-true `showPlayer`
    // would mount the new show's player as soon as its lookup resolved -
    // starting a transcode nobody asked for. Each show starts at its Watch.
    closePlayer();
    endPlacementUnless(id);
    checkAvailability(id, titles, false, airing)
      .then((info) => {
        // Guard against a stale resolve after the user opened a different show.
        if (selected?.id !== id) return;
        watchInfo = info;
        // This pane stays open while the show is looked over, so spend that time
        // on what the player will want - what is warmed, and why nothing ever
        // touches the HLS manifest, is jellyfinPrewarm.ts's module header.
        if (info.available && info.itemId && info.mediaSourceId) {
          loadPlayerModal();
          void warmOrHeal(id, titles as string[], airing, info);
        }
        // Cached "not available" -> re-check live, so a show downloaded a
        // minute ago appears without waiting out the cache TTLs - an unaired
        // one included, since its file can land before the premiere.
        if (!info.available) {
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

  /**
   * Prewarm the player, and notice on the way if the episode has been replaced.
   *
   * The prewarm already asks for playback info, so a dead item id costs nothing
   * extra to detect: `playbackInfo` shares its cache entry. When Sonarr upgrades
   * a file and Jellyfin rescans it, the episode comes back under a NEW item id
   * (PANDOROBO S01E01, 2026-10-09) - and both the session cache here and the
   * server's hour-long one kept offering the dead id, so Watch opened a black
   * player and a hard reload did not help. Healing it while the pane is
   * being read means the viewer never sees it.
   */
  async function warmOrHeal(
    id: number,
    titles: string[],
    airing: { status?: string | null; startDate?: any },
    info: MediaAvailability
  ): Promise<boolean> {
    if (!info.itemId || !info.mediaSourceId) return false;
    prewarm(info.itemId, info.mediaSourceId);
    const probe = await playbackInfo(info.itemId, info.mediaSourceId, { quality: 'auto' });
    if (probe || !isItemGone(info.itemId)) return false;
    forgetAvailability(id);
    const fresh = await checkAvailability(id, titles, true, airing);
    if (selected?.id !== id) return false;
    watchInfo = fresh;
    if (fresh.available && fresh.itemId && fresh.mediaSourceId && fresh.itemId !== info.itemId) {
      prewarm(fresh.itemId, fresh.mediaSourceId);
      return true;
    }
    return false;
  }

  /** The player found its item gone: look the show up again and reopen once on the new one. */
  async function onItemGone() {
    if (!selected || !watchInfo) return;
    const titles = [
      selected.customName,
      selected.title?.english,
      selected.title?.romaji,
      selected.title?.native,
    ].filter(Boolean) as string[];
    const airing = { status: selected.status, startDate: selected.startDate };
    const healed = await warmOrHeal(selected.id, titles, airing, watchInfo);
    if (!healed) return; // the player's own message stays up
    showPlayer = false;
    await tick();
    showPlayer = true;
  }

  /** The player chunk is fetched early - its weight and why are on `warmPlayerAssets` below. */
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
   * "Not the right show?" - let the viewer pin this entry to a library item.
   *
   * This pane is where a wrong match is actually noticed; /admin/matching is
   * where it could be fixed, and nobody goes there. A pick is written as an
   * identity override, so it is remembered FOR EVERYONE and lands in the admin
   * review queue rather than being one person's private workaround.
   *
   * Options are LIBRARY items only - every one of them can actually play. The
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

  /** TVDB titles often embed their own disambiguation year - "ONE PIECE (2023)"
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
    // Prefilled with the entry's own title and searched at once - the common
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

  /** Undo - put the entry back to whatever the matcher works out on its own. */
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
      // `fresh` bypasses both caches; the pane's own staleness guard applies
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

  /**
   * Opening a different show ends the last one's placement. Left running, the
   * new show's pane had no Enter, its arrows nudged the previous show around
   * the rail, and every rail click moved that show - until the next spin.
   * Closing the pane does NOT end it: on a phone the rail is a drawer, and the
   * show is placed after the sheet is closed. A plain function, so the reactive
   * block calling it does not depend on `placingId` (Rank it sets that, and a
   * re-run would unmount the playing episode).
   */
  function endPlacementUnless(id: number) {
    if (placingId != null && placingId !== id) placingId = null;
  }

  // Loading state while fetching list & anime
  let loading = false;

  // ------------------------------------------------------------------
  // Mobile sidebar collapse state (unwatched & watched lists)
  // ------------------------------------------------------------------

  let unwatchedCollapsed = true;
  let watchedCollapsed = true;

  // After the first spin the page is "in session": the Unwatched list tucks
  // into a pull-out strip and the show pane replaces the wheel in place.
  let sessionMode = false;
  /** The just-watched show being placed in the rank list, or null. */
  let placingId: number | null = null;
  let rankSidebar: any;
  $: unwatchedOnScreen = !sessionMode;
  function stripClick() {
    // A show opened from the docked list: the strip reads "hide the list", so
    // it tucks the list and the show keeps the room. Closing the show here is
    // only for when the list is already tucked away.
    if (showModal && !unwatchedOnScreen) {
      showModal = false; // closes the player with it
      sessionMode = false;
    } else {
      sessionMode = !sessionMode;
    }
  }
  function tuckUnwatched() {
    // Phones: the list slides over the page and this just closes it. Desktop:
    // the same tucked state the first spin produces, without spinning.
    if (window.matchMedia('(min-width: 1024px)').matches) sessionMode = true;
    else unwatchedCollapsed = true;
  }
  // Changing season starts setup again - the Unwatched list docks back
  // (and the wheel glides over to make room) so the new season can be prepared.
  function endSession(..._deps: unknown[]) {
    sessionMode = false;
    placingId = null;
    showModal = false; // the pane belongs to the old season
    rankExpanded = false;
  }
  $: endSession(season, year);

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
   * so waiting for the show pane throws away all the time someone spends choosing
   * one - and over the web, rather than localhost, that gap is long enough that
   * pressing Watch looks broken.
   *
   * Per-episode data (the episode's PlaybackInfo) can't be fetched this early
   * and is warmed when the pane opens instead.
   *
   * Only for viewers who can actually play something, on idle so it never
   * competes with the page's own images, and never on a metered connection -
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

  // Both reads go through `lib/remote`, and land only if they are still for
  // the season on screen. They were bare fetches with no catch and no request
  // id: a network error was an unhandled rejection that left the previous
  // season's shows on the wheel with nothing on screen to say so, and switching
  // seasons quickly let an older response land last.
  let loadError = false;
  let _loadReqId = 0;

  async function fetchList(): Promise<any[]> {
    if (!$authToken) return [];
    return apiJson<any[]>(
      `/api/list?season=${season}&year=${year}`,
      { headers: { Authorization: `Bearer ${$authToken}` } },
      { timeoutMs: QUICK, label: 'randomize list' }
    );
  }

  async function fetchAnime(): Promise<any[]> {
    // A cold season can take minutes under AniList rate-limiting (see SEASON).
    return apiJson<any[]>(`/api/anime?season=${season}&year=${year}`, {}, {
      timeoutMs: SEASON, retries: 1, label: 'randomize season'
    });
  }

  const fetchBoth = async () => {
    const reqId = ++_loadReqId;
    loading = true;
    loadError = false;
    try {
      const [list, shows] = await Promise.all([fetchList(), fetchAnime()]);
      if (reqId !== _loadReqId) return;
      watchList = list;
      anime = Array.isArray(shows) ? shows : [];
    } catch (err) {
      if (reqId !== _loadReqId) return;
      console.warn('[Randomize] season load failed', err);
      // Never leave the previous season's shows on the wheel under this
      // season's heading.
      watchList = [];
      anime = [];
      loadError = true;
    } finally {
      if (reqId === _loadReqId) loading = false;
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
      // that clears `spinning` never arrives - without this the Spin button
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
  // when its id no longer matches - prevents rapid season-switch races from
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
      if (reqId !== _autoSelectReqId) return; // stale response - discard
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

  // Shown in the upload modal when an image is too big to keep. A data URL is
  // ~4/3 of the file, and sessionStorage is a few MB per origin, so a large
  // photo overflows it.
  let imageStoreError: string | null = null;

  /**
   * Persist one custom image, or clear it.
   *
   * The `setItem` calls used to be bare, inside the reactive block below. That
   * made an oversized upload throw `QuotaExceededError` *inside a Svelte update
   * flush*, which is far worse than losing the image: the rest of the flush never
   * ran, so `showImageUploadModal = false` stopped reaching the DOM and the modal
   * became unclosable - Done, the X and Escape all dead, covering the whole
   * viewport until a reload. Measured with a 19 MB PNG; nothing was stored and
   * nothing was said.
   *
   * Every other storage write in this app is already wrapped (`stores/options.ts`,
   * `stores/season.ts`, `Home.savePrefs`); this block was the outlier. Returns
   * false so the caller can drop the image it could not keep.
   */
  function persistImage(key: string, value: string | null): boolean {
    try {
      if (value) sessionStorage.setItem(key, value);
      else sessionStorage.removeItem(key);
      return true;
    } catch (err) {
      console.warn(`[randomize] could not store ${key}:`, err);
      return false;
    }
  }

  // Persist custom images to sessionStorage when they change (only after initial
  // load). Each key is guarded on its own so a failure on one does not skip the
  // other.
  $: if (imagesLoaded && typeof sessionStorage !== 'undefined') {
    if (!persistImage('wheelSpinButtonImage', spinButtonImage)) {
      spinButtonImage = null;
      imageStoreError = 'That image is too large to keep - try one under a few MB.';
    }
    if (!persistImage('wheelBackgroundImage', backgroundImage)) {
      backgroundImage = null;
      imageStoreError = 'That image is too large to keep - try one under a few MB.';
    }
  }

  // The options panel beside the wheel ("Add Watched to" + "Nicknames from")
  // folds to its top row. Remembered per browser: it is a layout preference, not
  // account data, and losing it to blocked storage costs one click.
  const OPTIONS_COLLAPSED_KEY = 'randomizeOptionsCollapsed';
  let optionsCollapsed = (() => {
    try {
      return localStorage.getItem(OPTIONS_COLLAPSED_KEY) === '1';
    } catch {
      return false;
    }
  })();

  function toggleOptionsCollapsed() {
    optionsCollapsed = !optionsCollapsed;
    try {
      localStorage.setItem(OPTIONS_COLLAPSED_KEY, optionsCollapsed ? '1' : '0');
    } catch (err) {
      console.warn('[randomize] could not store the options panel state:', err);
    }
  }

  // Separate entries into watched/unwatched for easier handling.
  //  * watchedEntries is needed for the ranking sidebar.
  //  * We no longer hide watched shows from the left sidebar - that list now
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
  // list is ready, so the pane's Watch button is there instantly instead of
  // popping in ~1s after open. The store dedups + caches per mediaId, so
  // re-runs of this reactive block are no-ops.
  // mediaId -> is it in the library (absent = not checked yet). Drives both
  // the Watch button and the "Hide Not in Library" button's enabled state.
  let libraryAvailability = new Map<number, boolean>();

  /**
   * Record one availability answer.
   *
   * Deliberately a plain function, not an assignment inside the `$:` block
   * below: Svelte treats a reactive statement that writes one of its own
   * dependencies as needing "extra invalidations", so every single response
   * marked `watchList`/`anime`/`unwatchedEntries`/`wheelItems` dirty and
   * re-ran this block - one full recompute of the wheel pipeline per show.
   */
  function recordAvailability(id: number, available: boolean) {
    if (libraryAvailability.get(id) === available) return;
    libraryAvailability = new Map(libraryAvailability).set(id, available);
  }

  // mediaId -> true when the show is held but can't be watched in English
  // (see `isNotEnglish`). Absent = not known. Drives Hide Not English's
  // enabled state, recorded the same plain-function way for the same reason.
  let notEnglishIds = new Map<number, boolean>();

  function recordEnglish(id: number, info: MediaAvailability) {
    if (info.unknown) return;
    const value = isNotEnglish(info);
    if (notEnglishIds.get(id) === value) return;
    notEnglishIds = new Map(notEnglishIds).set(id, value);
  }

  /**
   * Extracted from the reactive block below so the Retry button can call it.
   * Previously the only thing that could trigger a lookup was `wheelItems`
   * changing, so a failed check stayed failed for as long as the page was open
   * - the page had no way back short of a reload.
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
        // Unaired shows are asked too - a file can land before the premiere.
        airing: { status: item.status, startDate: item.startDate },
      }))
    )
      .then((results) => {
        for (const [mediaId, info] of results) {
          // Definite answers only - the unknown invariant is spelled out on the
          // hide path above. An unaired show is answered like any other.
          if (!info.unknown) recordAvailability(mediaId, info.available);
          recordEnglish(mediaId, info);
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
  $: hasNotEnglishVisible = unwatchedDetailed.some(
    (it) => !it.hidden && notEnglishIds.get(it.id) === true
  );
  // Shown beside the Unwatched heading. A list where most rows are dimmed reads
  // as "the wheel is broken" unless it says how many are hidden on purpose.
  $: unwatchedHiddenCount = unwatchedDetailed.filter((it) => it.hidden).length;
  $: unwatchedShownCount = unwatchedDetailed.length - unwatchedHiddenCount;

  // (Watched ranking is handled separately - see watchedRank below)

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
  import RankingExpanded from '../components/RankingExpanded.svelte';
  import CopyListPanel from '../components/CopyListPanel.svelte';
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
    // Simple triangle blip - clearer than filtered noise; very short.
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

  // Only recompute slice angles when item COUNT changes - not on name/visibility updates
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
    // While `loading` the wheel's svg is not mounted, so no transition would
    // run, `transitionend` would never fire and `spinning` would stick - a dead
    // Spin button until the season changed.
    if (!wheelItems.length || spinning || loading) return;

    // Drop keyboard focus from whatever was clicked (usually this button) -
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
    // The first spin ends setup.
    sessionMode = true;
    // Every spin folds the options panel to its one-line header (not
    // saved - the viewer's own fold choice in localStorage is left alone).
    optionsCollapsed = true;
    placingId = null;

    let idx = Math.floor(Math.random() * wheelItems.length);
    if (wheelItems.length > 1 && lastSelectedId !== null && wheelItems[idx].id === lastSelectedId) {
      // Re-roll once to avoid immediate repeat.  Second random value guarantees change.
      idx = (idx + 1 + Math.floor(Math.random() * (wheelItems.length - 1))) % wheelItems.length;
    }
    const segAngle = 360 / wheelItems.length;

    const POINTER_OFFSET = 0; // pointer located at 12 o'clock (top-center)

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
    // slices are present.  We cap to MAX_AUDIBLE_TICKS clicks by skipping evenly.
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

  /**
   * Double-click a slice to open that show, the same as clicking it in the
   * Unwatched list. The slice comes from the click's angle: item i's slice is
   * centred (i + 0.5) slices clockwise from 12 o'clock in the wheel's own frame
   * (the inverse of spin()'s targetAngle), so subtract the wheel's rotation.
   * Ignored while spinning and on the Spin button, whose clicks bubble here.
   */
  function openSliceAt(e: MouseEvent) {
    if (spinning || !wheelItems.length || (e.target as Element).closest('.spin-button')) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    if (Math.hypot(dx, dy) > r.width / 2) return; // outside the wheel's circle
    const screenDeg = (Math.atan2(dx, -dy) * 180) / Math.PI;
    const wheelDeg = (((screenDeg - rotation) % 360) + 360) % 360;
    const item = wheelItems[Math.floor(wheelDeg / (360 / wheelItems.length)) % wheelItems.length];
    if (!item) return;
    selected = item;
    showModal = true;
  }

  let showModal = false;
  $: selectedWatched = !!selected &&
    !!(selected.watched || watchList.find((w) => w.mediaId === selected.id)?.watched);

// Global key handler (attached while the show pane, the upload modal or the
// expanded ranking is open) so Enter and Escape act irrespective of which
// element currently has focus.
function handleModalKey(e: KeyboardEvent) {
  // The expanded ranking sits over everything, so it answers first:
  // Escape collapses it (it never closes the show), arrows nudge the show
  // being placed. Checked before the player guard - the player is paused
  // underneath and must not take the key.
  if (rankExpanded) {
    if (e.key === 'Escape') { e.preventDefault(); collapseRanking(); }
    else if (placingId != null && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      e.preventDefault();
      rankExpandedRef?.nudge(e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 1);
    }
    return;
  }
  // While an episode plays the keyboard belongs to the video (Space, [ and ]):
  // Enter here would rank the show, and Escape would close the pane and the
  // episode with it - one stray key ending what someone is watching.
  // Placing still answers Up/Down, though: the rail's hint says "use the
  // arrows", and with focus outside the player (where it almost always is)
  // they did nothing at all. Inside the player they stay video.js's.
  if (showPlayer && placingId != null && (e.key === 'ArrowUp' || e.key === 'ArrowDown')
      && !(e.target as HTMLElement | null)?.closest?.('.video-js')) {
    e.preventDefault();
    rankSidebar?.nudge(e.key === 'ArrowUp' ? -1 : 1);
    return;
  }
  if (showPlayer) return;
  // The upload modal is its own dialog, opened from the page rather than from
  // the show pane. It is rendered as `<dialog open>` rather than via showModal(),
  // so it gets no native Escape behaviour while its `.modal` backdrop still
  // covers the viewport - Escape did nothing on it for as long as it existed,
  // and Done was the only way out. It takes priority because when it is open it
  // is the thing on top.
  if (showImageUploadModal) {
    if (e.key === 'Escape') {
      e.preventDefault();
      showImageUploadModal = false;
    }
    return;
  }
  if (pickOpen) {
    // Pick mode owns the keyboard too: Enter is someone typing into the
    // library search, and this window-level handler would mark the show
    // watched out from under them. Escape leaves the picker rather than the
    // whole pane.
    if (e.key === 'Escape') {
      e.preventDefault();
      closePicker();
    }
    return;
  }
  if (placingId != null && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    rankSidebar?.nudge(e.key === 'ArrowUp' ? -1 : 1);
  } else if (e.key === 'Enter') {
    // Enter on a focused control is that control's own action. The lists stay
    // usable beside the pane, so Enter on an Unwatched row opened that show AND
    // ranked it unseen, and Enter on the X or Hide ranked the open show. Spin
    // drops focus, so straight after a spin Enter still means Rank it.
    const target = e.target as HTMLElement | null;
    if (e.defaultPrevented || target?.closest?.('button, a, input, select, textarea, [role="button"]')) return;
    e.preventDefault();
    if (placingId == null) rankIt(); // while placing, Enter does nothing - no accidental spin
  } else if (e.key === 'Escape') {
    // Window-level, because a handler on the pane itself only fires when focus
    // is inside it - the old pop-up's tabindex="-1" overlay never got focus,
    // so Escape did nothing on it at all.
    e.preventDefault();
    showModal = false;
  }
}

// Clean-up in case the component is destroyed while the pane is open
onDestroy(() => {
  window.removeEventListener('keydown', handleModalKey);
  // Both are created per visit; without these every trip to /random left one
  // more worker thread and audio context running behind the page.
  sliceWorker.terminate();
  audioCtx?.close().catch(() => {});
});

// Dynamically attach / detach the listener whenever the pane, the upload modal
// or the expanded ranking opens or closes.
$: {
  if (showModal || showImageUploadModal || rankExpanded) {
    window.addEventListener('keydown', handleModalKey);
  } else {
    window.removeEventListener('keydown', handleModalKey);
    // Closing the pane unmounts the player with it, but the flag would stay
    // set - and handleModalKey ignores every key while it is, so Enter and
    // Escape would be dead on every pane opened after.
    closePlayer();
  }
}

  /**
   * Hide the currently selected series from the wheel. Called from the show
   * pane: the alternative to ranking it when the viewer decides they don't want
   * it in the randomizer.
   */
  async function hideSelectedSeries() {
    if (!selected) return;

    // Find the corresponding entry in unwatchedDetailed that has the full structure
    // including the hidden property that toggleHide expects
    const entry = unwatchedDetailed.find((item) => item.id === selected.id);

    if (entry) {
      // Close the pane immediately for responsive UI
      showModal = false;

      // Call existing toggleHide which handles optimistic update + API call
      toggleHide(entry);
    }
  }

  // Rank it marks the show watched WITHOUT closing the pane - the episode
  // keeps playing - and starts placing it in the rank list.
  let spinNextArmed = true;
  let armTimer: ReturnType<typeof setTimeout> | null = null;
  function rankIt() {
    if (!selected) return;
    if (!selectedWatched) toggleWatched(selected.id, true);
    placingId = selected.id;
    // The rail sits beside the pane only on a PC. Narrower, the Watched list
    // is a drawer that would slide over the pane and its buttons, so it stays
    // shut - the show is still being placed when the viewer opens it.
    if (window.matchMedia('(min-width: 1024px)').matches) watchedCollapsed = false;
    // A double-click on Rank it must not land on Spin next.
    spinNextArmed = false;
    if (armTimer) clearTimeout(armTimer);
    armTimer = setTimeout(() => (spinNextArmed = true), 600);
  }
  // The live rank of the show being placed, for the label in Rank it's spot.
  $: placingRank = placingId == null ? null : watchedRank.findIndex((it) => it.id === placingId) + 1 || null;
  function spinNext() {
    if (!spinNextArmed) return;
    rankExpanded = false;
    pausedByExpand = false;
    placingId = null;
    showModal = false;
    tick().then(spin);
  }

  /**
   * Save a new Watched order - from the rail or the expanded ranking alike.
   * Keeps `watchList` in step so later reactive passes (e.g. marking another
   * show watched) keep the user's order. A failed save re-reads the season (the
   * server is the truth) and says so, as `toggleWatched` does.
   */
  function applyRankOrder(idOrder: number[]) {
    watchedRank = idOrder.map((id) => watchedRank.find((it) => it.id === id)).filter(Boolean);
    watchList = watchList.map((entry) => {
      const idx = idOrder.indexOf(entry.mediaId);
      return idx !== -1 ? { ...entry, watchedRank: idx } : entry;
    });
    if ($authToken) queueRankSave({ season, year, ids: idOrder });
  }

  // Rank saves are debounced and sent one at a time. Each arrow press used to
  // PATCH at once: a held arrow repeats ~30/s against production's 120/min
  // per-IP limit (shared by the whole group on one connection), and with no
  // ordering two saves could land in either order, leaving the server on an
  // order the screen no longer showed. Only the latest order matters, so a
  // newer one replaces a waiting one. The season is captured when queued, so a
  // save straddling a season change still goes to the season it belongs to.
  type RankSave = { season: string; year: number; ids: number[] };
  let rankSavePending: RankSave | null = null;
  let rankSaveInFlight = false;
  let rankSaveTimer: ReturnType<typeof setTimeout> | null = null;
  function queueRankSave(save: RankSave) {
    rankSavePending = save;
    if (rankSaveTimer) clearTimeout(rankSaveTimer);
    rankSaveTimer = setTimeout(() => void flushRankSave(), 400);
  }
  async function flushRankSave() {
    if (rankSaveInFlight || !rankSavePending) return;
    const save = rankSavePending;
    rankSavePending = null;
    rankSaveInFlight = true;
    try {
      const res = await apiFetch('/api/list/rank', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${$authToken}` },
        body: JSON.stringify(save)
      }, { timeoutMs: QUICK, retries: 0, label: 'watched rank' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      console.error('[Randomize] rank order not saved', err);
      hideWriteError = "Couldn't save the new order - put back.";
      setTimeout(() => (hideWriteError = ''), 8000);
      // The server is the truth. Re-reading alone did not put it back:
      // `watchedRank` is rebuilt only when its SET of ids changes, and a
      // reorder never changes the set, so the rail kept the unsaved order.
      // Emptying it forces the rebuild from what the server returned.
      rankSavePending = null;
      if (save.season === season && save.year === year) {
        await fetchBoth();
        watchedRank = [];
      }
    } finally {
      rankSaveInFlight = false;
      if (rankSavePending) void flushRankSave();
    }
  }

  // The expanded ranking (the rail's "Expand ranking"). Opening it while
  // the episode plays pauses it; Collapse resumes only what it paused.
  let rankExpanded = false;
  let rankExpandedRef: any;
  let pausedByExpand = false;
  function inlineVideo(): HTMLVideoElement | null {
    return document.querySelector('[data-video-box] video');
  }
  function openRanking() {
    const v = inlineVideo();
    pausedByExpand = !!v && !v.paused;
    if (pausedByExpand) v!.pause();
    rankExpanded = true;
  }
  function collapseRanking() {
    rankExpanded = false;
    const v = inlineVideo();
    if (pausedByExpand && v) void v.play().catch(() => {});
    pausedByExpand = false;
  }

  function handleSpinImageFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    imageStoreError = null; // a fresh pick clears a previous "too large"

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
    imageStoreError = null; // a fresh pick clears a previous "too large"

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
    imageStoreError = null; // a fresh pick clears a previous "too large"

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
    imageStoreError = null; // a fresh pick clears a previous "too large"

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
      // The screen already shows the change, so a failed save has to be said
      // out loud and undone - these used to ignore the status entirely, so a
      // rejected write left the screen and the server disagreeing until the
      // next reload quietly put it back. Re-reading the season is the undo: the
      // server is the truth, and the optimistic state above touched two lists.
      const fail = (err: unknown) => {
        console.error('[Randomize] watched change not saved', err);
        hideWriteError = "Couldn't save that change - put back.";
        setTimeout(() => (hideWriteError = ''), 8000);
        void fetchBoth();
      };
      try {
        const res = await apiFetch('/api/list/watched', {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${$authToken}`
          },
          body: JSON.stringify({ season, year, mediaId: id, watched })
        }, { timeoutMs: QUICK, retries: 0, label: 'mark watched' });
        if (!res.ok) return fail(`HTTP ${res.status}`);

        // Persist the full watched-rank ordering too. /watched alone always
        // stores the new row at the bottom server-side, which would discard the
        // TOP placement (and the renormalized order after an unwatch) the user
        // just saw. Mirrors the drag handler's rank PATCH.
        const idOrder = watchedRank.map((it) => it.id);
        if (idOrder.length) {
          const rank = await apiFetch('/api/list/rank', {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${$authToken}`
            },
            body: JSON.stringify({ season, year, ids: idOrder })
          }, { timeoutMs: QUICK, retries: 0, label: 'watched rank' });
          if (!rank.ok) return fail(`rank HTTP ${rank.status}`);
        }
      } catch (err) {
        fail(err);
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
  // For the show pane - ignores the user's title-language preference.
  function getEnglishTitle(item: any): string {
    return item.title?.english || item.title?.romaji || item.title?.native || '';
  }
  // For the show pane - ignores the user's title-language preference.
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
    return title.length > LABEL_CHAR_LIMIT ? title.slice(0, LABEL_CHAR_LIMIT - 1) + '...' : title;
}


</script>

<main class="pb-0 flex flex-col gap-2">
  <!-- Controls aligned to header (matches the width pattern on Home and Compare) -->
  <div class="w-full sm:max-w-[calc(100vw-32rem)] 2cols:sm:max-w-[calc(100vw-40rem)] sm:mx-auto [&>*]:!mb-0">
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

  <!-- Container: wheel grows to fill remaining space. `wheel-area` (see
       <style>) owns the wheel's size; from `lg` the padding matches the docked
       lists, so the wheel centres in the space between them, not on the page.
       Absolutely positioned children (the lists, the background) ignore the
       padding - they sit against the padding edge as before. -->
  <div class="wheel-area relative w-full flex justify-center items-center overflow-visible flex-1 lg:pl-[calc(16rem+7px)] 3cols:lg:pl-[calc(20rem+7px)] lg:pr-[calc(21rem+7px)]" class:session-pad={sessionMode} style="min-height: var(--area-size);">
    <div class="flex flex-col items-center mx-auto" class:invisible={showModal && !!selected}>
      {#if loading}
        <LoadingSpinner size="lg" />
      {:else if loadError}
        <div class="mt-24 text-center" data-season-load-error>
          <p class="opacity-70 mb-3">Couldn't load this season - the server didn't answer.</p>
          <button class="btn btn-sm btn-outline" on:click={fetchBoth}>Retry</button>
        </div>
      {:else if !wheelItems.length && !watchList.length && $authToken}
        <!-- No list at all: offer someone else's. A list whose shows are all
             watched or hidden is not empty and keeps the message below. -->
        <!-- Centred in the room LEFT of the options panel (absolute, `w-52`,
             z-30): centred in the whole area, its right side and Copy list sat
             under that panel on a 1366px laptop. Below `xl` there is no such
             room (246px at 1100), so it is simply above the panel and the
             Upload Images button instead - with no list, neither has anything
             to act on yet. -->
        <div class="relative z-[31] w-full xl:pr-52">
          <CopyListPanel {season} {year} {anime} token={$authToken} self={$activeUserName} on:copied={fetchBoth} />
        </div>
      {:else if !wheelItems.length}
        <div class="mt-24 text-center opacity-70">My List for this season is empty.</div>
      {:else}
        <!-- Background image (spans from unwatched list to nicknames panel) -->
        {#if backgroundImage}
          <div
            class="absolute lg:left-[calc(16rem+7px)] 3cols:lg:left-[calc(20rem+7px)] lg:right-[calc(21rem+7px)]"
            style="
              height: var(--area-size);
              background-image: url({backgroundImage});
              background-size: cover;
              background-position: center;
              z-index: 0;
            "
          ></div>
        {/if}

        <!-- Wheel. Double-clicking a slice opens that show; the Unwatched list
             is the keyboard route to the same thing. -->
        <!-- svelte-ignore a11y-no-static-element-interactions -->
        <div
          id="wheel-wrapper"
          class="relative mx-auto overflow-visible select-none"
          on:dblclick={openSliceAt}
          style="
            width: var(--wheel-size);
            height: var(--wheel-size);
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
            // Slight delay before showing the pane so confetti is visible underneath
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
               Polar helper uses 0 deg at 12 o'clock, but CSS/SVG rotate() uses 0 deg at 3 o'clock -> offset -90 deg -->
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
      class:session-tucked={sessionMode}
      class:desk-docked={!sessionMode}
      style="max-height: calc(100dvh - 0px);"
    >
      {#if unwatchedDetailed.length}
        <div class="mb-4 pr-2">
          <!-- Row 1: Title and Sort -->
          <div class="flex items-center justify-between mb-2">
            <h3 class="text-lg font-bold text-center md:text-left">
              Unwatched
              {#if unwatchedDetailed.length}
                <span
                  class="text-xs font-normal opacity-60 whitespace-nowrap"
                  data-unwatched-counts
                  title="Shown are on the wheel; hidden ones stay in your list but the wheel skips them"
                >{unwatchedShownCount} shown, {unwatchedHiddenCount} hidden</span>
              {/if}
            </h3>

            <!-- Hide tab (mobile only) -->
            <button
              class="lg:hidden absolute right-0 top-1/2 -translate-y-1/2 bg-base-200 hover:bg-base-300 rounded-r px-1 py-6 shadow flex items-center justify-center z-50"
              style="width: 1.25rem;"
              aria-label="Hide Unwatched list"
              on:click={tuckUnwatched}
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

          <!-- Hide controls, two rows: four buttons on one line ran past the
               sidebar's width, so the library ones were cut off. Each row
               wraps rather than clipping if the sidebar is narrower still. -->
          {#if $authToken}
            <div class="flex flex-col gap-1.5" data-hide-controls>
            <div class="flex flex-wrap items-center gap-2">
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
            </div>
            {#if $mediaConfigured}
              <div class="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  class="btn btn-xs btn-outline normal-case filter brightness-75 hover:brightness-100"
                  on:click={hideNotInLibrary}
                  disabled={!hasNonLibraryVisible || hidingNonLibrary}
                  title={$libraryStatus === 'unreachable'
                    ? "Can't reach the media server, so nothing is known to be missing"
                    : $libraryStatus === 'checking'
                    ? 'Still checking which shows the library has...'
                    : hasNonLibraryVisible
                    ? "Hide every unwatched show the library doesn't have (confirmed matches only)"
                    : 'Nothing to hide - every unwatched show is in the library'}
                >
                  {#if hidingNonLibrary}<span class="loading loading-spinner loading-xs"></span>{/if}
                  Hide Not in Library
                </button>
                <button
                  type="button"
                  class="btn btn-xs btn-outline normal-case filter brightness-75 hover:brightness-100"
                  data-hide-not-english
                  on:click={hideNotEnglish}
                  disabled={!hasNotEnglishVisible || hidingNotEnglish}
                  title={$libraryStatus === 'unreachable'
                    ? "Can't reach the media server, so nothing is known about subtitles"
                    : $libraryStatus === 'checking'
                    ? 'Still checking the library...'
                    : hasNotEnglishVisible
                    ? 'Hide shows you cannot watch in English: not in the library, or the episode has no English subtitles and no English audio (a signs-only track does not count)'
                    : 'Nothing to hide - every shown show is in the library with English subtitles or audio'}
                >
                  {#if hidingNotEnglish}<span class="loading loading-spinner loading-xs"></span>{/if}
                  Hide Not English
                </button>
              </div>
            {/if}

            <!-- Which kind of nothing this is. A disabled button looks the
                 same whether every show is present or the lookup never
                 answered, and those were indistinguishable on screen - the
                 reason a real outage read as normal operation. The write error
                 sits outside the library gate: Hide All / Show All can fail too. -->
            {#if hideWriteError}
              <span class="text-xs text-error" data-hide-write-error>{hideWriteError}</span>
            {/if}
            {#if $mediaConfigured}
                {#if $libraryStatus === 'checking'}
                  <span class="text-xs opacity-60 flex items-center gap-1" data-library-status="checking">
                    <span class="loading loading-spinner loading-xs"></span>
                    Checking your library...
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
                  class="text-sm flex-1 min-w-0 line-clamp-2 break-words"
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

    <!-- On desktop this strip is the ONE control for the Unwatched list:
         it docks the list (the wheel glides over to make room) and tucks it away
         again (the wheel glides back to the middle). Every spin tucks it. With a
         show's pane up and the list tucked, a click closes the pane and docks
         the list beside the wheel - the wheel is what matters if someone reaches
         for the list. With the list docked beside a pane, it only tucks the list. -->
    <button
      class="hidden lg:flex absolute z-[45] left-0 top-0 bottom-0 w-8 bg-base-200 hover:bg-base-300 shadow items-center justify-center"
      aria-label={unwatchedOnScreen ? 'Hide the Unwatched list' : 'Show the Unwatched list'}
      data-unwatched-drawer
      on:click={stripClick}
    >
      <span class="[writing-mode:vertical-rl] rotate-180 text-xs tracking-widest opacity-70 whitespace-nowrap">
        {@html unwatchedOnScreen ? '&lsaquo;' : '&rsaquo;'} UNWATCHED ({unwatchedShownCount})
      </span>
    </button>

    <!-- The restore tabs show only while BOTH lists are shut. Each list's own
         hide tab sits on its inner edge, which on a 320px phone (the lists are
         20rem wide) is exactly where the OTHER list's restore tab is pinned -
         so tapping "hide" hit "show the other one" instead, and with one list
         always open the wheel could never be reached. -->
    {#if unwatchedCollapsed && watchedCollapsed}
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
          bind:this={rankSidebar}
          {placingId}
          list={watchedRank}
          on:update={(e) => applyRankOrder(e.detail)}
          on:expand={openRanking}
          on:unwatch={(e) => toggleWatched(e.detail, false)}
          on:view={(e) => {
            // Double-click on watched item opens the pane
            selected = e.detail;
            showModal = true;
          }}
        />
      </div>
    </div>

    {#if watchedCollapsed && unwatchedCollapsed}
      <!-- Restore tab for Watched list (mobile only; shown on the same terms as
           the Unwatched one above) -->
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

    <!-- Nickname user picker panel (aligned with Watched sidebar). The whole top
         row folds it to a single line, so it can be cleared off the wheel's
         background without losing the settings; the body keeps its old spacing,
         so unfolding returns it to exactly the same size.
         Desktop-only ON PURPOSE: a folded bar floating over the wheel on phones
         and tablets was tried and judged clutter - the defaults serve there. -->
    <div class="absolute top-0 mt-0 w-52 max-h-[var(--area-size)] overflow-y-auto bg-base-200/90 rounded-lg shadow-lg p-3 text-sm z-30 hidden lg:block right-[calc(21rem+7px)]">
      <button
        type="button"
        class="w-full flex items-center justify-between gap-2 text-left font-semibold rounded hover:bg-base-300/60"
        data-options-toggle
        aria-expanded={!optionsCollapsed}
        aria-controls="randomize-options-body"
        title={optionsCollapsed ? 'Show these options' : 'Fold these options up'}
        on:click={toggleOptionsCollapsed}
      >
        <span class="min-w-0 truncate">
          Add Watched to:{#if optionsCollapsed}
            <span class="font-normal opacity-70 ml-1">{$options.addWatchedTo === 'BOTTOM' ? 'Bottom' : 'Top'}</span>
          {/if}
        </span>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          class="h-4 w-4 shrink-0 transition-transform duration-200"
          class:rotate-180={optionsCollapsed}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          stroke-width="2"
          aria-hidden="true"
        >
          <!-- Chevron pointing up (^): folds the panel; flipped when folded -->
          <path stroke-linecap="round" stroke-linejoin="round" d="M5 15l7-7 7 7" />
        </svg>
      </button>

      {#if !optionsCollapsed}
        <div id="randomize-options-body" class="space-y-1" data-options-body>
          <!-- Add watched position preference -->
          <div class="pt-2 mb-4 pb-3 border-b border-base-300">
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
      {/if}
    </div>

  {#if showModal && selected}
    <!-- The show REPLACES the wheel: a pane filling the wheel area, one
         fixed layout from the moment the spin lands (poster, a 16:9 video box,
         titles and actions on top). Watch only starts the video inside the box,
         so nothing moves. Sized from --area-size, so it never scrolls.
         The layout is built for a PC. On a phone (below `sm`) it is a
         full-screen sheet instead - see `.pane-box` in the styles. -->
    <div class="inline-card absolute inset-0 z-[35] lg:pr-[calc(21rem+7px)]" class:pane-tucked={sessionMode} data-inline-card>
      <div class="pane-box relative bg-base-100 rounded-box px-5 py-4 flex flex-col gap-3 {pickOpen ? 'overflow-y-auto' : 'overflow-hidden'}">
        <div class="pane-head relative shrink-0 flex items-start gap-3 h-12">
          <div class="min-w-0 flex-1">
            <h3 class="font-bold text-lg leading-tight truncate" title={selected.customName || getEnglishTitle(selected)}>
              {selected.customName || getEnglishTitle(selected)}
              {#if myRank != null}<span class="text-base font-normal opacity-70">(#{myRank})</span>{/if}
            </h3>
            <p class="text-sm text-base-content/70 truncate">
              {#if selected.customName}{getEnglishTitle(selected)}{/if}{#if selected.customName && !titlesAreSame(selected)} &middot; {/if}{#if !titlesAreSame(selected)}{getRomajiTitle(selected)}{/if}
            </p>
          </div>
          <button class="btn btn-sm btn-circle btn-ghost shrink-0" aria-label="Back to the wheel"
            title="Back to the wheel" data-popup-close on:click={() => (showModal = false)}>&#10005;</button>
        </div>

        {#if pickOpen}
          <!-- Pick mode has no right column to hold it, so the English title
               stays under the main one here. -->
          <p class="-mt-3 mb-1 text-base text-base-content/70">
            {getEnglishTitle(selected)}
          </p>
          <!-- Pick mode REPLACES the pane's body rather than floating over it.
               A dropdown inside a scrolling box (the old pop-up's
               `.modal-box`) produced two competing scrollbars, clipped the
               results, and pushed the actions out of reach. Here the results list owns
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
              placeholder="Search your library..." bind:value={pickTerm}
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
                    Searching...
                  {:else if pickTerm.trim()}
                    <!-- "Nothing matched" reads as a broken search. Name the
                         term and the honest reason: the library really may not
                         have it, and no amount of retyping will change that. -->
                    No match for &ldquo;{pickTerm.trim()}&rdquo; in your library - try a
                    shorter word, or the show may simply not be there yet.
                  {:else}
                    Type part of a title to search your library.
                  {/if}
                </li>
              {/each}
            </ul>
            <div class="flex justify-between items-center gap-2">
              <!-- Reversible by design: a pick a viewer can't undo is worse
                   than no pick. Always offered - "put it back" is a valid
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
        <!-- The pane's body - video (the poster is its cover until Watch),
             nicknames beside it, the episode line and buttons below. -->
        <div class="pane-grid flex-1 min-h-0" data-popup-body>
          <div class="pg-video">
            <div class="pane-video relative rounded overflow-hidden bg-black" data-video-box>
              {#if showPlayer && JellyfinPlayerModal && watchInfo?.itemId && watchInfo?.mediaSourceId}
                <svelte:component
                  this={JellyfinPlayerModal}
                  itemId={watchInfo.itemId}
                  mediaSourceId={watchInfo.mediaSourceId}
                  on:itemGone={onItemGone}
                />
              {:else}
                <!-- Before play: the poster, blurred, with the Watch button on it.
                     The library only serves 180px episode thumbnails, which would
                     blur worse stretched to this box. -->
                <div class="absolute inset-0 bg-center bg-cover scale-125 blur-xl opacity-70"
                  style="background-image: url({selected.coverImage?.extraLarge ?? selected.coverImage?.large ?? selected.coverImage?.medium});"></div>
                <!-- The poster IS the video's cover until Watch. -->
                <img class="absolute inset-y-0 left-1/2 -translate-x-1/2 h-full w-auto shadow-2xl" alt={getDisplayTitle(selected)}
                  src={selected.coverImage?.extraLarge ?? selected.coverImage?.large ?? selected.coverImage?.medium} />
                <div class="absolute inset-0 flex flex-col items-center justify-end gap-2 text-white text-center p-4">
                  {#if watchInfo?.available}
                    <button class="btn btn-accent btn-lg gap-2 shadow-lg" class:btn-disabled={openingPlayer} on:click={openPlayer} data-watch>
                      {#if openingPlayer}<span class="loading loading-spinner loading-sm"></span> Opening...{:else}<svg viewBox="0 0 24 24" class="w-5 h-5" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg> Watch{/if}
                      {#if watchInfo.seasonNumber != null && watchInfo.episodeNumber != null}S{watchInfo.seasonNumber}E{watchInfo.episodeNumber}{/if}
                    </button>
                  {:else if $mediaConfigured && watchInfo?.unknown}
                    <span class="opacity-80">Couldn't reach the media server - try again shortly</span>
                  {:else if $mediaConfigured && watchInfo?.notAired}
                    <span class="opacity-80" data-not-aired>Not aired yet</span>
                  {:else if $mediaConfigured && watchInfo && !watchInfo.available}
                    <span class="opacity-80">Not in library{watchInfo.libraryTitle ? ` (found "${watchInfo.libraryTitle}" but not this season)` : ''}</span>
                  {:else if $mediaConfigured}
                    <span class="loading loading-spinner loading-md"></span>
                  {:else}
                    <span class="opacity-70">No media server set up</span>
                  {/if}
                </div>
              {/if}
            </div>
          </div>
          <div class="pg-ep flex flex-col gap-1">
            <div class="ep-row flex items-center justify-between gap-3 text-sm h-5">
              <span class="min-w-0 truncate" data-episode-line
                title={watchInfo?.episodeTitle ?? ''}>
                {#if watchInfo?.available && watchInfo.seasonNumber != null && watchInfo.episodeNumber != null}
                  <span class="font-semibold">S{watchInfo.seasonNumber} E{watchInfo.episodeNumber}</span>{#if watchInfo.episodeTitle}<span class="opacity-80">&nbsp;&middot; {watchInfo.episodeTitle}</span>{/if}
                {/if}
              </span>
              {#if watchInfo?.available}
                <span class="shrink-0 text-xs opacity-50 whitespace-nowrap" data-speed-hint>
                  <kbd class="kbd kbd-xs">[</kbd> / <kbd class="kbd kbd-xs">]</kbd> change speed by 0.10&times;
                </span>
              {/if}
            </div>
            {#if watchInfo && ((watchInfo.matchedBy === 'title' && watchInfo.titleTier !== 0) || watchInfo.unverified
                || ($mediaConfigured && $authToken && !watchInfo.unknown && !watchInfo.notAired && !watchInfo.idConfident))}
              <div class="flex items-center gap-2 text-xs h-6">
                {#if (watchInfo.matchedBy === 'title' && watchInfo.titleTier !== 0) || watchInfo.unverified}
                  <span class="text-warning/80 truncate" title={`Matched to "${watchInfo.libraryTitle ?? ''}" without an id to confirm it.`}>&#9888; Might be the wrong show</span>
                {/if}
                {#if $mediaConfigured && $authToken && !watchInfo.unknown && !watchInfo.notAired && !watchInfo.idConfident}
                  <button class="btn btn-xs btn-outline normal-case shrink-0" data-pick-open on:click={openPicker}>
                    {watchInfo.available ? 'Not the right show?' : 'Find it in my library'}
                  </button>
                {/if}
              </div>
            {/if}
          </div>
          <div class="pg-nicks min-h-0 overflow-y-auto text-sm" data-nickname-col>
            <h4 class="font-semibold mb-1">Other users' nicknames</h4>
            <ul class="flex flex-col gap-1">
              {#each nicknameList.filter(n => $nicknameSelected.has(n.userName) && n.userName !== $activeUserName) as n}
                <li class="rounded bg-base-200 px-2 py-1" data-nickname-row={n.userName}>
                  <div class="flex items-baseline justify-between gap-2">
                    <span class="font-medium truncate">{n.userName}</span>
                    {#if n.rank != null}<span class="text-xs opacity-60 shrink-0">#{n.rank}</span>{/if}
                  </div>
                  {#if n.nickname}<div class="break-words leading-snug">{n.nickname}</div>{/if}
                </li>
              {:else}
                <li class="italic opacity-60">None selected</li>
              {/each}
            </ul>
          </div>
          <div class="pg-acts flex items-center gap-2" data-pane-actions>
              {#if placingId === selected.id}
                <!-- Same slots as before Rank it was pressed: Spin next takes Spin
                     again's place, and Rank it's place becomes a label - nothing
                     clickable sits where the second click of a double-click lands. -->
                <button class="btn btn-primary min-w-[8.5rem] ml-auto" data-spin-next
                  class:btn-disabled={!spinNextArmed} on:click={spinNext}>Spin next</button>
                <span class="min-w-[7.5rem] h-12 px-3 rounded-btn border-2 border-primary text-primary font-semibold flex items-center justify-center"
                  data-ranked-label>Ranked #<span class="inline-block min-w-[2ch] text-left tabular-nums">{placingRank ?? '?'}</span></span>
              {:else if selectedWatched}
                <button class="btn btn-secondary ml-auto" on:click={() => { showModal = false; toggleWatched(selected.id, false); }}>
                  Mark as Unwatched
                </button>
              {:else}
                <button class="btn btn-secondary mr-auto" data-popup-hide on:click={hideSelectedSeries}>
                  <span class="flex flex-col items-center leading-tight">
                    <span>Hide Series</span>
                    <span class="text-xs opacity-70">(Unwatched)</span>
                  </span>
                </button>
                <button class="btn btn-outline min-w-[8.5rem]" on:click={spinNext}>Spin again</button>
                <button class="btn btn-primary min-w-[7.5rem]" data-rank-it on:click={rankIt}>Rank it</button>
              {/if}
          </div>
        </div>
        {/if}
      </div>
    </div>
  {/if}
  {#if rankExpanded}
    <div class="inline-card hidden lg:block absolute inset-0 z-[44] lg:pr-4" class:pane-tucked={sessionMode}>
      <div style="height: var(--area-size);">
        <RankingExpanded
          bind:this={rankExpandedRef}
          list={watchedRank}
          {placingId}
          {spinNextArmed}
          videoPaused={pausedByExpand}
          on:update={(e) => applyRankOrder(e.detail)}
          on:collapse={collapseRanking}
          on:spinnext={spinNext}
          on:view={(e) => { rankExpanded = false; selected = e.detail; showModal = true; }}
        />
      </div>
    </div>
  {/if}
  </div> <!-- end flex container (it closes below the show pane, which overlays the wheel area) -->

  <!-- Image Upload Modal -->
  {#if showImageUploadModal}
    <dialog open class="modal">
      <div class="modal-box w-full max-w-2xl">
        <button class="btn btn-sm btn-circle btn-ghost absolute right-2 top-2" aria-label="Close"
                on:click={() => showImageUploadModal = false}>&#10005;</button>

        <h3 class="font-bold text-lg mb-4">Upload Custom Images</h3>

        <!-- An image too big for sessionStorage used to fail silently: nothing
             stored, nothing said, and the modal wedged. -->
        {#if imageStoreError}
          <p class="text-sm text-error mb-4" data-image-too-large>{imageStoreError}</p>
        {/if}

        <!-- Spin Button Image Section -->
        <div class="mb-6">
          <h4 class="font-semibold mb-2">Spin Button Image</h4>
          <div class="flex flex-col gap-2">
            {#if spinButtonImage}
              <div class="relative w-32 h-32 mx-auto">
                <img src={spinButtonImage} alt="Spin button preview" class="w-full h-full object-cover rounded-full" />
                <button class="btn btn-xs btn-circle btn-error absolute -top-2 -right-2" aria-label="Remove spin button image"
                        on:click={() => spinButtonImage = null}>&#10005;</button>
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
                <button class="btn btn-xs btn-circle btn-error absolute -top-2 -right-2" aria-label="Remove background image"
                        on:click={() => backgroundImage = null}>&#10005;</button>
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
    class="upload-btn btn btn-sm btn-outline absolute bottom-4 z-20 normal-case hidden lg:block"
    class:upload-tucked={sessionMode}
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
  /* Two sizes, deliberately separate. `--area-size` is the wheel area's
     height, and the docked lists stretch to it (`top-0 bottom-0`), as does the
     background: it follows the window's HEIGHT only. 132px is the header and
     season selector above it with an 8px gap under each of the selector and the
     page; it was 195px while a 56px gap sat under the selector and 23px of
     nothing under the page, which the show pane - now the same size as the
     wheel area - made obvious. `--wheel-size` is the wheel itself:
     the same, and from `lg` also no wider than the space between the DOCKED
     lists (16rem + 7px on the left, 20rem from `3cols`; 21rem + 7px on the
     right), the 2rem pull-out strip beside the Unwatched list, and 2rem
     more. Without that cap, narrowing a desktop window slid the
     wheel under the lists (247px of it at 1100x950). With ONE variable for
     both, the cap also shrank the area, and the lists with it - 760px tall at
     1600x950, 391px at 1024x950 - for a change that was only ever about width.
     Below `lg` the lists slide over the page, so the full width is the wheel's. */
  .wheel-area {
    --area-size: min(95vmin, calc(100dvh - 132px));
    --wheel-size: var(--area-size);
  }
  @media (min-width: 1024px) {
    .wheel-area {
      --wheel-size: min(var(--area-size), calc(100vw - 39rem - 14px - 2rem));
    }
  }
  @media (min-width: 1732px) {
    .wheel-area {
      --wheel-size: min(var(--area-size), calc(100vw - 43rem - 14px - 2rem));
    }
  }

  /* Session layout on desktop: after the first spin the Unwatched list tucks
     away behind a pull-out strip and the wheel area takes the space. */
  @media (min-width: 1024px) {
    .wheel-area { padding-left: calc(16rem + 7px + 2rem); }
    .wheel-area.session-pad { padding-left: 2.5rem; }
    .desk-docked { transform: translateX(2rem); }
    /* The wheel glides into the freed space with the list's own slide
       (Tailwind's duration-300 + default ease) instead of jumping. */
    .wheel-area { transition: padding-left 300ms cubic-bezier(0.4, 0, 0.2, 1); }
    .session-tucked { transform: translateX(-100%); }
  }
  @media (min-width: 1732px) {
    .wheel-area { padding-left: calc(20rem + 7px + 2rem); }
    .wheel-area.session-pad { padding-left: 2.5rem; }
  }
  /* The show pane starts beside the Unwatched list when it is docked
     (opening a show from the list during setup put the pane UNDER the list,
     hiding the poster) and beside the strip when tucked - same glide. */
  @media (min-width: 1024px) {
    .inline-card { padding-left: calc(16rem + 7px + 2rem); transition: padding-left 300ms cubic-bezier(0.4, 0, 0.2, 1); }
    .inline-card.pane-tucked { padding-left: 2.5rem; }
  }
  @media (min-width: 1732px) {
    .inline-card { padding-left: calc(20rem + 7px + 2rem); }
    .inline-card.pane-tucked { padding-left: 2.5rem; }
  }
  /* Upload Images sits 1rem right of the list's edge and glides with it. */
  @media (min-width: 1024px) {
    .upload-btn { left: calc(16rem + 7px + 2rem + 1rem); transition: left 300ms cubic-bezier(0.4, 0, 0.2, 1); }
    .upload-btn.upload-tucked { left: 3.5rem; }
  }
  @media (min-width: 1732px) {
    .upload-btn { left: calc(20rem + 7px + 2rem + 1rem); }
    .upload-btn.upload-tucked { left: 3.5rem; }
  }
  /* The show pane. The video cell is a size container, so the 16:9 box is
     as large as its cell allows and never overflows it. Its column is as wide
     as a video of the row's height needs (the row is the pane less its header,
     the episode line, the buttons and the gaps: area less 11.5rem), and the
     nicknames take everything left - at least 14rem. A fixed 14rem column left
     ~100px of nothing between a height-bound video and the nicknames. */
  .inline-card { --pane-video-h: calc(var(--area-size) - 11.5rem); }
  .pane-box { height: var(--area-size); }
  .pane-grid {
    display: grid; gap: 0.75rem 1rem;
    grid-template-columns: min(calc(var(--pane-video-h) * 16 / 9), calc(100% - 15rem)) minmax(14rem, 1fr);
    grid-template-rows: 1fr auto auto;
    grid-template-areas: "video nicks" "ep nicks" "acts acts";
  }
  .pane-grid > * { min-width: 0; min-height: 0; }
  .pg-video { grid-area: video; container-type: size; }
  .pg-video .pane-video { width: min(100cqw, calc(100cqh * 16 / 9)); aspect-ratio: 16 / 9; }
  .pg-ep { grid-area: ep; }
  .pg-nicks { grid-area: nicks; }
  .pg-acts { grid-area: acts; justify-content: flex-end; align-self: end; }

  /* Phones get a full-screen sheet, as the old pop-up was. The pane above is a
     PC layout: at 375px its nickname column took everything but 95px, so the
     poster and Watch were a thumbnail, Hide sat 31px off the left edge, and a
     show opened from the Unwatched list stayed UNDER that list (z-40) with all
     three buttons covered. Here it sits over the lists and their edge tabs,
     stacks video -> episode -> buttons -> nicknames so the buttons are reached
     without scrolling, and scrolls under a pinned title row. */
  @media (max-width: 639.98px) {
    .inline-card { position: fixed; inset: 0; z-index: 60; padding: 0; }
    .pane-box {
      height: 100dvh; border-radius: 0; padding-top: 0;
      overflow-y: auto; overscroll-behavior: contain;
    }
    .pane-head {
      position: sticky; top: 0; z-index: 10; height: auto;
      padding-top: 1rem; padding-bottom: 0.5rem;
      background-color: hsl(var(--b1));
    }
    .pane-grid { display: flex; flex-direction: column; flex: none; }
    .pg-video { order: 1; container-type: normal; }
    .pg-video .pane-video { width: 100%; }
    .pg-ep { order: 2; }
    .ep-row { height: auto; flex-wrap: wrap; }
    .pg-acts { order: 3; align-self: stretch; }
    .pg-acts > :global(*) { flex: 1 1 0; min-width: 0; margin: 0; padding-inline: 0.5rem; }
    .pg-nicks { order: 4; overflow: visible; }
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
