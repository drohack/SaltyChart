<script lang="ts">
import AnimeCard from '$components/AnimeCard.svelte';

  export let data: {
    season: string;
    year: number;
    anime: any[];
  };
</script>

<section class="max-w-7xl mx-auto py-8 px-4">
  <h2 class="text-3xl font-bold mb-6 capitalize">
    {data.season} {data.year}
  </h2>

  {#if data.anime.length === 0}
    <p>No anime found for this season.</p>
  {:else}
    <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
      {#each data.anime as a}
        <AnimeCard anime={a} />
      {/each}
    </div>
  {/if}
</section>
