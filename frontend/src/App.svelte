<script lang="ts">
  import { onMount } from 'svelte';
  import SeasonSelect from './components/SeasonSelect.svelte';
  import AnimeGrid from './components/AnimeGrid.svelte';

  type Season = 'WINTER' | 'SPRING' | 'SUMMER' | 'FALL';

  let season: Season = 'SPRING';
  let year: number = new Date().getFullYear();

  let anime: any[] = [];
  let prevSeasonAnime: any[] = [];

  // Derived section arrays (reactive)
  $: tvAnime = anime.filter((a) => a.format === 'TV');
  $: tvShorts = anime.filter((a) => a.format === 'TV_SHORT');
  $: movies = anime.filter((a) => a.format === 'MOVIE');

  // Leftovers: TV series from previous season still releasing
  $: leftovers = prevSeasonAnime.filter(
    (a) => a.format === 'TV' && a.status === 'RELEASING'
  );
  $: ovaOnaSpecial = anime.filter((a) => ['OVA', 'ONA', 'SPECIAL'].includes(a.format));
  let loading = false;

  // Toggle to hide sequels/prequels
  let hideSequels = false;

  function prevSeasonYear(s: Season, y: number): { season: Season; year: number } {
    const order: Season[] = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];
    const idx = order.indexOf(s);
    if (idx === 0) {
      return { season: 'FALL', year: y - 1 };
    }
    return { season: order[idx - 1], year: y };
  }

  async function fetchAnime() {
    loading = true;
    try {
      // Fetch each desired format separately to ensure completeness
      const formats = ['TV', 'TV_SHORT', 'MOVIE', 'OVA', 'ONA', 'SPECIAL'];

      const formatRequests = formats.map((fmt) =>
        fetch(`/api/anime?season=${season}&year=${year}&format=${fmt}`)
      );

      // Previous season (all formats) for leftovers
      const prev = prevSeasonYear(season, year);
      const prevReq = fetch(`/api/anime?season=${prev.season}&year=${prev.year}&format=TV`);

      const responses = await Promise.all([...formatRequests, prevReq]);
      const jsonData = await Promise.all(responses.map((r) => r.json()));

      const prevData = jsonData.pop(); // last element corresponds to prevReq

      // Merge current-season lists, deduplicate by id
      const merged: Record<number, any> = {};
      jsonData.flat().forEach((m) => {
        merged[m.id] = m;
      });

      anime = Object.values(merged);
      prevSeasonAnime = prevData;
    } catch (err) {
      console.error(err);
    } finally {
      loading = false;
    }
  }

  onMount(fetchAnime);

  $: if (season && year) {
    // when season/year changes, re-fetch
  }
</script>

<!--
  Widen main list column from ~50% (max-w-7xl) to approximately 75% of the page.
  On small screens it will still take the full width (w-full), while on medium and
  larger screens it will be constrained to three-quarters of the viewport (md:w-3/4).
-->
<main class="p-4 w-full md:w-3/4 mx-auto">
  <h1 class="text-3xl font-bold mb-4">SaltyChart</h1>

  <SeasonSelect
    bind:season
    bind:year
    bind:hideSequels
    on:change={fetchAnime}
  />

  {#if loading}
    <div class="text-center">Loading…</div>
  {:else}
    {#if tvAnime.length}
      <h2 class="text-2xl font-bold mt-20 mb-8">TV</h2>
      <AnimeGrid anime={tvAnime} {hideSequels} />
    {/if}

    {#if tvShorts.length}
      <h2 class="text-2xl font-bold mt-20 mb-8">TV Short</h2>
      <AnimeGrid anime={tvShorts} {hideSequels} />
    {/if}

    {#if leftovers.length}
      <h2 class="text-2xl font-bold mt-20 mb-8">Leftovers</h2>
      <AnimeGrid anime={leftovers} {hideSequels} />
    {/if}

    {#if ovaOnaSpecial.length}
      <h2 class="text-2xl font-bold mt-20 mb-8">OVA / ONA / Special</h2>
      <AnimeGrid anime={ovaOnaSpecial} {hideSequels} />
    {/if}

    {#if movies.length}
      <h2 class="text-2xl font-bold mt-20 mb-8">Movies</h2>
      <AnimeGrid anime={movies} {hideSequels} />
    {/if}
  {/if}
</main>
