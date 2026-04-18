<script lang="ts">
import { options } from '../stores/options';
import SubtitleSettings from './SubtitleSettings.svelte';
// Reactive trigger so title-language changes re-render grid
$: _currentLang = $options.titleLanguage;

  function hexToRgb(hex: string): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `${r}, ${g}, ${b}`;
  }

  function textBorderStyle(border: string): string {
    if (border === 'light') return 'text-shadow: 1px 1px 1px rgba(0,0,0,0.5), -1px -1px 1px rgba(0,0,0,0.5);';
    if (border === 'medium') return 'text-shadow: 1px 1px 2px rgba(0,0,0,0.8), -1px -1px 2px rgba(0,0,0,0.8), 0 0 4px rgba(0,0,0,0.5);';
    if (border === 'heavy') return 'text-shadow: 2px 2px 4px #000, -2px -2px 4px #000, 0 0 6px rgba(0,0,0,0.9);';
    if (border === 'drop-shadow') return 'text-shadow: 3px 3px 4px rgba(0,0,0,0.9);';
    if (border === 'glow') return 'text-shadow: 0 0 6px rgba(255,255,255,0.8), 0 0 12px rgba(255,255,255,0.4);';
    return '';
  }
  export let anime: any[] = [];
  export let hideSequels: boolean = false;
  export let hideInList: boolean = false;
  // Hide adult (18+) content
  export let hideAdult: boolean = false;
  export let inListIds: Set<number> = new Set();
  export let watchedIds: Set<number> = new Set();
  export let autoRename: boolean = false;
  // "Catch up" filter: show only items in otherUserRatedIds that aren't in watchedIds
  export let catchUpMode: boolean = false;
  export let otherUserRatedIds: Set<number> = new Set();
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

  // ── Translation state ──────────────────────────────────────────────
  let subtitleSegments: Array<{ start: number; end: number; text: string }> = [];
  let currentSubtitle = '';
  let eventSource: EventSource | null = null;
  let subtitleTickInterval: number | null = null;
  let translating = false;
  let translationLoading = false;
  let translationStatus = 'Downloading audio...';
  let playerCurrentTime = 0;
  let modalOpenedAt: number | null = null;
  // UI controls
  let subtitlesVisible = true;
  let subtitleSettingsOpen = false;
  let lastYouTubeTimeUpdate = 0;
  let videoPlaying = false;
  let checkResolved = false;
  let controlsVisible = true;
  let controlsFadeTimer: number | null = null;

  function showControls() {
    controlsVisible = true;
    if (controlsFadeTimer) clearTimeout(controlsFadeTimer);
    if (videoPlaying) {
      controlsFadeTimer = window.setTimeout(() => {
        controlsVisible = false;
      }, 2000);
    }
  }

  function openModal(id: string, mediaId?: number) {
    modal = id;
    document.body.style.overflow = 'hidden';

    const mediaParam = mediaId ? `&mediaId=${mediaId}` : '';

    // Start translation immediately — don't wait for check
    translationLoading = true;
    startTranslation(id, mediaParam);

    // Check runs in background — only affects default subtitle visibility.
    // checkResolved gates the spinner so it doesn't flash then disappear
    // on videos that have English subs (where subtitlesVisible gets set to false).
    checkResolved = false;
    // /check returns {hasEnglish, subtitlesDisabled, hasBurnedInSubs} — hide our
    // subtitles if the video has English subs, burned-in subs, or was dismissed.
    fetch(`/api/translate/check?videoId=${id}${mediaParam}`)
      .then(res => res.json())
      .then(data => {
        if (modal === id && (data.hasEnglish || data.subtitlesDisabled || data.hasBurnedInSubs)) {
          subtitlesVisible = false;
        }
        checkResolved = true;
      })
      .catch(() => { checkResolved = true; });
  }

  function startTranslation(videoId: string, mediaParam: string = '') {
    subtitleSegments = [];
    currentSubtitle = '';
    translationStatus = 'Downloading audio...';
    const sseStartTime = Date.now();

    console.log('[translate] Opening SSE connection for', videoId);
    eventSource = new EventSource(`/api/translate/stream?videoId=${videoId}${mediaParam}`);

    eventSource.onopen = () => {
      const elapsed = ((Date.now() - sseStartTime) / 1000).toFixed(1);
      console.log(`[translate] SSE connection opened after ${elapsed}s`);
    };

    eventSource.onmessage = (event) => {
      const elapsed = ((Date.now() - sseStartTime) / 1000).toFixed(1);
      try {
        const data = JSON.parse(event.data);
        if (data.cached) {
          // Cached response — skip spinner, go straight to translating mode
          console.log(`[translate] [${elapsed}s] Serving from cache`);
          translationLoading = false;
          translating = true;
          checkResolved = true;
          startSubtitleTick();
          return;
        }
        if (data.progress) {
          translationStatus = data.progress === 'transcribing' ? 'Transcribing...' : data.progress;
          return;
        }
        if (data.error) {
          console.warn(`[translate] [${elapsed}s] ERROR from server:`, data.error);
          translationLoading = false;
          stopTranslation();
          return;
        }
        if (data.done) {
          console.log(`[translate] [${elapsed}s] DONE — ${subtitleSegments.length} total segments received`);
          translationLoading = false;
          eventSource?.close();
          eventSource = null;
          return;
        }
        // Log every segment with timing
        console.log(`[translate] [${elapsed}s] segment ${subtitleSegments.length + 1}: ${data.start}s-${data.end}s "${data.text}"`);
        subtitleSegments = [...subtitleSegments, data];
        if (translationLoading) {
          translationLoading = false;
          translating = true;
          const videoElapsed = modalOpenedAt ? (Date.now() - modalOpenedAt) / 1000 : 0;
          playerCurrentTime = videoElapsed;
          console.log(`[translate] [${elapsed}s] FIRST SEGMENT — switching to translating mode, estimated video position: ${playerCurrentTime.toFixed(1)}s`);
          startSubtitleTick();
        }
      } catch (e) {
        console.warn(`[translate] [${elapsed}s] Failed to parse SSE data:`, event.data);
      }
    };

    eventSource.onerror = (e) => {
      const elapsed = ((Date.now() - sseStartTime) / 1000).toFixed(1);
      console.warn(`[translate] [${elapsed}s] SSE error/reconnect, segments so far: ${subtitleSegments.length}`);
      if (subtitleSegments.length > 0) {
        eventSource?.close();
        eventSource = null;
      }
    };
  }

  function stopTranslation() {
    eventSource?.close();
    eventSource = null;
    if (subtitleTickInterval) {
      clearInterval(subtitleTickInterval);
      subtitleTickInterval = null;
    }
    translating = false;
    currentSubtitle = '';
  }

  function startSubtitleTick() {
    // Sync subtitles to YouTube's currentTime (from infoDelivery events).
    // Wall-clock fallback only if YouTube hasn't sent updates recently.
    // Freezes when video is paused.
    subtitleTickInterval = window.setInterval(() => {
      if (!modalOpenedAt) return;

      // Don't advance subtitles while paused
      if (!videoPlaying) return;

      // Only use wall-clock if YouTube isn't sending time updates
      if (Date.now() - lastYouTubeTimeUpdate > 1000) {
        playerCurrentTime = (Date.now() - modalOpenedAt) / 1000;
      }

      const seg = subtitleSegments.find(s => playerCurrentTime >= s.start && playerCurrentTime <= s.end);
      currentSubtitle = seg?.text ?? '';

      // Stop ticking once we've passed the last segment
      const lastSeg = subtitleSegments[subtitleSegments.length - 1];
      if (lastSeg && playerCurrentTime > lastSeg.end + 5 && !eventSource) {
        console.log('[translate] Past last segment, stopping tick');
        clearInterval(subtitleTickInterval!);
        subtitleTickInterval = null;
        currentSubtitle = '';
      }
    }, 200);
  }

  function closeModal() {
    modal = null;
    document.body.style.overflow = '';
    stopTranslation();
    subtitleSegments = [];
    currentSubtitle = '';
    translationLoading = false;
    playerCurrentTime = 0;
    modalOpenedAt = null;
    subtitlesVisible = true;
    lastYouTubeTimeUpdate = 0;
    videoPlaying = false;
    checkResolved = false;
    controlsVisible = true;
    if (controlsFadeTimer) clearTimeout(controlsFadeTimer);
    controlsFadeTimer = null;
    window.removeEventListener('message', onMessage);
  }

  // ------------------------------------------------------------------
  // Mark-as-watched helper
  // ------------------------------------------------------------------

  async function markAsWatched(show: any) {
    if (!$authToken) {
      showToast('Log in to mark shows');
      return;
    }

    const { season, year } = get(seasonYear);

    try {
      const res = await fetch('/api/list/watched', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${$authToken}`
        },
        body: JSON.stringify({ season, year, mediaId: show.id, watched: true })
      });
      if (res.ok) {
        inListIds.add(show.id);
        showToast('Marked as watched');
        dispatch('watched', show.id);
      } else {
        showToast('Failed to mark watched');
      }
    } catch (e) {
      console.error(e);
      showToast('Network error');
    }
  }

  // Add to list as *unwatched* (pre-watch)
  async function addToUnwatched(show: any) {
    if (!$authToken) {
      showToast('Log in to add');
      return;
    }

    if (inListIds.has(show.id)) return;

    const { season, year } = get(seasonYear);

    try {
      const res = await fetch('/api/list/watched', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${$authToken}`
        },
        body: JSON.stringify({ season, year, mediaId: show.id, watched: false })
      });
      if (res.ok) {
        inListIds.add(show.id);
        showToast('Added to My List');
        dispatch('watched', show.id);
        if (autoRename) {
          dispatch('added', show.id);
        }
      } else {
        showToast('Failed to add');
      }
    } catch (e) {
      console.error(e);
      showToast('Network error');
    }
  }

  // relation type -> label mapping
  const TAG_LABELS: Record<string, string> = {
    SEQUEL: 'Sequel',
    PREQUEL: 'Prequel',
    SIDE_STORY: 'Side-story',
    SPINOFF: 'Spin-off',
    ADULT: '18+'
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

  function displayTags(show: any): string[] {
    const tags = relationTags(show.relations);
    if (show.isAdult) tags.push('ADULT');
    return tags;
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
    if (catchUpMode) {
      // Show only items the other user has in their list that I don't have in mine
      return arr.filter((a) => otherUserRatedIds.has(a.id) && !inListIds.has(a.id));
    }
    if (hideAdult) arr = arr.filter((a) => !a.isAdult);
    if (hideSequels) arr = arr.filter((s) => !isSequel(s));
    if (hideInList) arr = arr.filter((a) => !inListIds.has(a.id));
    return arr;
  })();

  import { fade } from 'svelte/transition';
import { dragged } from '../stores/drag';
import { authToken } from '../stores/auth';
import { seasonYear } from '../stores/season';
import { get } from 'svelte/store';
import { createEventDispatcher, onDestroy } from 'svelte';

const dispatch = createEventDispatcher();

  // Clean up on component destroy
  onDestroy(() => {
    stopTranslation();
    window.removeEventListener('message', onMessage);
  });

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

  // Map AniList MediaSource enum → human readable label
  const SOURCE_LABELS: Record<string, string> = {
    ORIGINAL: 'Original Content',
    MANGA: 'Manga',
    MANHWA: 'Manhwa',
    MANHUA: 'Manhua',
    LIGHT_NOVEL: 'Light Novel',
    VISUAL_NOVEL: 'Visual Novel',
    NOVEL: 'Novel',
    VIDEO_GAME: 'Video Game',
    MULTIMEDIA_PROJECT: 'Multimedia Project',
    DOUJINSHI: 'Doujinshi',
    ANIME: 'Anime',
    BOOK: 'Book',
    OTHER: 'Other'
  };

  function getSourceLabel(src: string | null | undefined): string {
    if (!src) return '';
    if (SOURCE_LABELS[src]) return SOURCE_LABELS[src];
    // Fallback: transform enum-like text to Title Case e.g. "WEB_NOVEL" -> "Web Novel"
    return src
      .split('_')
      .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
      .join(' ');
  }
  let iframeElement: HTMLIFrameElement | null = null;

  /**
   * Listen for messages from the YouTube iframe.
   * Handles caption setup AND captures currentTime for subtitle sync.
   */
  function onMessage(event: MessageEvent) {
    if (iframeElement && event.source === iframeElement.contentWindow) {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      // onReady: subscribe to API change events
      if (data.event === 'onReady') {
        const win = iframeElement!.contentWindow!;
        win.postMessage(JSON.stringify({ event: 'command', func: 'addEventListener', args: ['onApiChange'] }), '*');
        win.postMessage(JSON.stringify({ event: 'command', func: 'addEventListener', args: ['onStateChange'] }), '*');
      }
      // Track play/pause state
      if (data.event === 'onStateChange') {
        if (data.info === 1) { videoPlaying = true; showControls(); }    // PLAYING
        if (data.info === 2) { videoPlaying = false; showControls(); } // PAUSED
        // Set captions when not translating
        if (data.info === 1 && !translating && !translationLoading) {
          const win = iframeElement!.contentWindow!;
          win.postMessage(JSON.stringify({ event: 'command', func: 'setOption', args: ['captions', 'track', { languageCode: 'en' }] }), '*');
          win.postMessage(JSON.stringify({ event: 'command', func: 'setOption', args: ['cc', 'track', { languageCode: 'en' }] }), '*');
        }
      }
      // onApiChange: set English captions (only when not translating)
      if (data.event === 'onApiChange' && !translating && !translationLoading) {
        const win = iframeElement!.contentWindow!;
        win.postMessage(JSON.stringify({ event: 'command', func: 'setOption', args: ['captions', 'track', { languageCode: 'en' }] }), '*');
        win.postMessage(JSON.stringify({ event: 'command', func: 'setOption', args: ['cc', 'track', { languageCode: 'en' }] }), '*');
      }
      // Primary time source: YouTube's currentTime from infoDelivery (~250ms intervals).
      // Captured during translationLoading too so the first tick has accurate time.
      if (data.event === 'infoDelivery' && data.info?.currentTime !== undefined && (translating || translationLoading)) {
        playerCurrentTime = data.info.currentTime;
        lastYouTubeTimeUpdate = Date.now();
      }
    }
  }

  /**
   * Called when iframe loads; start the JS API handshake.
   */
  function onIframeLoad() {
    if (iframeElement?.contentWindow) {
      // Wall-clock fallback anchor — used only if YouTube's infoDelivery events
      // stop sending currentTime (e.g. embed restrictions). Primary sync comes
      // from the YouTube iframe API's currentTime via infoDelivery messages.
      modalOpenedAt = Date.now();
      const win = iframeElement.contentWindow!;
      win.postMessage(JSON.stringify({ event: 'listening' }), '*');
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
            class="anime-title m-0 text-xl md:text-xl leading-tight whitespace-normal break-words"
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
      <div class="flex gap-3 px-3 py-1">
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
            on:click={() => openModal(show.trailer.id, show.id)}
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
        <div class="px-3 py-1 text-sm text-base-content/70 flex justify-between items-center">
          <span>
            Next episode {show.nextAiringEpisode.episode} airs {formatUnix(show.nextAiringEpisode.airingAt)}
          </span>
          {#if getSourceLabel(show.source)}
            <span class="ml-4 whitespace-nowrap">Source: {getSourceLabel(show.source)}</span>
          {/if}
        </div>
      {:else if show.status === 'FINISHED'}
        <div class="px-3 py-1 text-sm text-base-content/70 flex justify-between items-center">
          <span>
            {#if show.episodes}
              {show.episodes} episodes
            {/if}
            aired on {formatYMD(show.endDate) || formatYMD(show.startDate)}
          </span>
          {#if getSourceLabel(show.source)}
            <span class="ml-4 whitespace-nowrap">Source: {getSourceLabel(show.source)}</span>
          {/if}
        </div>
      {:else if show.status === 'NOT_YET_RELEASED'}
        <div class="px-3 py-1 text-sm text-base-content/70 flex justify-between items-center">
          <span>
            {#if show.startDate?.day}
              Airing on {formatYMD(show.startDate)}
            {:else}
              Airing in {approxMonthYear(show.startDate, show.season)}
            {/if}
          </span>
          {#if getSourceLabel(show.source)}
            <span class="ml-4 whitespace-nowrap">Source: {getSourceLabel(show.source)}</span>
          {/if}
        </div>
      {/if}

      <!-- Row 2: Tags (relations, 18+) -->
      {#if displayTags(show).length > 0 || ($authToken && !watchedIds.has(show.id))}
        <div class="px-3 flex flex-wrap gap-2 items-center pb-0">
          {#each displayTags(show) as tag}
            <span class="badge badge-accent text-xs">{TAG_LABELS[tag]}</span>
          {/each}

          {#if $authToken && (!inListIds.has(show.id) || !watchedIds.has(show.id))}
            <div class="ml-auto flex gap-2">
              {#if $authToken && !inListIds.has(show.id)}
                <button
                  class="btn btn-neutral btn-xs shadow"
                  on:click={() => addToUnwatched(show)}
                >
                  watched trailer
                </button>
              {/if}

              {#if $authToken && !watchedIds.has(show.id)}
                <button
                  class="btn btn-neutral btn-xs shadow"
                  on:click={() => markAsWatched(show)}
                >
                  watched 1st ep
                </button>
              {/if}
            </div>
          {/if}
        </div>
      {/if}

      <!-- Row 3: Summary -->
      {#if show.description}
        <div class="px-3 pb-3 text-sm overflow-y-auto max-h-60 flex-1 min-h-0 prose prose-sm dark:prose-invert">
          {@html show.description}
        </div>
      {/if}
      {#if !show.description}
        <div class="flex-1" />
      {/if}

      <!-- Mark-as-watched button moved to tag row above -->
    </div>
    {/key}
  {/each}
</div>

  <!-- Modal overlay for large trailer player -->
{#if modal}
  <div
  class="fixed inset-0 bg-black/80 flex items-center justify-center z-[100]"
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
    <!-- svelte-ignore a11y-no-static-element-interactions -->
    <div
      class="relative w-[95%] md:w-5/6 lg:w-4/5 xl:w-4/5 aspect-video"
      on:mouseenter={showControls}
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

      <!-- Translation controls — spinner + CC toggle side by side -->
      {#if translationLoading || translating}
        <!-- svelte-ignore a11y-no-static-element-interactions -->
        <div
          class="absolute top-12 right-2 flex items-center gap-2 z-10"
          on:mouseenter={showControls}
          on:mousemove={showControls}
          on:mouseleave={() => { if (videoPlaying) showControls(); }}
          class:opacity-0={!controlsVisible && !(translationLoading && subtitlesVisible && checkResolved)}
          class:opacity-100={controlsVisible || (translationLoading && subtitlesVisible && checkResolved)}
          style="transition: opacity 0.75s ease-out; {controlsVisible ? 'transition-duration: 0s;' : ''}"
        >
          {#if translationLoading && subtitlesVisible && checkResolved}
            <div class="flex items-center gap-2 bg-black/60 text-white text-sm px-3 py-1.5 rounded">
              <span class="loading loading-spinner loading-sm"></span>
              {translationStatus}
            </div>
          {/if}
          <button
            class="flex items-center gap-1 bg-black/60 text-white text-sm px-2 py-1.5 rounded hover:bg-black/80 transition-colors relative"
            on:click|stopPropagation={() => {
              subtitlesVisible = !subtitlesVisible;
              // Persist dismiss state for all future users (no auth required)
              if (modal) {
                fetch(`/api/translate/dismiss?videoId=${modal}`, {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ disabled: !subtitlesVisible }),
                }).catch(() => {});
              }
            }}
            title={subtitlesVisible ? 'Hide subtitles' : 'Show subtitles'}
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="w-5 h-5">
              <path d="M2 4v16h20V4H2zm18 14H4V6h16v12zm-8-1h6v-2h-6v2zm-6 0h4v-2H6v2zm0-4h10v-2H6v2z"/>
            </svg>
            {#if !subtitlesVisible}
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="w-5 h-5 absolute inset-0 m-auto" style="pointer-events:none">
                <line x1="4" y1="20" x2="20" y2="4" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
              </svg>
            {/if}
          </button>
          <!-- Subtitle settings gear -->
          <button
            class="flex items-center gap-1 bg-black/60 text-white text-sm px-2 py-1.5 rounded hover:bg-black/80 transition-colors"
            on:click|stopPropagation={() => { subtitleSettingsOpen = !subtitleSettingsOpen; }}
            title="Subtitle settings"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="w-5 h-5">
              <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84a.48.48 0 0 0-.48.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87a.48.48 0 0 0 .12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.26.41.48.41h3.84c.24 0 .44-.17.48-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z"/>
            </svg>
          </button>
        </div>
      {/if}

      <!-- Subtitle settings panel -->
      {#if subtitleSettingsOpen}
        <SubtitleSettings
          videoId={modal}
          {subtitlesVisible}
          on:close={() => { subtitleSettingsOpen = false; }}
          on:toggleVideo={(e) => { subtitlesVisible = e.detail.visible; }}
        />
      {/if}

      <!-- Subtitle overlay -->
      {#if translating && $options.subtitlePrefs.enabled && subtitlesVisible && currentSubtitle}
        <div
          class="absolute left-1/2 -translate-x-1/2 max-w-[80%] px-1.5 py-0.5 rounded pointer-events-none text-center z-10"
          style="
            bottom: {$options.subtitlePrefs.position}px;
            font-size: {$options.subtitlePrefs.fontSize}px;
            font-family: '{$options.subtitlePrefs.fontFamily}', sans-serif;
            color: {$options.subtitlePrefs.textColor};
            background: rgba({hexToRgb($options.subtitlePrefs.bgColor)}, {$options.subtitlePrefs.bgOpacity / 100});
            {textBorderStyle($options.subtitlePrefs.textBorder)}
          "
          transition:fade={{ duration: 150 }}
        >
          {currentSubtitle}
        </div>
      {/if}
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
