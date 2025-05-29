<script lang="ts">
  import type { Media } from '$lib/api/anilist';

  export let anime: Media;

  const title = anime.title.english ?? anime.title.romaji ?? 'Untitled';
  const isSequel = anime.relations?.nodes?.some((n) => n.type === 'ANIME');

  /**
   * Svelte action – sets innerHTML safely whenever `anime.description` changes.
   */
  export function htmlContent(node: HTMLElement) {
    node.innerHTML = anime.description ?? '';
    return {
      update() {
        node.innerHTML = anime.description ?? '';
      }
    };
  }
</script>

<div class="bg-white dark:bg-gray-800 rounded-lg shadow flex overflow-hidden">
  <!-- Thumbnail & title overlay -->
  <div class="relative shrink-0 w-40 md:w-48">
    <img src={anime.coverImage.large} alt={title} class="w-full h-full object-cover" />

    <!-- floating title -->
    <h3
      class="absolute bottom-0 left-0 w-full text-sm md:text-base font-semibold text-white bg-black/60 px-2 py-1 truncate"
      title={title}
    >
      {title}
    </h3>

    {#if isSequel}
      <span class="absolute top-1 right-1 text-xs font-medium text-orange-500 bg-white/80 rounded px-1">
        Sequel
      </span>
    {/if}
  </div>

  <!-- Right-hand column: trailer + summary -->
  <div class="p-4 flex flex-col gap-2 flex-1 overflow-hidden">
    {#if anime.trailer?.site === 'youtube' && anime.trailer.id}
      <iframe
        class="w-full aspect-video rounded"
        src={`https://www.youtube.com/embed/${anime.trailer.id}`}
        title="YouTube trailer"
        frameborder="0"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        allowfullscreen
      />
    {/if}

    {#if anime.description}
      <div
        class="text-sm text-gray-700 dark:text-gray-300 overflow-y-auto max-h-40 pr-1"
        use:htmlContent
      />
    {/if}
  </div>
</div>
