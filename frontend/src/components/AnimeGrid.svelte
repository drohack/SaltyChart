<script lang="ts">
import { options } from '../stores/options';
// Reactive trigger so title-language changes re-render grid
$: _currentLang = $options.titleLanguage;
  export let anime: any[] = [];
  export let hideSequels: boolean = false;
  export let hideInList: boolean = false;
  // Hide adult (18+) content
  export let hideAdult: boolean = false;
  export let inListIds: Set<number> = new Set();
  // Toast notification state
  let toastVisible: boolean = false;
  let toastMessage: string = '';

  function showToast(msg: string) {
    toastMessage = msg;
    toastVisible = true;
    setTimeout(() => {
      toastVisible = false;
    }, 2000);
  }

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

  // Get display title based on user preference
  function getDisplayTitle(show: any): string {
    const lang = $options.titleLanguage;
    if (lang === 'ROMAJI') return show.title.romaji ?? show.title.english ?? show.title.native ?? '';
    if (lang === 'NATIVE') return show.title.native ?? show.title.english ?? show.title.romaji ?? '';
    // default English
    return show.title.english ?? show.title.romaji ?? show.title.native ?? '';
  }

  $: displayedAnime = (() => {
    let arr = anime;
    if (hideAdult) arr = arr.filter((a) => !a.isAdult);
    if (hideSequels) arr = arr.filter((s) => !isSequel(s));
    if (hideInList) arr = arr.filter((a) => !inListIds.has(a.id));
    return arr;
  })();

  // --- Equalize title heights per grid row ---
  import { afterUpdate, onMount } from 'svelte';
  import { fade } from 'svelte/transition';
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
  let iframeElement: HTMLIFrameElement | null = null;

  /**
   * Listen for state change messages from the YouTube iframe.
   * When playback starts (state=1), set caption track options.
   */
  function onMessage(event: MessageEvent) {
    if (iframeElement && event.source === iframeElement.contentWindow) {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        // ignore non-JSON messages
        return;
      }
      // onReady: subscribe to API change events
      if (data.event === 'onReady') {
        const win = iframeElement!.contentWindow!;
        // Subscribe to API change:
        win.postMessage(JSON.stringify({ event: 'command', func: 'addEventListener', args: ['onApiChange'] }), '*');
        // Subscribe to state change events:
        win.postMessage(JSON.stringify({ event: 'command', func: 'addEventListener', args: ['onStateChange'] }), '*');
      }
      // onApiChange: send caption options
      if (data.event === 'onApiChange') {
        const win = iframeElement!.contentWindow!;
        // set caption track option
        win.postMessage(JSON.stringify({ event: 'command', func: 'setOption', args: ['captions', 'track', { languageCode: 'en' }] }), '*');
        // set cc track option
        win.postMessage(JSON.stringify({ event: 'command', func: 'setOption', args: ['cc', 'track', { languageCode: 'en' }] }), '*');
        window.removeEventListener('message', onMessage);
      }
      // Fallback: onStateChange PLAYING
      if (data.event === 'onStateChange' && data.info === 1) {
        const win = iframeElement!.contentWindow!;
        // fallback: set caption track
        win.postMessage(JSON.stringify({ event: 'command', func: 'setOption', args: ['captions', 'track', { languageCode: 'en' }] }), '*');
        // fallback: set cc track
        win.postMessage(JSON.stringify({ event: 'command', func: 'setOption', args: ['cc', 'track', { languageCode: 'en' }] }), '*');
        window.removeEventListener('message', onMessage);
      }
    }
  }

  /**
   * Called when iframe loads; start the JS API handshake.
   */
  function onIframeLoad() {
    if (iframeElement?.contentWindow) {
      const win = iframeElement.contentWindow!;
      win.postMessage(JSON.stringify({ event: 'listening' }), '*');
      // subscribe to API change events
      window.addEventListener('message', onMessage);
    }
  }
</script>

<!-- grid of horizontal cards -->
<!-- Responsive grid: 1 column, 2 columns at ≥1122px, 3 columns at ≥1732px -->
<div class="grid grid-cols-1 2cols:grid-cols-2 3cols:grid-cols-3 gap-6">
  {#each displayedAnime as show (show.id)}
    {#key show.id}
    <!-- Card -->
    <div
      class="relative flex flex-col bg-base-100 shadow rounded-lg overflow-hidden h-full"
      class:cursor-grab={!inListIds.has(show.id)}
      draggable={!inListIds.has(show.id)}
      role="listitem"
      on:dragstart={(e) => {
        dragged.set(show);
        e.dataTransfer?.setData('text/plain', String(show.id));
      }}
      on:dragend={() => dragged.set(null)}
    >
      {#if !inListIds.has(show.id)}
        <div class="absolute inset-0 bg-accent/10 pointer-events-none"></div>
      {/if}
      <!-- Title row with copy button -->
      <div class="flex items-center justify-between px-3 py-2 border-b border-base-300">
        {#key $options.titleLanguage + '-' + show.id}
          <h3
            class="anime-title text-xl md:text-xl leading-snug whitespace-normal"
            title={getDisplayTitle(show)}
          >
            {getDisplayTitle(show)}
          </h3>
        {/key}
        <button
          class="btn btn-ghost btn-sm p-1"
          aria-label="Copy title"
          on:click={() => {
            const text = getDisplayTitle(show);
            navigator.clipboard.writeText(text);
            showToast(`${text} copied to clipboard`);
          }}
        >
          <!-- Using Material Design file_copy icon for a familiar Windows feel -->
          <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
            <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
          </svg>
        </button>
      </div>

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
            class="relative flex-1 aspect-video rounded overflow-hidden cursor-pointer"
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
    role="button"
    aria-label="Close trailer player"
    on:click|self={closeModal}
    on:keydown={(e) => {
      if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') {
        closeModal();
      }
    }}
    tabindex="-1"
  >
    <div
      class="w-[95%] md:w-5/6 lg:w-4/5 xl:w-4/5 aspect-video"
    >
      <iframe
        title="Trailer video"
        bind:this={iframeElement}
        class="w-full h-full rounded"
        src={`https://www.youtube.com/embed/${modal}?enablejsapi=1&cc_load_policy=1&cc_lang_pref=en&hl=en&autoplay=${$options.videoAutoplay ? 1 : 0}`}
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowfullscreen
        on:load={onIframeLoad}
      />
    </div>
  </div>
{/if}
<!-- Toast notification -->
{#if toastVisible}
  <div
    in:fade={{ duration: 300 }}
    out:fade={{ duration: 300 }}
    class="fixed bottom-4 left-1/2 transform -translate-x-1/2 bg-base-200 text-base-content px-4 py-2 rounded shadow"
  >
    {toastMessage}
  </div>
{/if}
