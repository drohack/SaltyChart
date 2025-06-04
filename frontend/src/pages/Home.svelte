<script lang="ts">
  // Extracted original App.svelte content
import SeasonSelect from '../components/SeasonSelect.svelte';
import AnimeGrid from '../components/AnimeGrid.svelte';
import WatchListSidebar from '../components/WatchListSidebar.svelte';
import { authToken, userName } from '../stores/auth';

  type Season = 'WINTER' | 'SPRING' | 'SUMMER' | 'FALL';

  let season: Season = 'SPRING';
  let year: number = new Date().getFullYear();

  let anime: any[] = [];
  let prevSeasonAnime: any[] = [];

  $: tvAnime = anime.filter((a) => a.format === 'TV');
  $: tvShorts = anime.filter((a) => a.format === 'TV_SHORT');
  $: movies = anime.filter((a) => a.format === 'MOVIE');
  $: ovaOnaSpecial = anime.filter((a) => ['OVA', 'ONA', 'SPECIAL'].includes(a.format));

  $: leftovers = prevSeasonAnime.filter(
    (a) => a.format === 'TV' && a.status === 'RELEASING'
  );

  let loading = false;
  let hideSequels = false;
  let hideInList = false;
  let autoRename = false;
  // Hide adult (18+) content
  let hideAdult = true;

  // Persist user preferences in localStorage per user
  import { onMount } from 'svelte';

  function prefsKey(user: string | null): string {
    return user ? `prefs-${user}` : 'prefs-guest';
  }

  function loadPrefs(user: string | null) {
    try {
      const raw = localStorage.getItem(prefsKey(user));
      if (raw) {
        const obj = JSON.parse(raw);
        hideSequels = obj.hideSequels ?? hideSequels;
        hideInList = obj.hideInList ?? hideInList;
        autoRename = obj.autoRename ?? autoRename;
        hideAdult = obj.hideAdult ?? hideAdult;
      }
    } catch {}
  }

  function savePrefs(user: string | null) {
    try {
      const obj = { hideSequels, hideInList, autoRename, hideAdult };
      localStorage.setItem(prefsKey(user), JSON.stringify(obj));
    } catch {}
  }

  // Load on mount and whenever user logs in/out
  onMount(() => loadPrefs($userName));

  $: if ($userName) {
    // Whenever the logged in user changes, reload prefs
    loadPrefs($userName);
  }

  // If not logged in, force Hide-in-MyList off (no list available)
  $: if (!$authToken) hideInList = false;

  // When user logs out clear any previously loaded list so grid no longer
  // shows greyed-out items.  (watchList is only fetched when a valid token is
  // present, therefore stale entries would otherwise stick around.)
  $: if (!$authToken && watchList.length) {
    watchList = [];
  }

  // Save whenever any preference changes (and user is logged in)
  $: if ($userName) {
    // dependencies
    hideSequels;
    hideInList;
    autoRename;
    hideAdult;
    savePrefs($userName);
  }

  // watch list state
  let watchList: any[] = [];

  $: sidebarList = watchList
    .map((w) => {
      const a = anime.find((a) => a.id === w.mediaId);
      return a
        ? {
            ...a,
            customName: w.customName ?? null,
            watchedAt: w.watchedAt ?? null,
            watched: w.watched ?? Boolean(w.watchedAt)
          }
        : null;
    })
    .filter(Boolean);
  function saveList() {
    if (!$authToken) return;
    const payload = watchList.map(({ mediaId, customName, watchedAt }) => ({ mediaId, customName, watchedAt }));

    fetch('/api/list', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${$authToken}`
      },
      body: JSON.stringify({ season, year, items: payload })
    });
  }

  function prevSeasonYear(s: Season, y: number): { season: Season; year: number } {
    const order: Season[] = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];
    const idx = order.indexOf(s);
    if (idx === 0) return { season: 'FALL', year: y - 1 };
    return { season: order[idx - 1], year: y };
  }

  async function fetchAnime() {
    loading = true;
    try {
      const currentReq = fetch(`/api/anime?season=${season}&year=${year}`);
      const prev = prevSeasonYear(season, year);
      const prevReq = fetch(`/api/anime?season=${prev.season}&year=${prev.year}&format=TV`);

      const [currentData, prevData] = await Promise.all([currentReq, prevReq]).then((resps) =>
        Promise.all(resps.map((r) => r.json()))
      );

      anime = currentData;
      prevSeasonAnime = prevData;
    } catch (e) {
      console.error(e);
    } finally {
      loading = false;
      if ($authToken) {
        fetchList();
      }
    }
  }

  async function fetchList() {
    if (!$authToken) return;
    const res = await fetch(`/api/list?season=${season}&year=${year}`, {
      headers: { Authorization: `Bearer ${$authToken}` }
    });
    if (res.status === 401) {
      // Invalid or expired token: clear auth and exit
      authToken.set(null);
      userName.set(null);
      return;
    }
    if (res.ok) {
      watchList = await res.json();
    }
  }

  $: inListIds = new Set(watchList.map((w) => w.mediaId));


  // Keep track of the last (season,year) combo we fetched so we only hit the
  // network when it actually changes.
  let lastSeasonYearKey: string | null = null;

  // Reactive block will run on initial mount *and* whenever season/year
  // variables change via the bound SeasonSelect component.
  $: {
    const key = `${season}-${year}`;
    if (key !== lastSeasonYearKey) {
      lastSeasonYearKey = key;
      fetchAnime(); // no debounce needed – user interaction is limited
    }
  }
</script>

<main class="p-4 w-full md:w-3/4 mx-auto flex flex-col gap-4">
  <!-- Main content column -->
  <div class="flex-1 flex flex-col min-w-0">
    <!-- Season / Year selector directly under header -->
    <SeasonSelect
      bind:season
      bind:year
      bind:hideSequels
      bind:hideInList
      bind:hideAdult
      showAdultToggle={true}
      showListToggle={$authToken != null}
    />
  {#if loading}
    <div class="text-center">Loading…</div>
  {:else}
    {#if tvAnime.length}
      <h2 class="text-2xl font-bold mt-20 mb-8">TV</h2>
      <AnimeGrid anime={tvAnime} {hideSequels} {hideInList} {hideAdult} {inListIds} />
    {/if}

    {#if tvShorts.length}
      <h2 class="text-2xl font-bold mt-20 mb-8">TV Short</h2>
      <AnimeGrid anime={tvShorts} {hideSequels} {hideInList} {hideAdult} {inListIds} />
    {/if}

    {#if leftovers.length}
      <h2 class="text-2xl font-bold mt-20 mb-8">Leftovers</h2>
      <AnimeGrid anime={leftovers} {hideSequels} {hideInList} {hideAdult} {inListIds} />
    {/if}

    {#if ovaOnaSpecial.length}
      <h2 class="text-2xl font-bold mt-20 mb-8">OVA / ONA / Special</h2>
      <AnimeGrid anime={ovaOnaSpecial} {hideSequels} {hideInList} {hideAdult} {inListIds} />
    {/if}

    {#if movies.length}
      <h2 class="text-2xl font-bold mt-20 mb-8">Movies</h2>
      <AnimeGrid anime={movies} {hideSequels} {hideInList} {hideAdult} {inListIds} />
    {/if}
  {/if}
  </div>

  {#if $authToken}
    <WatchListSidebar
      list={sidebarList}
      season={season}
      year={year}
      user={$userName}
      bind:autoRename
      on:update={(e) => {
        watchList = e.detail;
        saveList();
      }}
    />
  {/if}
</main>
