<script lang="ts">
  import { onMount } from 'svelte';
  import SeasonSelect from './components/SeasonSelect.svelte';
  import AnimeGrid from './components/AnimeGrid.svelte';

  type Season = 'WINTER' | 'SPRING' | 'SUMMER' | 'FALL';

  let season: Season = 'SPRING';
  let year: number = new Date().getFullYear();

  let anime: any[] = [];
  let loading = false;

  async function fetchAnime() {
    loading = true;
    try {
      const res = await fetch(`/api/anime?season=${season}&year=${year}`);
      anime = await res.json();
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

<main class="p-4 max-w-7xl mx-auto">
  <h1 class="text-3xl font-bold mb-4">SaltyChart</h1>

  <SeasonSelect bind:season bind:year on:change={fetchAnime} />

  {#if loading}
    <div class="text-center">Loading…</div>
  {:else}
    <AnimeGrid {anime} />
  {/if}
</main>
