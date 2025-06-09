<script lang="ts">
  import { onMount } from 'svelte';
  import SeasonSelect, { type Season } from '../components/SeasonSelect.svelte';
  import { authToken, userName } from '../stores/auth';
import { options } from '../stores/options';
// Reactive trigger for title-language changes
$: _lang = $options.titleLanguage;
  // combobox component
  import Select from 'svelte-select';
  import 'svelte-select/tailwind.css';

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
		  .filter((u: string) => u !== userA)
		  .map((u: string) => ({ value: u, label: u }));
      }
    } catch {}
  }
  let suggestTimer: any;
  function queueSuggest() {
    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(fetchSuggestions, 250);
  }
  // when userA and a user is selected, fetch lists
  $: if (userA && selectedOther) fetchLists();


  // Display-friendly other username (handles string or object)
  $: displayOther = typeof selectedOther === 'string'
    ? selectedOther
    : (selectedOther?.value ?? selectedOther?.label ?? '');
  
  // Lists fetched from backend (raw WatchList rows)
  type WatchRow = {
    mediaId: number;
    order: number;
    customName: string | null;
  };

  let listA: WatchRow[] | null = null;
  let listB: WatchRow[] | null = null;

  // Full anime payload for current season (needed for titles & covers)
  let animeData: Array<any> = [];

  let loading = false;
  let error: string | null = null;

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
        fetch(`/api/public-list?username=${encodeURIComponent(usernameA)}&season=${season}&year=${year}`),
        fetch(`/api/public-list?username=${encodeURIComponent(usernameB)}&season=${season}&year=${year}`),
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
      </label>
    </header>
    <div class="w-full md:w-3/4 mx-auto grid" style="grid-template-columns: 1fr auto auto 1fr; row-gap:6px;">
      <div class="font-bold text-center">{$userName}</div>
      <div class="font-bold text-center">Diff</div>
      <div class="font-bold text-center">Cover</div>
      <div class="font-bold text-center">{displayOther}</div>

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
    </div>
  {:else}
    <p class="p-4 w-full md:w-3/4 mx-auto">No titles to compare.</p>
  {/if}
{/if}
