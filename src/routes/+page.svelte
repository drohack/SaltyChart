<script lang="ts">
import { onMount } from 'svelte';
  import { seasons } from '$lib/utils/date';

  interface SeasonLink {
    label: string;
    path: string;
  }

  let links: SeasonLink[] = [];

  onMount(() => {
    const now = new Date();
    const currentYear = now.getFullYear();
    links = seasons.map((s) => ({
      label: `${s} ${currentYear}`,
      path: `/season/${s.toLowerCase()}/${currentYear}`
    }));
  });
</script>

<section class="max-w-6xl mx-auto py-12 text-center">
  <h1 class="text-4xl font-bold mb-4">SaltyChart</h1>
  <p class="text-lg mb-10">
    Browse upcoming anime by season, powered by the AniList API.
  </p>

  <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
    {#each links as link}
      <a
        href={link.path}
        class="rounded-lg border border-gray-300 dark:border-gray-700 p-6 hover:bg-gray-200 dark:hover:bg-gray-800 transition"
      >
        {link.label}
      </a>
    {/each}
  </div>
</section>
