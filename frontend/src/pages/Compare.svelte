<script lang="ts">
  import { onMount, tick } from 'svelte';
  import SeasonSelect, { type Season } from '../components/SeasonSelect.svelte';
  import { authToken, userName } from '../stores/auth';
import { seasonYear } from '../stores/season';
import { get } from 'svelte/store';
import { options } from '../stores/options';
import LoadingSpinner from '../components/LoadingSpinner.svelte';
import { apiJson, QUICK } from '../lib/remote';
// Reactive trigger for title-language changes
$: _lang = $options.titleLanguage;
  // combobox component
  import Select from 'svelte-select';
  import 'svelte-select/tailwind.css';

const rankOptions = [
  { value: 'pre', label: 'Pre-watch' },
  { value: 'post', label: 'Post-watch' }
] as const;

  // ----------------------------------------------------------------------------
  // Local state - season/year/user selection
  // ----------------------------------------------------------------------------

  let season: Season = get(seasonYear).season;
  let year: number = get(seasonYear).year;

  // Propagate local edits to the shared store
  let _lastKey = `${season}-${year}`;
  $: {
    const key = `${season}-${year}`;
    if (key !== _lastKey) {
      _lastKey = key;
      seasonYear.set({ season, year });
    }
  }

  // User A is always the currently logged-in user
  let userA: string | null = null;

  // ------------------------------------------------------------------
  // User B selection - auto-complete dropdown
  // ------------------------------------------------------------------

  let otherInput = '';
  // selectedOther may be a primitive string or an object returned by svelte-select
  let selectedOther: any = null;

  // suggestion list for combobox
  /**
   * Options for the second-user combobox.
   *
   * Declared as `string[]` until now, which was simply untrue - every write puts
   * `{ value, label }` in and every read uses `.value`. svelte-check had two
   * standing errors from that mismatch; typing it honestly clears both.
   */
  let suggestions: Array<{ value: string; label: string }> = [];
  // load matching users (debounced)
  /**
   * The query the current `suggestions` were fetched for. Needed to tell "no
   * such user" from "we haven't asked yet" - an unknown name returns an *empty*
   * list, which is indistinguishable from the initial state without this.
   */
  let suggestionsFor: string | null = null;

  /** Set when the user list couldn't be fetched, so the box isn't silently empty. */
  let userSearchFailed = false;

  async function fetchSuggestions() {
    const q = otherInput.trim();
    const url = q ? `/api/users?q=${encodeURIComponent(q)}` : `/api/users`;
    try {
      // A failure here used to be swallowed whole: the picker stayed empty with
      // no explanation, *and* the "No user named..." warning could never fire,
      // because it keys off a completed fetch. So a broken /api/users looked
      // exactly like a username that doesn't exist.
      const users = await apiJson<string[]>(url, undefined, { label: 'users', timeoutMs: QUICK });
      suggestions = users.map((u) => ({ value: u, label: u }));
      suggestionsFor = q;
      userSearchFailed = false;
    } catch {
      userSearchFailed = true; // apiJson logged the reason
    }
  }
  let suggestTimer: any;
  function queueSuggest() {
    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(fetchSuggestions, 250);
  }

  /**
   * Re-query as the user types.
   *
   * Driven off the bound `filterText` rather than an event, because the event
   * route failed silently in both directions: this was `bind:searchText` with
   * `on:search`, and svelte-select 5 has neither - it exposes `filterText` and
   * dispatches `filter`/`input`. So the box never sent what was typed, the
   * suggestion list stayed as the unfiltered top slice from `/api/users`, and
   * anyone outside it simply could not be picked. A reactive statement on a
   * bound prop cannot rot the way a mistyped event name does.
   */
  $: otherInput, queueSuggest();

  /**
   * The combobox only writes `selectedOther` when a real suggestion is picked,
   * so typing a name that doesn't exist left the *previous* user's ranks on
   * screen under a heading naming them - it read as "this is what they rated".
   * Flag it instead: the typed text is non-empty, the suggestions have caught up
   * with it, and none of them match.
   */
  $: typedOther = otherInput.trim();
  $: unknownOtherUser =
    typedOther.length > 0 &&
    getSelectedUsername(selectedOther) !== typedOther &&
    // "We asked about exactly this text and the server matched nobody."
    // Gating on an empty list rather than on the absence of an *exact* match
    // matters: `/api/users?q=` is a prefix search, so mid-typing ("droh" on the
    // way to "drohack") still returns candidates and must stay quiet. Gating on
    // `suggestionsFor` rather than `suggestions.length > 0` matters too - an
    // unknown name is precisely the case that comes back empty.
    suggestionsFor === typedOther &&
    suggestions.length === 0;

// ------------------------------------------------------------------
// Reactive: fetch lists whenever any of the input parameters change, but
// avoid redundant duplicate calls that happen during component mount when
// `bind:value` re-assigns the same default values back to rankTypeA/B.
// ------------------------------------------------------------------

let lastFetchKey: string | null = null;

$: if (userA) {
  // track dependencies so Svelte re-runs when they change
  rankTypeA;
  rankTypeB;
  season;
  year;

  // getSelectedUsername() returns '' for null/unset, so the cache key
  // stays unique across the "solo" and "compare" states.
  const key = `${userA}|${getSelectedUsername(selectedOther)}|${rankTypeA}|${rankTypeB}|${season}|${year}`;
  if (key !== lastFetchKey) {
    lastFetchKey = key;
    fetchLists();
  }
}


  // selectedOther can be a primitive string or an svelte-select object ({ value, label, ... }).
  // This helper normalises to a plain username string.
  function getSelectedUsername(val: any): string {
    if (typeof val === 'string') return val;
    return val?.value ?? val?.label ?? '';
  }

  // Display-friendly other username (handles string or object)
  $: displayOther = getSelectedUsername(selectedOther);
  
  // Lists fetched from backend (raw WatchList rows)
  type WatchRow = {
    mediaId: number;
    order: number;
    customName: string | null;
    watchedRank?: number | null;
  };

  let listA: WatchRow[] | null = null;
  let listB: WatchRow[] | null = null;

// Ranking type selection ('pre' vs 'post') for each user
let rankTypeA: 'pre' | 'post' = 'pre';
let rankTypeB: 'pre' | 'post' = 'pre';

  // Full anime payload for current season (needed for titles & covers)
  let animeData: Array<any> = [];

  let loading = false;
  let error: string | null = null;

  /* --------------------------------------------------------------------------
   * Share-as-image functionality (clone & export as JPEG)
   * -----------------------------------------------------------------------*/

  // Wrapper that contains the compare header + table (bound in markup)
  let captureEl: HTMLElement;

  async function shareCompare() {
    if (!captureEl) return;

    let clone = captureEl.cloneNode(true) as HTMLElement;

    // Off-screen wrapper to keep the clone invisible
    const wrapper = document.createElement('div');
    Object.assign(wrapper.style, {
      position: 'absolute',
      top: '0',
      left: '-10000px',
      overflow: 'hidden',
      margin: '0'
    } as Partial<CSSStyleDeclaration>);
    wrapper.appendChild(clone);
    document.body.appendChild(wrapper);

    /* Tighten layout on the clone only; the explicit width assignment below
       (clone.style.width = 'max-content') overrides any tailwind width classes. */

    // Reduce gaps between cells
    clone.querySelectorAll('[style*="gap:"]').forEach((el) => {
      (el as HTMLElement).style.gap = '4px';
    });

    // Prevent title wrapping for minimal width
    clone.querySelectorAll('[title]').forEach((el) => {
      (el as HTMLElement).style.whiteSpace = 'nowrap';
    });

    // Let content dictate width
    clone.style.width = 'max-content';

    // Hide share button inside the clone so it doesn’t appear in the output
    const shareBtn = clone.querySelector('[data-share-btn]') as HTMLElement | null;
    if (shareBtn) shareBtn.style.display = 'none';

    /* ------------------------------------------------------------------
     * Capture selected labels BEFORE cloning so we don’t rely on copying
     * values afterwards (which was still failing due to DaisyUI styling).
     * We store an array of strings in the same order as the <select>s.
     * ----------------------------------------------------------------*/
    const liveSelectEls = Array.from(captureEl.querySelectorAll('select')) as HTMLSelectElement[];
    const liveLabels = liveSelectEls.map((sel) => sel.selectedOptions[0]?.textContent ?? sel.value);

    // Now clone after we have the labels
    const freshClone = captureEl.cloneNode(true) as HTMLElement;
    wrapper.replaceChild(freshClone, clone);
    clone = freshClone; // update reference for later steps

    // Replace selects in the new clone with spans containing remembered labels
    clone.querySelectorAll('select').forEach((sel, idx) => {
      const span = document.createElement('span');
      span.textContent = liveLabels[idx] ?? '';
      span.style.padding = '2px 6px';
      span.style.borderRadius = '4px';
      span.style.background = 'rgba(0,0,0,0.08)';
      span.style.fontSize = '0.75rem';
      span.style.fontWeight = '500';
      span.style.whiteSpace = 'nowrap';
      (sel as HTMLElement).replaceWith(span);
    });

    // Ensure all title cells keep on one line (no wrapping)
    clone.querySelectorAll('div[title]').forEach((el) => {
      (el as HTMLElement).style.whiteSpace = 'nowrap';
    });

    // Wait a tick for select-replacement layout changes to settle before
    // measuring size later.
    await tick();

    // Add explicit right-side padding so the capture has breathing room.
    clone.style.paddingRight = '12px';

    // Hide remote images to avoid CORS-tainted canvas
    const posters: HTMLImageElement[] = Array.from(clone.querySelectorAll('img'));
    const posterDisplay = posters.map((p) => p.style.display);
    posters.forEach((p) => (p.style.display = 'none'));

    // Global border fix - remove default white borders some components gain
    // when CSS variables aren’t resolved in the cloned DOM (mirrors My List).
    const borderFix = document.createElement('style');
    borderFix.textContent = '*{border-color:transparent !important;}';
    clone.prepend(borderFix);

    // Remove external stylesheets that cause CORS issues (e.g. Google Fonts)
    clone.querySelectorAll('link[rel="stylesheet"]').forEach((lnk) => {
      const href = (lnk as HTMLLinkElement).href;
      if (href.startsWith('https://fonts.googleapis.com')) lnk.remove();
    });

    await tick();

    // Dimensions will be recalculated after final tweaks later.

    // Declared before the try so the finally can always re-enable the sheets,
    // even if an early await (the dynamic import) throws - otherwise the finally
    // throws a ReferenceError and the off-screen clone leaks into the DOM.
    const disabledSheets: CSSStyleSheet[] = [];

    try {
      // Lazy-load dom-to-image-more so it only ships in a chunk when the user
      // clicks share. Bundled locally (previously loaded from a CDN).
      const mod = await import('dom-to-image-more');
      const toJpeg = (mod.toJpeg ?? mod.default?.toJpeg) as (
        node: HTMLElement,
        opts: any
      ) => Promise<string>;

      // Temporarily disable cross-origin Google Fonts stylesheets to avoid
      // SecurityError when dom-to-image enumerates cssRules.
      Array.from(document.styleSheets).forEach((ss) => {
        const href = (ss as CSSStyleSheet).href;
        if (href && href.startsWith('https://fonts.googleapis.com')) {
          disabledSheets.push(ss as CSSStyleSheet);
          (ss as any).disabled = true;
        }
      });

      // Determine a reasonable background colour - prefer the first cell’s
      // background; fallback to the document body.
      let bgOverride = getComputedStyle(document.body).backgroundColor || '#ffffff';
      const firstCell = clone.querySelector('div,header') as HTMLElement | null;
      if (firstCell) {
        const tmp = getComputedStyle(firstCell).backgroundColor;
        if (tmp && tmp !== 'rgba(0, 0, 0, 0)' && tmp !== 'transparent') {
          bgOverride = tmp;
        }
      }

      // Measure final dimensions after all tweaks
      // Re-measure final size and add small buffer so right/bottom aren’t cut
      let { width: captureWidth, height: captureHeight } = wrapper.getBoundingClientRect();
      // Add generous right-side buffer so nothing appears flush/cut.
      captureWidth += 40; // 40-px padding on right
      captureHeight += 4;

      wrapper.style.width = `${captureWidth}px`;
      wrapper.style.height = `${captureHeight}px`;

      const dataUrl = await toJpeg(wrapper, {
        bgcolor: bgOverride,
        quality: 0.95,
        cacheBust: true,
        pixelRatio: 2,
        width: captureWidth,
        height: captureHeight
      });

      const w = window.open();
      if (w) {
        w.document.open();
        w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8" /><title>Compare</title><style>html,body{margin:0;padding:0;display:flex;justify-content:center;align-items:center;height:100vh;background:#fff} img{max-width:100vw;max-height:100vh;width:auto;height:auto}</style></head><body><img src="${dataUrl}" alt="Compare" /></body></html>`);
        w.document.close();
      }
    } catch (e) {
      console.error('Failed to export compare view', e);
    } finally {
      // Ensure sheets re-enabled even on error
      disabledSheets.forEach((ss) => ((ss as any).disabled = false));
      posters.forEach((p, i) => (p.style.display = posterDisplay[i]));
      borderFix.remove();
      wrapper.remove();
    }
  }

  // Fetch helper -------------------------------------------------------------

  async function fetchLists() {
    if (!userA) return;

    loading = true;
    error = null;
    try {
      const usernameA = getSelectedUsername(userA);
      const usernameB = selectedOther ? getSelectedUsername(selectedOther) : null;

      // User A is always the authenticated current user, so fetch their own
      // list via the authenticated endpoint - it isn't gated by hideFromCompare
      // (the public endpoint now 404s opted-out users, which would otherwise
      // break the user's own Compare page). User B (someone else) still uses
      // public-list, which correctly 404s a user who opted out.
      const animePromise = fetch(`/api/anime?season=${season}&year=${year}`);
      const aPromise = $authToken
        ? fetch(`/api/list?season=${season}&year=${year}`, { headers: { Authorization: `Bearer ${$authToken}` } })
        : fetch(`/api/public-list?username=${encodeURIComponent(usernameA)}&season=${season}&year=${year}&type=${rankTypeA}`);
      const bPromise = usernameB
        ? fetch(`/api/public-list?username=${encodeURIComponent(usernameB)}&season=${season}&year=${year}&type=${rankTypeB}`)
        : Promise.resolve(null);

      const [aResp, bResp, animeResp] = await Promise.all([aPromise, bPromise, animePromise]);

      if (!aResp.ok) throw new Error(`Failed to fetch your list (${aResp.status})`);

      // A saved comparison target who has since enabled hideFromCompare now
      // 404s - clear the stale selection and drop the comparison rather than
      // wedging the page on an error every load.
      if (bResp && bResp.status === 404) {
        try { localStorage.removeItem('compare-other'); } catch {}
        selectedOther = null;
        otherInput = '';
        listB = [];
      } else if (bResp && !bResp.ok) {
        throw new Error(`Failed to fetch other list (${bResp.status})`);
      }

      let rowsA = (await aResp.json()) ?? [];
      // When A came from the authenticated /api/list it's raw (order asc);
      // apply the same pre/post ordering the public endpoint applies server-side.
      if ($authToken && Array.isArray(rowsA)) {
        if (rankTypeA === 'post') {
          rowsA = rowsA
            .filter((r: any) => r.watched)
            .sort((a: any, b: any) =>
              (a.watchedRank ?? Number.MAX_SAFE_INTEGER) - (b.watchedRank ?? Number.MAX_SAFE_INTEGER)
              || (new Date(a.watchedAt ?? 0).getTime() - new Date(b.watchedAt ?? 0).getTime()));
        } else {
          rowsA = [...rowsA].sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0));
        }
      }
      listA = rowsA;
      listB = bResp && bResp.ok ? ((await bResp.json()) ?? []) : (listB ?? []);
      animeData = (await animeResp.json()) ?? [];
    } catch (e: any) {
      console.error(e);
      error = e.message ?? 'Failed to fetch';
    } finally {
      loading = false;
    }
  }

  // kick initial userA on mount / auth change
  $: userA = $userName;

  // ------------------------------------------------------------------
  // Logout handler - when the auth token disappears we should:
  //   • Clear any stored comparison target in localStorage.
  //   • Reset local component state (selectedOther, lists, etc.).
  //   • Navigate the user back to the main anime page (/).
  // ------------------------------------------------------------------

  $: if (!$authToken) {
    // Clear persisted compare user
    try {
      localStorage.removeItem('compare-other');
    } catch {}

    // Reset local UI state
    selectedOther = null;
    otherInput = '';
    suggestions = [];
    listA = null;
    listB = null;

    // If currently on /compare, redirect to home page.
    if (typeof window !== 'undefined' && window.location.pathname === '/compare') {
      history.replaceState({}, '', '/');
      dispatchEvent(new PopStateEvent('popstate'));
    }
  }

  // restore previous comparison target from localStorage and seed the dropdown
  onMount(async () => {
    const prev = localStorage.getItem('compare-other');
    if (prev) {
      // Restore previously selected user but keep the search box blank so the
      // full user list is shown when the dropdown is opened.

      selectedOther = { value: prev, label: prev }; // wrap as object
      otherInput = '';

      try {
        await fetchSuggestions(); // fetch all users
        if (!suggestions.some((s) => s.value === prev)) {
          suggestions = [{ value: prev, label: prev }, ...suggestions];
        }
      } catch {
        /* ignore */
      }

      fetchLists();
    }
  });

  // preload all users for the dropdown combobox
  queueSuggest();
  
  // ----------------------------------------------------------------------------
  // Persist comparison target to localStorage
  //
  // This block used to run as soon as the component module was evaluated, i.e.
  // before `onMount`.  At that time `selectedOther` is still `null`, so we
  // ended up calling `localStorage.removeItem('compare-other')` and erasing the
  // value we actually wanted to restore on first render.
  //
  // We now wait until the component is mounted in the browser (signalled by
  // the `mounted` flag) before running the persistence logic.
  // ----------------------------------------------------------------------------

  let mounted = false;
  onMount(() => (mounted = true));

  // Auto-set rank types when comparing with self
  let lastOther: string | null = null;
  $: {
    const other = getSelectedUsername(selectedOther) || null;

    if (other !== lastOther) {
      lastOther = other;

      if (other && userA && other === userA) {
        rankTypeA = 'pre';
        rankTypeB = 'post';
      }
    }
  }

  $: if (mounted) {
    const val = getSelectedUsername(selectedOther);

    if (val) {
      localStorage.setItem('compare-other', val);
    } else {
      localStorage.removeItem('compare-other');
    }
  }
  
  // Derived helpers ----------------------------------------------------------

  interface RankedItem {
    id: number;
    title: string;
    cover: string;
    rankA: number | null; // 1-based rank in listA (null = not present)
    rankB: number | null; // 1-based rank in listB
    diff: number | null;  // |rankA‒rankB|
    // custom names from each user's list
    customA: string | null;
    customB: string | null;
  }

  /**
   * Generate display title based on user preference and fallback values.
   * Safe against missing anime entries.
   */
  function getDisplayTitle(anime: any | undefined): string {
    if (!anime?.title) return '';
    const lang = $options.titleLanguage;
    if (lang === 'ROMAJI') return anime.title.romaji || anime.title.english || anime.title.native || '';
    if (lang === 'NATIVE') return anime.title.native || anime.title.english || anime.title.romaji || '';
    return anime.title.english || anime.title.romaji || anime.title.native || '';
  }
  function buildRows(): RankedItem[] {
    // Only user A is required; listB may be null/empty when no 2nd user is
    // selected, in which case rankB stays null and diff stays null.
    if (!listA) return [];

    const byId = new Map<number, RankedItem>();

    function upsertRow(mediaId: number): RankedItem {
      let row = byId.get(mediaId);
      if (!row) {
      const animeEntry = animeData.find((a) => a.id === mediaId);
        // Derive display fields safely
        const displayTitle = getDisplayTitle(animeEntry) || 'Unknown';
        const displayCover = (animeEntry?.coverImage?.medium || animeEntry?.coverImage?.large) || '';
        row = {
          id: mediaId,
          title: displayTitle,
          cover: displayCover,
          rankA: null,
          rankB: null,
          diff: null,
          customA: null,
          customB: null
        };
        byId.set(mediaId, row);
      }
      return row;
    }

    listA.forEach((row, idx) => {
      const item = upsertRow(row.mediaId);
      item.rankA = idx + 1;
      // preserve custom name if set by user A
      item.customA = row.customName;
    });

    (listB ?? []).forEach((row, idx) => {
      const item = upsertRow(row.mediaId);
      item.rankB = idx + 1;
      // preserve custom name if set by user B
      item.customB = row.customName;
    });

    // compute diff
    byId.forEach((item) => {
      if (item.rankA != null && item.rankB != null) {
        item.diff = Math.abs(item.rankA - item.rankB);
      }
    });

    const arr = Array.from(byId.values());

    // default sort by diff ascending
    arr.sort((a, b) => {
      const d1 = a.diff ?? 1e9;
      const d2 = b.diff ?? 1e9;
      return d1 - d2;
    });

    return arr;
  }

  let sortMode: 'title' | 'rankA' | 'rankB' | 'diff' = 'rankA';
  // Rows to render, rebuilt reactively when lists or sort mode change
  let rows: RankedItem[] = [];

  // Reactive block: rebuild rows when lists, animeData, or sortMode change
  $: {
    // Re-run when title language changes as well
    const lang = $options.titleLanguage;
    listA;
    listB;
    animeData;
    const data = buildRows();
    // sort based on selected mode
    if (sortMode === 'title') {
      data.sort((a, b) => a.title.localeCompare(b.title));
    } else if (sortMode === 'rankA') {
      data.sort((a, b) => (a.rankA ?? Infinity) - (b.rankA ?? Infinity));
    } else if (sortMode === 'rankB') {
      data.sort((a, b) => (a.rankB ?? Infinity) - (b.rankB ?? Infinity));
    }
    // diff: default order from buildRows
    rows = data;
  }
  
  // Maximum diff, used for color gradient scaling
  let maxDiff: number = 0;
  $: maxDiff = rows.reduce((m, r) => Math.max(m, r.diff ?? 0), 0);

  /**
   * Compute a color on a green-to-red gradient based on diff vs maxDiff.
   */
  function heat(diff: number | null): string {
    if (diff == null) return 'rgba(255,255,255,0.04)';
    if (maxDiff <= 0) return 'hsl(145 70% 45%)';
    const ratio = Math.min(diff / maxDiff, 1);
    const hue = 145 - ratio * 145; // 145=green to 0=red
    return `hsl(${hue} 70% 45%)`;
  }
  /**
   * Choose white or black text for contrast over the heat background.
   */
  function textColor(diff: number | null): string {
    if (diff == null) return 'inherit';
    if (maxDiff <= 0) return 'black';
    const ratio = Math.min(diff / maxDiff, 1);
    return ratio > 0.5 ? 'white' : 'black';
  }
  
</script>
{#if !$authToken}
  <p class="p-6 text-red-500">You must be logged-in to compare lists.</p>
{:else}
  <!-- Season/year header (plain wrapper, left-aligned - matches the pattern on Home and Randomize).
       Kill SeasonSelect's internal mb-6 on mobile only (desktop keeps the 24px gap to the user controls). -->
  <div class="w-full sm:max-w-[calc(100vw-32rem)] 2cols:sm:max-w-[calc(100vw-40rem)] sm:mx-auto [&>div]:!mb-0 md:[&>div]:!mb-6">
    <SeasonSelect
      bind:season
      bind:year
      showListToggle={false}
      showSequelToggle={false}
      showSearch={false}
    />
  </div>

  <!-- User comparison controls: 2-col 3-row grid (plain, left-aligned like the season row)
       Row 1:  (empty)             | "2nd user:" label
       Row 2:  "{$userName}:" label | 2nd-user combobox
       Row 3:  pre/post for $userName | pre/post for 2nd user (shown once selected) -->
  <div class="w-full sm:max-w-[42rem] lg:max-w-[54rem] 2xl:max-w-[64rem] sm:mx-auto">
    <div class="w-full max-w-sm md:max-w-md mx-auto grid grid-cols-2 gap-x-3 gap-y-1 text-sm items-center">
      <!-- Row 1 -->
      <div></div>
      <label for="otherUser" class="font-semibold">2nd user:</label>

      <!-- Row 2 -->
      <div class="font-semibold truncate" title={$userName ?? ''}>{$userName}:</div>
      <div class="min-w-0">
        <Select
          id="otherUser"
          class="w-full input input-bordered text-gray-700"
          dropdownClass="w-full"
          items={suggestions}
          bind:filterText={otherInput}
          bind:value={selectedOther}
          placeholder="username"
          noOptionsMessage="No users found"
          searchable={true}
          inputAttributes={{ 'data-bwignore': true }}
          on:change={() => {/* fetch triggered reactively */}}
        />
        {#if userSearchFailed}
          <!-- Distinct from "no such user": the list never arrived, so we can't
               say whether the name exists. Claiming the latter would be a lie. -->
          <p class="text-xs text-warning mt-1" data-user-search-failed>
            Couldn't load the user list
            <button type="button" class="btn btn-xs btn-outline normal-case ml-1" on:click={fetchSuggestions}>
              Retry
            </button>
          </p>
        {:else if unknownOtherUser}
          <!-- Without this, a typo leaves the previously-compared user's ranks
               on screen and reads as if they belonged to the name just typed. -->
          <p class="text-xs text-error mt-1" data-unknown-user>
            No user named &ldquo;{typedOther}&rdquo;
          </p>
        {/if}
      </div>

      <!-- Row 3 -->
      <select bind:value={rankTypeA} class="select select-sm select-bordered w-full">
        {#each rankOptions as opt}
          <option value={opt.value}>{opt.label}</option>
        {/each}
      </select>
      <div class="min-w-0">
        {#if selectedOther}
          <select bind:value={rankTypeB} class="select select-sm select-bordered w-full">
            {#each rankOptions as opt}
              <option value={opt.value}>{opt.label}</option>
            {/each}
          </select>
        {/if}
      </div>
    </div>
  </div>

  {#if loading}
    <div class="w-full sm:max-w-[42rem] lg:max-w-[54rem] 2xl:max-w-[64rem] sm:mx-auto"><LoadingSpinner size="lg" /></div>
  {:else if error}
    <p class="p-4 w-full sm:max-w-[42rem] lg:max-w-[54rem] 2xl:max-w-[64rem] sm:mx-auto text-red-500">{error}</p>
  {:else if rows.length}
    <!-- Legend: gradient and direction arrows (desktop only).
         Kept visible in solo mode too so switching between solo and compare
         doesn't reflow the page vertically. -->
    <div class="hidden md:block w-full sm:max-w-[42rem] lg:max-w-[54rem] 2xl:max-w-[64rem] sm:mx-auto p-2 text-sm space-y-2">
      <div class="font-semibold">Rank difference gradient:</div>
      <div class="h-2 w-full rounded" style="background: linear-gradient(to right, hsl(145 70% 45%), hsl(0 70% 45%));"></div>
      <div class="flex items-center gap-6">
        <div class="flex items-center gap-1"><span class="font-mono">0</span><span>= same rank</span></div>
        <div class="flex items-center gap-1"><span class="font-mono">&larr;</span><span>= you ranked higher</span></div>
        <div class="flex items-center gap-1"><span class="font-mono">&rarr;</span><span>= other ranked higher</span></div>
      </div>
    </div>
    <!-- Capture wrapper starts -->
    <div bind:this={captureEl}>
    <header class="w-full sm:max-w-[42rem] lg:max-w-[54rem] 2xl:max-w-[64rem] sm:mx-auto p-2 grid grid-cols-[1fr_auto] items-center gap-2">
      <h2 class="text-xl font-bold text-left leading-tight">
        {#if selectedOther}
          {$userName} vs {displayOther} - {season} {year}
        {:else}
          {$userName} - {season} {year}
        {/if}
      </h2>
      <label class="text-sm justify-self-end flex items-center gap-1 whitespace-nowrap">Sort:
        <select bind:value={sortMode} class="select md:select-sm ml-1">
          <option value="title">Title</option>
          <option value="rankA">Rank {$userName}</option>
          {#if selectedOther}
            <option value="rankB">Rank {displayOther}</option>
            <option value="diff">Difference</option>
          {/if}
        </select>
        <!-- Share button (desktop only) -->
        <button
          type="button"
          class="btn btn-xs btn-ghost ml-2 hidden md:inline-flex"
          data-share-btn
          on:click={shareCompare}
          title="Share as image"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            class="h-5 w-5"
            fill="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.03-.47-.09-.7l7.02-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7l-7.02 4.11c-.54-.5-1.25-.81-2.04-.81-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.17c-.05.21-.08.43-.08.65 0 1.72 1.39 3.11 3.11 3.11 1.72 0 3.11-1.39 3.11-3.11s-1.39-3.11-3.11-3.11z"
            />
          </svg>
        </button>
      </label>
    </header>
    <!-- Sticky name bar - pins to viewport top while cards scroll (shared by mobile and desktop) -->
    <div class="sticky top-0 z-20 bg-base-200 shadow-md">
      <div class="w-full sm:max-w-[42rem] lg:max-w-[54rem] 2xl:max-w-[64rem] sm:mx-auto px-2 py-2 flex gap-3 items-center">
        <div class="w-12 flex-shrink-0"></div>
        <div class="flex-1 min-w-0 grid grid-cols-[1fr_auto_1fr] gap-2 items-center text-sm font-semibold">
          <div class="text-center truncate" title={$userName ?? ''}>{$userName}</div>
          <!-- Middle spacer matches the diff-badge width in compare mode; stays
               empty in solo mode so the user-A column occupies the same 1fr
               slot regardless of 2nd-user selection. -->
          <span class="px-2 invisible" aria-hidden="true">0</span>
          <div class="text-center truncate" title={displayOther}>{displayOther}</div>
        </div>
      </div>
    </div>

    <!-- Card layout (shared by mobile and desktop; width matches Home's anime grid) -->
    <div class="w-full sm:max-w-[42rem] lg:max-w-[54rem] 2xl:max-w-[64rem] sm:mx-auto flex flex-col gap-2 px-2">
      {#each rows as row (row.id)}
        <!-- Test hooks. The pre-deploy suite used to assert Compare worked by
             looking for the word "Compare" in the body text, which passes on a
             page that rendered no data at all. These let it check the numbers. -->
        <div
          class="bg-base-200 rounded p-3 flex gap-3"
          data-compare-row={row.id}
          data-rank-a={row.rankA ?? ''}
          data-rank-b={row.rankB ?? ''}
          data-diff={row.diff ?? ''}
        >
          {#if row.cover}
            <img src={row.cover} alt={row.title} class="flex-shrink-0 rounded object-cover" style="width:48px;height:66px;" />
          {:else}
            <div class="flex-shrink-0 rounded bg-base-300 flex items-center justify-center opacity-40" style="width:48px;height:66px;">-</div>
          {/if}
          <div class="flex-1 min-w-0">
            <div class="italic opacity-70 text-xs leading-tight mb-2 break-words" title={row.title}>
              {row.title}
            </div>
            <!-- Always 3-col so solo mode preserves the same spatial layout
                 as compare. Middle + right cells are empty in solo mode. -->
            <div class="grid grid-cols-[1fr_auto_1fr] items-center gap-2 text-xs">
              <div class="text-center min-w-0">
                <div class="font-semibold text-base">
                  {#if row.rankA != null}#{row.rankA}{:else}-{/if}
                </div>
                {#if row.customA}
                  <div class="font-medium text-sm line-clamp-2" title={row.customA}>{row.customA}</div>
                {/if}
              </div>
              <div class="flex justify-center">
                {#if selectedOther}
                  {#if row.diff != null}
                    <span class="px-2 py-1 rounded-full text-sm font-semibold whitespace-nowrap" style="background:{heat(row.diff)};color:{textColor(row.diff)};">
                      {#if row.rankA < row.rankB}
                        &larr;{row.diff}
                      {:else if row.rankA > row.rankB}
                        {row.diff}&rarr;
                      {:else}
                        {row.diff}
                      {/if}
                    </span>
                  {:else}
                    <span class="text-gray-400">-</span>
                  {/if}
                {/if}
              </div>
              <div class="text-center min-w-0">
                {#if selectedOther}
                  <div class="font-semibold text-base">
                    {#if row.rankB != null}#{row.rankB}{:else}-{/if}
                  </div>
                  {#if row.customB}
                    <div class="font-medium text-sm line-clamp-2" title={row.customB}>{row.customB}</div>
                  {/if}
                {/if}
              </div>
            </div>
          </div>
        </div>
      {/each}
    </div>

    </div> <!-- capture wrapper end -->
  {:else}
    <p class="p-4 w-full sm:max-w-[42rem] lg:max-w-[54rem] 2xl:max-w-[64rem] sm:mx-auto">
      {#if selectedOther}
        No titles to compare.
      {:else}
        Nothing in your list for this season.
      {/if}
    </p>
  {/if}
{/if}
