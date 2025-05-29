<script lang="ts">
  // Extracted original App.svelte content
  import { onMount } from 'svelte';
  import SeasonSelect from '../components/SeasonSelect.svelte';
  import AnimeGrid from '../components/AnimeGrid.svelte';

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
    }
  }

  onMount(fetchAnime);
</script>

<main class="p-4 w-full md:w-3/4 mx-auto">
  <SeasonSelect bind:season bind:year bind:hideSequels on:change={fetchAnime} />

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
