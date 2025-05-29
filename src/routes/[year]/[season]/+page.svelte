<script lang="ts">
  import { onMount } from 'svelte';
  export let data: {
    season: string;
    year: number;
    media: import('$lib/types').MediaEntry[];
  };

  let openTrailer: string | null = null;

  function showTrailer(id: string) {
    openTrailer = id;
  }

  function closeModal() {
    openTrailer = null;
  }
</script>

<h1 class="text-3xl font-bold mb-6">
  {data.season} {data.year} Anime
</h1>

<div class="grid gap-6 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
  {#each data.media as anime}
    <div class="card bg-base-100 shadow-xl">
      <figure>
        <img src={anime.coverImage.large} alt={anime.title.romaji} class="w-full object-cover" />
      </figure>
      <div class="card-body">
        <h2 class="card-title">
          {anime.title.english ?? anime.title.romaji}
          {#if anime.relations?.edges.some((e) => e.relationType === 'SEQUEL')}
            <div class="badge badge-secondary">Sequel</div>
          {/if}
        </h2>
        <p class="line-clamp-3 prose prose-sm" innerHTML={anime.description ?? ''}></p>
        <div class="card-actions justify-end">
          {#if anime.trailer && anime.trailer.site === 'youtube'}
            <button class="btn btn-primary btn-sm" on:click={() => showTrailer(anime.trailer.id)}>Watch Trailer</button>
          {/if}
        </div>
      </div>
    </div>
  {/each}
</div>

{#if openTrailer}
  <dialog class="modal modal-open" on:click={closeModal}>
    <div class="modal-box max-w-4xl" on:click|stopPropagation>
      <iframe
        class="w-full aspect-video"
        src={`https://www.youtube.com/embed/${openTrailer}`}
        frameborder="0"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowfullscreen
      />
      <div class="modal-action">
        <button class="btn" on:click={closeModal}>Close</button>
      </div>
    </div>
  </dialog>
{/if}

<style>
  /* line-clamp using tailwind utilities requires plugin; fallback simple clamp */
  .line-clamp-3 {
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
</style>
