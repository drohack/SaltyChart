<script lang="ts">
  // Extracted original App.svelte content
  import { onMount } from 'svelte';
import SeasonSelect from '../components/SeasonSelect.svelte';
import AnimeGrid from '../components/AnimeGrid.svelte';
import WatchListSidebar from '../components/WatchListSidebar.svelte';
import { debounce } from '../debounce';
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

  // watch list state
  let watchList: any[] = [];

  $: sidebarList = watchList
    .map((w) => {
      const id = w.mediaId ?? w.id;
      return anime.find((a) => a.id === id);
    })
    .filter(Boolean);
  function saveList() {
    if (!$authToken) return;
    const ids = watchList.map((w) => w.mediaId || w.id || w.mediaId);
    fetch('/api/list', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${$authToken}`
      },
      body: JSON.stringify({ season, year, items: ids })
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
      const formats = ['TV', 'TV_SHORT', 'MOVIE', 'OVA', 'ONA', 'SPECIAL'];
      const formatRequests = formats.map((fmt) =>
        fetch(`/api/anime?season=${season}&year=${year}&format=${fmt}`)
      );
      const prev = prevSeasonYear(season, year);
      const prevReq = fetch(`/api/anime?season=${prev.season}&year=${prev.year}&format=TV`);

      const responses = await Promise.all([...formatRequests, prevReq]);
      const jsonData = await Promise.all(responses.map((r) => r.json()));

      const prevData = jsonData.pop();
      const merged: Record<number, any> = {};
      jsonData.flat().forEach((m) => (merged[m.id] = m));

      anime = Object.values(merged);
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
    if (res.ok) watchList = await res.json();
  }

  $: inListIds = new Set(watchList.map((w) => w.mediaId));

  const debouncedFetch = debounce(fetchAnime, 350);

  onMount(fetchAnime);

  // Automatically refetch when season or year change (debounced)
  $: seasonYearKey = `${season}-${year}`;
  $: if (seasonYearKey) debouncedFetch();
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
      showListToggle={$authToken != null}
    />
  {#if loading}
    <div class="text-center">Loading…</div>
  {:else}
    {#if tvAnime.length}
      <h2 class="text-2xl font-bold mt-20 mb-8">TV</h2>
      <AnimeGrid anime={tvAnime} {hideSequels} {hideInList} {inListIds} />
    {/if}

    {#if tvShorts.length}
      <h2 class="text-2xl font-bold mt-20 mb-8">TV Short</h2>
      <AnimeGrid anime={tvShorts} {hideSequels} {hideInList} {inListIds} />
    {/if}

    {#if leftovers.length}
      <h2 class="text-2xl font-bold mt-20 mb-8">Leftovers</h2>
      <AnimeGrid anime={leftovers} {hideSequels} {hideInList} {inListIds} />
    {/if}

    {#if ovaOnaSpecial.length}
      <h2 class="text-2xl font-bold mt-20 mb-8">OVA / ONA / Special</h2>
      <AnimeGrid anime={ovaOnaSpecial} {hideSequels} {hideInList} {inListIds} />
    {/if}

    {#if movies.length}
      <h2 class="text-2xl font-bold mt-20 mb-8">Movies</h2>
      <AnimeGrid anime={movies} {hideSequels} {hideInList} {inListIds} />
    {/if}
  {/if}
  </div>

  {#if $authToken}
    {#key watchList}
      <WatchListSidebar
        list={sidebarList}
        on:update={(e) => {
          watchList = e.detail;
          saveList();
        }}
      />
    {/key}
  {/if}
</main>
