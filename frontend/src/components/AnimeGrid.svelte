<script lang="ts">
  export let anime: any[] = [];
  export let hideSequels: boolean = false;
  export let hideInList: boolean = false;
  export let inListIds: Set<number> = new Set();

  // id of trailer currently open in modal (null = none)
  let modal: string | null = null;

  function openModal(id: string) {
    modal = id;
    document.body.style.overflow = 'hidden';
  }

  function closeModal() {
    modal = null;
    document.body.style.overflow = '';
  }

  // relation type -> label mapping
  const TAG_LABELS: Record<string, string> = {
    SEQUEL: 'Sequel',
    PREQUEL: 'Prequel',
    SIDE_STORY: 'Side-story',
    SPINOFF: 'Spin-off'
  };

  function relationTags(rel: any): string[] {
    if (!rel?.edges) return [];
    const uniq: string[] = [];
    for (const edge of rel.edges) {
      const t = edge?.relationType;
      if (t && TAG_LABELS[t] && !uniq.includes(t)) uniq.push(t);
    }
    return uniq;
  }
  // Helper to determine if a show has sequel/prequel relation
  function isSequel(show: any): boolean {
    return relationTags(show.relations).length > 0;
  }

  $: displayedAnime = (() => {
    let arr = hideSequels ? anime.filter((s) => !isSequel(s)) : anime;
    if (hideInList) arr = arr.filter((a) => !inListIds.has(a.id));
    return arr;
  })();

  // --- Equalize title heights per grid row ---
  import { afterUpdate, onMount } from 'svelte';
  import { dragged } from '../stores/drag';

  function equalizeTitles() {
    const titles: HTMLElement[] = Array.from(document.querySelectorAll('.anime-title'));
    // Reset heights first
    titles.forEach((t) => (t.style.height = 'auto'));

    // Group by offsetTop (row)
    const groups: Record<number, HTMLElement[]> = {};
    for (const el of titles) {
      const top = el.offsetTop;
      (groups[top] ||= []).push(el);
    }
    // Set each group's titles to max height
    Object.values(groups).forEach((list) => {
      const max = Math.max(...list.map((e) => e.offsetHeight));
      list.forEach((e) => (e.style.height = max + 'px'));
    });
  }

  onMount(() => {
    equalizeTitles();
    window.addEventListener('resize', equalizeTitles);
    return () => window.removeEventListener('resize', equalizeTitles);
  });

  afterUpdate(equalizeTitles);

  function formatDate(ts: number): string {
    const date = new Date(ts * 1000);
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric'
    });
  }

  const MONTHS = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
  ];

  function formatUnix(ts: number): string {
    return formatDate(ts);
  }

  function formatYMD(d: any): string {
    if (!d || !d.year) return '';
    if (d.day) {
      return `${MONTHS[d.month - 1]} ${d.day}, ${d.year}`;
    }
    if (d.month) {
      return `${MONTHS[d.month - 1]} ${d.year}`;
    }
    return String(d.year);
  }

  function approxMonthYear(d: any, season?: string): string {
    if (d && d.month) return `${MONTHS[d.month - 1]} ${d.year}`;
    if (season && d?.year) return `${capitalize(season.toLowerCase())} ${d.year}`;
    return d?.year ? String(d.year) : '';
  }

  function capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
</script>

<!-- grid of horizontal cards -->
<div class="grid gap-6 md:grid-cols-3">
  {#each displayedAnime as show (show.id)}
    {#key show.id}
    <!-- Card -->
    <div
      class="flex flex-col bg-base-100 shadow rounded-lg overflow-hidden h-full"
      class:opacity-50={inListIds.has(show.id)}
      draggable={!inListIds.has(show.id)}
      role="listitem"
      on:dragstart={(e) => {
        dragged.set(show);
        e.dataTransfer?.setData('text/plain', String(show.id));
      }}
      on:dragend={() => dragged.set(null)}
    >
      <!-- Title row spanning full width -->
      <h3
        class="anime-title text-xl md:text-xl px-3 py-2 leading-snug whitespace-normal border-b border-base-300"
        title={show.title.english ?? show.title.romaji}
      >
        {show.title.english ?? show.title.romaji}
      </h3>

      <!-- Row 1: Cover & YouTube thumbnail (equal width/height) -->
      <div class="flex gap-3 p-3">
        <!-- Cover image (maintains full image, matches height of trailer) -->
        <div class="shrink-0 w-32 md:w-40 rounded overflow-hidden flex items-stretch">
          <img
            src={show.coverImage.large}
            alt={show.title.romaji}
            class="object-contain w-full h-full"
            loading="lazy"
          />
        </div>

        <!-- YouTube thumbnail (clickable) -->
        {#if show.trailer?.site === 'youtube'}
          <button
            class="relative flex-1 aspect-video rounded overflow-hidden"
            on:click={() => openModal(show.trailer.id)}
          >
            <img
              src={`https://i.ytimg.com/vi/${show.trailer.id}/hqdefault.jpg`}
              alt="Trailer thumbnail"
              class="absolute inset-0 object-cover w-full h-full"
              loading="lazy" fetchpriority="low"
            />
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              class="absolute inset-0 m-auto h-12 w-12 fill-white/90"
              aria-labelledby="play-title"
              role="img"
            >
              <title id="play-title">Play trailer</title>
              <path d="M8 5v14l11-7z" />
            </svg>
          </button>
        {:else}
          <!-- placeholder if no trailer -->
          <div class="flex-1 aspect-video rounded bg-base-200 flex items-center justify-center text-sm text-base-content/60">
            No trailer
          </div>
        {/if}
      </div>

      <!-- Airing information -->
      {#if show.nextAiringEpisode}
        <div class="px-3 py-1 text-sm text-base-content/70">
          Next episode {show.nextAiringEpisode.episode} airs {formatUnix(show.nextAiringEpisode.airingAt)}
        </div>
      {:else if show.status === 'FINISHED'}
        <div class="px-3 py-1 text-sm text-base-content/70">
          {#if show.episodes}
            {show.episodes} episodes
          {/if}
          aired on {formatYMD(show.endDate) || formatYMD(show.startDate)}
        </div>
      {:else if show.status === 'NOT_YET_RELEASED'}
        <div class="px-3 py-1 text-sm text-base-content/70">
          {#if show.startDate?.day}
            Airing on {formatYMD(show.startDate)}
          {:else}
            Airing in {approxMonthYear(show.startDate, show.season)}
          {/if}
        </div>
      {/if}

      <!-- Row 2: Relation tags -->
      {#if relationTags(show.relations).length > 0}
        <div class="px-3 flex flex-wrap gap-1 pb-2">
          {#each relationTags(show.relations) as tag}
            <span class="badge badge-accent text-xs">{TAG_LABELS[tag]}</span>
          {/each}
        </div>
      {/if}

      <!-- Row 3: Summary -->
      {#if show.description}
        <div class="px-3 pb-3 text-sm overflow-y-auto max-h-40 prose prose-sm dark:prose-invert">
          {@html show.description}
        </div>
      {/if}
    </div>
    {/key}
  {/each}
</div>

<!-- Modal overlay for large trailer player -->
{#if modal}
  <!--
    Bring the trailer modal above every other UI layer. The watch-list
    sidebar uses z-[9999], so we give the modal a higher literal value.
  -->
  <div
    class="fixed inset-0 bg-black/80 flex items-center justify-center z-[10000]"
    role="dialog"
    aria-modal="true"
    tabindex="0"
    on:click|self={closeModal}
    on:keydown={(e) => {
      if (e.key === 'Escape') {
        closeModal();
      }
    }}
    on:keyup={(e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        closeModal();
      }
    }}
  >
    <div class="w-[95%] md:w-5/6 lg:w-4/5 xl:w-4/5 aspect-video">
      <iframe
        class="w-full h-full rounded"
        src={`https://www.youtube.com/embed/${modal}?autoplay=1&cc_load_policy=1&cc_lang_pref=en&hl=en`}
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowfullscreen
        on:click|stopPropagation
      />
    </div>
  </div>
{/if}
