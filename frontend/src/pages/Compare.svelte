<script lang="ts">
  import { onMount, tick } from 'svelte';
  import SeasonSelect, { type Season } from '../components/SeasonSelect.svelte';
  import { authToken, userName } from '../stores/auth';
import { options } from '../stores/options';
// Reactive trigger for title-language changes
$: _lang = $options.titleLanguage;
  // combobox component
  import Select from 'svelte-select';
  import 'svelte-select/tailwind.css';

const rankOptions = [
  { value: 'pre', label: 'Pre-watch' },
  { value: 'post', label: 'Post-watch' }
] as const;

  // ────────────────────────────────────────────────────────────────────────────
  // Local state – season/year/user selection
  // ────────────────────────────────────────────────────────────────────────────

  let season: Season = 'SPRING';
  let year: number = new Date().getFullYear();

  // User A is always the currently logged-in user
  let userA: string | null = null;

  // ------------------------------------------------------------------
  // User B selection – auto-complete dropdown
  // ------------------------------------------------------------------

  let otherInput = '';
  // selectedOther may be a primitive string or an object returned by svelte-select
  let selectedOther: any = null;

  // suggestion list for combobox
  let suggestions: string[] = [];
  // load matching users (debounced)
  async function fetchSuggestions() {
    const q = otherInput.trim();
    const url = q ? `/api/users?q=${encodeURIComponent(q)}` : `/api/users`;
    try {
      const resp = await fetch(url);
      if (resp.ok) {
        suggestions = (await resp.json())
          .map((u: string) => ({ value: u, label: u }));
      }
    } catch {}
  }
  let suggestTimer: any;
  function queueSuggest() {
    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(fetchSuggestions, 250);
  }

// Reactive: fetch whenever selection or rank types change
$: if (userA && selectedOther) {
  // dependencies
  rankTypeA;
  rankTypeB;
  season;
  year;
  fetchLists();
}


  // Display-friendly other username (handles string or object)
  $: displayOther = typeof selectedOther === 'string'
    ? selectedOther
    : (selectedOther?.value ?? selectedOther?.label ?? '');
  
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

  /* ──────────────────────────────────────────────────────────────────────────
   * Share-as-image functionality (clone & export as JPEG)
   * ───────────────────────────────────────────────────────────────────────*/

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

    /* Tighten layout on the clone only */
    [clone, ...clone.querySelectorAll('*')].forEach((n) => {
      if (!(n instanceof HTMLElement)) return;
      n.classList.remove('w-full', 'md:w-3/4', 'mx-auto');
    });

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

    // Remove centering / width utility classes from the fresh clone as well
    [clone, ...clone.querySelectorAll('*')].forEach((n) => {
      if (!(n instanceof HTMLElement)) return;
      n.classList.remove('w-full', 'md:w-3/4', 'mx-auto');
    });

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

    /* After major DOM changes (select replacements) recalculate dimensions and
       hide remote images in the new clone to prevent CORS issues. */

    // Wait a tick for layout changes to settle before measuring size later
    await tick();

    /* ------------------------------------------------------------------
     * Hide the Cover column (header & cells) – images are already hidden.
     * ----------------------------------------------------------------*/
    // Hide header cell labeled "Cover"
    clone.querySelectorAll('div,span,header,th').forEach((el) => {
      if ((el as HTMLElement).textContent?.trim() === 'Cover') {
        (el as HTMLElement).style.display = 'none';
      }
    });
    // Hide parent cells that contained poster <img>
    clone.querySelectorAll('img').forEach((img) => {
      const parent = img.parentElement as HTMLElement | null;
      if (parent) parent.style.display = 'none';
    });

    // Reduce grid to 3 columns instead of original 4 when cover column hidden
    const grid = clone.querySelector('[style*="grid-template-columns"]') as HTMLElement | null;
    if (grid) {
      grid.style.gridTemplateColumns = '1fr auto 1fr';
    }

    // Add explicit right-side padding so the capture has breathing room.
    clone.style.paddingRight = '12px';

    // Hide remote images to avoid CORS-tainted canvas
    const posters: HTMLImageElement[] = Array.from(clone.querySelectorAll('img'));
    const posterDisplay = posters.map((p) => p.style.display);
    posters.forEach((p) => (p.style.display = 'none'));

    // Global border fix – remove default white borders some components gain
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

    try {
      // Lazy-load dom-to-image library
      const mod = await import(
        /* @vite-ignore */ 'https://cdn.jsdelivr.net/npm/dom-to-image-more@3.2.0/+esm'
      );
      const toJpeg = (mod.toJpeg ?? mod.default?.toJpeg) as (
        node: HTMLElement,
        opts: any
      ) => Promise<string>;

      // Temporarily disable cross-origin Google Fonts stylesheets to avoid
      // SecurityError when dom-to-image enumerates cssRules.
      const disabledSheets: CSSStyleSheet[] = [];
      Array.from(document.styleSheets).forEach((ss) => {
        const href = (ss as CSSStyleSheet).href;
        if (href && href.startsWith('https://fonts.googleapis.com')) {
          disabledSheets.push(ss as CSSStyleSheet);
          (ss as any).disabled = true;
        }
      });

      // Determine a reasonable background colour – prefer the first cell’s
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

      // Re-enable previously disabled stylesheets
      disabledSheets.forEach((ss) => ((ss as any).disabled = false));

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
    if (!userA || !selectedOther) return;

    loading = true;
    error = null;
    try {
      // extract actual usernames for API calls
      const usernameA = typeof userA === 'string'
        ? userA
        : (userA as any).value ?? '';
      const usernameB = typeof selectedOther === 'string'
        ? selectedOther
        : (selectedOther as any).value ?? (selectedOther as any).label ?? '';
      const [aResp, bResp, animeResp] = await Promise.all([
        fetch(`/api/public-list?username=${encodeURIComponent(usernameA)}&season=${season}&year=${year}&type=${rankTypeA}`),
        fetch(`/api/public-list?username=${encodeURIComponent(usernameB)}&season=${season}&year=${year}&type=${rankTypeB}`),
        fetch(`/api/anime?season=${season}&year=${year}`)
      ]);

      if (!aResp.ok) throw new Error(`Failed to fetch your list (${aResp.status})`);
      if (!bResp.ok) throw new Error(`Failed to fetch other list (${bResp.status})`);

      listA = (await aResp.json()) ?? [];
      listB = (await bResp.json()) ?? [];
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
  // Logout handler – when the auth token disappears we should:
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

  // Remove automatic reactive fetch upon selection; we trigger fetch manually

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
  
  // ────────────────────────────────────────────────────────────────────────────
  // Persist comparison target to localStorage
  //
  // This block used to run as soon as the component module was evaluated, i.e.
  // before `onMount`.  At that time `selectedOther` is still `null`, so we
  // ended up calling `localStorage.removeItem('compare-other')` and erasing the
  // value we actually wanted to restore on first render.
  //
  // We now wait until the component is mounted in the browser (signalled by
  // the `mounted` flag) before running the persistence logic.
  // ────────────────────────────────────────────────────────────────────────────

  let mounted = false;
  onMount(() => (mounted = true));

  // Auto-set rank types when comparing with self
  let lastOther: string | null = null;
  $: {
    const other = typeof selectedOther === 'string'
      ? selectedOther
      : (selectedOther?.value ?? selectedOther?.label ?? null);

    if (other !== lastOther) {
      lastOther = other;

      if (other && userA && other === userA) {
        rankTypeA = 'pre';
        rankTypeB = 'post';
      }
    }
  }

  $: if (mounted) {
    const val = typeof selectedOther === 'string'
      ? selectedOther
      : (selectedOther?.value ?? selectedOther?.label ?? '');

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
    if (!listA || !listB) return [];

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

    listB.forEach((row, idx) => {
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

  let sortMode: 'title' | 'rankA' | 'rankB' | 'diff' = 'diff';
  // Rows to render, rebuilt reactively when lists or sort mode change
  let rows: RankedItem[] = [];

  // Reactive block: rebuild rows when lists, animeData, or sortMode change
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
  // determines text color for contrast over heatmap backgrounds
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
  <!-- Controls ------------------------------------------------------------------>
  <div class="p-4 bg-base-200 rounded shadow flex flex-col items-center gap-4 w-full mx-auto md:grid md:grid-cols-2 md:items-end md:gap-6 md:w-3/4">
    <div class="min-w-0 w-auto">
      <SeasonSelect
        class="!w-auto"
        bind:season
        bind:year
        showListToggle={false}
        showSequelToggle={false}
        showSearch={false}
      />
    </div>

    <!-- (rank type selectors moved to table headers) -->

    <div class="flex flex-col gap-2 justify-self-center">
      <label for="otherUser" class="font-semibold">User to compare:</label>
      <div class="w-96">
        <Select
          id="otherUser"
          class="w-full input input-bordered text-gray-700"
          dropdownClass="w-full"
          items={suggestions}
          bind:searchText={otherInput}
          bind:value={selectedOther}
          placeholder="username"
          noOptionsMessage="No users found"
          searchable={true}
          on:search={() => queueSuggest()}
        on:change={() => {/* fetch triggered reactively */}}
        />
      </div>
    </div>
  </div>

  {#if !selectedOther}
    <p class="p-4 w-full md:w-3/4 mx-auto">Enter another user name to compare.</p>
  {:else if loading}
    <p class="p-4 w-full md:w-3/4 mx-auto">Loading…</p>
  {:else if error}
    <p class="p-4 w-full md:w-3/4 mx-auto text-red-500">{error}</p>
  {:else if rows.length}
    <!-- Legend: gradient and direction arrows -->
    <div class="w-full md:w-3/4 mx-auto p-2 text-sm space-y-2">
      <div class="font-semibold">Rank difference gradient:</div>
      <div class="h-2 w-full rounded" style="background: linear-gradient(to right, hsl(145 70% 45%), hsl(0 70% 45%));"></div>
      <div class="flex items-center gap-6">
        <div class="flex items-center gap-1"><span class="font-mono">0</span><span>= same rank</span></div>
        <div class="flex items-center gap-1"><span class="font-mono">←</span><span>= you ranked higher</span></div>
        <div class="flex items-center gap-1"><span class="font-mono">→</span><span>= other ranked higher</span></div>
      </div>
    </div>
    <!-- Capture wrapper starts -->
    <div bind:this={captureEl}>
    <header class="w-full md:w-3/4 mx-auto p-2 grid grid-cols-3 items-center">
      <div></div>
      <h2 class="text-xl font-bold text-center">{$userName} vs {displayOther} — {season} {year}</h2>
      <label class="text-sm justify-self-end">Sort:
        <select bind:value={sortMode} class="select select-sm ml-1">
          <option value="title">Title</option>
          <option value="rankA">Rank {$userName}</option>
          <option value="rankB">Rank {displayOther}</option>
          <option value="diff">Difference</option>
        </select>
        <!-- Share button -->
        <button
          type="button"
          class="btn btn-xs btn-ghost ml-2"
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
    <div class="w-full md:w-3/4 mx-auto grid" style="grid-template-columns: 1fr auto auto 1fr; row-gap:6px;">
      <div class="font-bold text-center flex items-center justify-center gap-2">
        {$userName}
        <select
          bind:value={rankTypeA}
          class="select select-xs select-bordered px-1 pr-8 py-0 min-w-[6rem]"
        >
          {#each rankOptions as opt}
            <option value={opt.value}>{opt.label}</option>
          {/each}
        </select>
      </div>
      <div class="font-bold text-center">Diff</div>
      <div class="font-bold text-center">Cover</div>
      <div class="font-bold text-center flex items-center justify-center gap-2">
        {displayOther}
        <select
          bind:value={rankTypeB}
          class="select select-xs select-bordered px-1 pr-8 py-0 min-w-[6rem]"
        >
          {#each rankOptions as opt}
            <option value={opt.value}>{opt.label}</option>
          {/each}
        </select>
      </div>

      {#each rows as row (row.id)}
        <!-- A column -->
        <div style="display:flex;align-items:center;gap:8px;min-height:72px;padding:4px;" title={row.title}>
          {#if row.rankA != null}
            <span style="width:24px;text-align:center;opacity:0.6;">{row.rankA}</span>
            <span title={row.title}>{row.customA || row.title}</span>
          {:else}
            <span style="opacity:0.4;">—</span>
{/if}
        </div>

        <!-- Diff column -->
        <div class="flex items-center justify-center">
          {#if row.diff != null}
            <span class="px-3 py-2 rounded-full text-lg font-semibold" style="background:{heat(row.diff)};color:{textColor(row.diff)};">
              {#if row.rankA < row.rankB}
                ←{row.diff}
              {:else if row.rankA > row.rankB}
                {row.diff}→
              {:else}
                {row.diff}
              {/if}
            </span>
          {:else}
            <span class="text-gray-400">—</span>
          {/if}
        </div>
        <!-- Cover column -->
        <div class="flex items-center justify-center">
          {#if row.cover}
            <img src={row.cover} alt={row.title} style="width:48px;height:66px;object-fit:cover;border-radius:3px;" />
          {:else}
            <span style="opacity:0.4;">—</span>
          {/if}
        </div>
        <!-- B column -->
        <div style="display:flex;align-items:center;gap:8px;min-height:72px;padding:4px;" title={row.title}>
          {#if row.rankB != null}
            <span class="flex-1 text-right" title={row.title}>{row.customB || row.title}</span>
            <span style="width:24px;text-align:center;opacity:0.6;">{row.rankB}</span>
          {:else}
            <span style="opacity:0.4;">—</span>
          {/if}
        </div>
      {/each}
    </div> <!-- grid -->
    </div> <!-- capture wrapper end -->
  {:else}
    <p class="p-4 w-full md:w-3/4 mx-auto">No titles to compare.</p>
  {/if}
{/if}
