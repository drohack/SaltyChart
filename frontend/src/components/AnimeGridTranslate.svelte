<script lang="ts">
import { options } from '../stores/options';
import SubtitleSettings from './SubtitleSettings.svelte';
import DOMPurify from 'dompurify';
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

  // Pre-fetched English sub status - passed in from Home.svelte via check-batch.
  // Key: YouTube video ID, Value: true = confirmed English CC in DB.
  export let prefetchedSubs: Map<string, boolean> = new Map();
  // True once the batch has returned - lets openModal skip the 150ms precheck
  // race for videos not in prefetchedSubs (batch already said: no English CC).
  export let prefetchComplete: boolean = false;

  // -- Translation state ----------------------------------------------
  let subtitleSegments: Array<{ start: number; end: number; text: string }> = [];
  let currentSubtitle = '';
  // Pointer into subtitleSegments for O(1) tick lookups - advances forward only
  let currentSegIdx = 0;
  let eventSource: EventSource | null = null;
  let subtitleTickInterval: number | null = null;
  let translating = false;
  let translationLoading = false;
  let translationStatus = 'Downloading audio...';
  let playerCurrentTime = 0;
  let modalOpenedAt: number | null = null;
  // UI controls
  let subtitlesVisible = true;
  let hasEnglishSubs = false;
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

  async function openModal(id: string, mediaId?: number) {
    hasEnglishSubs = false;
    subtitlesVisible = true;
    checkResolved = false;
    currentSegIdx = 0;
    document.body.style.overflow = 'hidden';

    const mediaParam = mediaId ? `&mediaId=${mediaId}` : '';

    // Fast path: batch prefetch confirmed English CC - instant, no network call.
    if (prefetchedSubs.get(id) === true) {
      hasEnglishSubs = true;
      subtitlesVisible = false;
      checkResolved = true;
      modal = id;
      return;
    }

    // If the batch has already run and this video wasn't in it, we know there's
    // no confirmed English CC - skip the precheck race and go straight to
    // translation. Still fire /check async to catch subtitlesDisabled/hasBurnedInSubs
    // and to pick up any Python result that completed after the batch ran.
    if (prefetchComplete) {
      modal = id;
      translationLoading = true;
      startTranslation(id, mediaParam);
      fetch(`/api/translate/check?videoId=${id}${mediaParam}`)
        .then(res => res.json())
        .then((data: any) => {
          if (modal !== id || !data) { checkResolved = true; return; }
          hasEnglishSubs = !!data.hasEnglish;
          if (data.hasEnglish || data.subtitlesDisabled || data.hasBurnedInSubs) {
            subtitlesVisible = false;
          }
          if (data.hasEnglish && iframeElement?.contentWindow) {
            const win = iframeElement.contentWindow!;
            win.postMessage(JSON.stringify({ event: 'command', func: 'loadModule', args: ['captions'] }), '*');
            win.postMessage(JSON.stringify({ event: 'command', func: 'setOption', args: ['captions', 'track', { languageCode: 'en' }] }), '*');
            win.postMessage(JSON.stringify({ event: 'command', func: 'setOption', args: ['cc', 'track', { languageCode: 'en' }] }), '*');
          }
          if (data.hasEnglish) prefetchedSubs.set(id, true);
          checkResolved = true;
        })
        .catch(() => { checkResolved = true; });
      return;
    }

    // Batch hasn't run yet (user clicked very fast) - race /check against 150ms
    // so the iframe doesn't block while Python potentially runs.
    const checkPromise = fetch(`/api/translate/check?videoId=${id}${mediaParam}`)
      .then(res => res.json()).catch(() => null);

    const precheck: any = await Promise.race([
      checkPromise,
      new Promise<null>(resolve => setTimeout(() => resolve(null), 150))
    ]);

    if (precheck) {
      hasEnglishSubs = !!precheck.hasEnglish;
      if (precheck.hasEnglish || precheck.subtitlesDisabled || precheck.hasBurnedInSubs) {
        subtitlesVisible = false;
      }
      checkResolved = true;
    }

    modal = id;

    if (hasEnglishSubs) return;

    translationLoading = true;
    startTranslation(id, mediaParam);

    if (!precheck) {
      checkPromise.then((data: any) => {
        if (modal !== id || !data) { checkResolved = true; return; }
        hasEnglishSubs = !!data.hasEnglish;
        if (data.hasEnglish || data.subtitlesDisabled || data.hasBurnedInSubs) {
          subtitlesVisible = false;
        }
        if (data.hasEnglish && iframeElement?.contentWindow) {
          const win = iframeElement.contentWindow!;
          win.postMessage(JSON.stringify({ event: 'command', func: 'loadModule', args: ['captions'] }), '*');
          win.postMessage(JSON.stringify({ event: 'command', func: 'setOption', args: ['captions', 'track', { languageCode: 'en' }] }), '*');
          win.postMessage(JSON.stringify({ event: 'command', func: 'setOption', args: ['cc', 'track', { languageCode: 'en' }] }), '*');
        }
        if (data.hasEnglish) prefetchedSubs.set(id, true);
        checkResolved = true;
      }).catch(() => { checkResolved = true; });
    }
  }

  /**
   * Briefly show why subtitles aren't coming. Deliberately transient and
   * non-blocking: the trailer plays fine without subtitles, so this must never
   * gate playback or cover the video - it sits in the existing control cluster
   * beside the CC toggle and clears itself.
   */
  let translationError: string | null = null;
  let _translationErrorTimer: ReturnType<typeof setTimeout> | null = null;

  function showTranslationError(msg: string) {
    translationError = msg;
    if (_translationErrorTimer) clearTimeout(_translationErrorTimer);
    _translationErrorTimer = setTimeout(() => { translationError = null; }, 6000);
  }

  function clearTranslationError() {
    translationError = null;
    if (_translationErrorTimer) { clearTimeout(_translationErrorTimer); _translationErrorTimer = null; }
  }

  function startTranslation(videoId: string, mediaParam: string = '') {
    subtitleSegments = [];
    currentSubtitle = '';
    clearTranslationError();
    translationStatus = 'Downloading audio...';

    // If the viewer is already several seconds into the trailer (re-open, or
    // they scrubbed ahead), tell the backend to begin transcription near the
    // playhead instead of second 0 - it won't waste CPU on already-watched audio
    // that the forward-only subtitle pointer would discard anyway. The common
    // open-from-start case keeps start=0 so the result is still cached fully.
    const startSec = Math.floor(playerCurrentTime);
    const startParam = startSec > 3 ? `&start=${startSec}` : '';

    eventSource = new EventSource(`/api/translate/stream?videoId=${videoId}${mediaParam}${startParam}`);

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.cached) {
          // Cached response - skip spinner, go straight to translating mode
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
          console.error('[translate] Server error:', data.error);
          translationLoading = false;
          // The message was written for a human ("try again shortly") but only
          // ever reached the console: the status chip is gated on
          // `translationLoading`, which this very line clears. The viewer saw a
          // trailer with no subtitles and no way to tell that from a trailer
          // that simply has none. Surface it briefly, without blocking playback.
          showTranslationError(data.error);
          stopTranslation();
          return;
        }
        if (data.done) {
          translationLoading = false;
          eventSource?.close();
          eventSource = null;
          return;
        }
        subtitleSegments = [...subtitleSegments, data];
        if (translationLoading) {
          translationLoading = false;
          translating = true;
          const videoElapsed = modalOpenedAt ? (Date.now() - modalOpenedAt) / 1000 : 0;
          playerCurrentTime = videoElapsed;
          startSubtitleTick();
        }
      } catch (e) {
        console.warn('[translate] Failed to parse SSE data:', event.data);
      }
    };

    eventSource.onerror = () => {
      // SSE reconnect is normal during long translations; close if we already have segments
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

      // Re-seek on a backward scrub - the pointer only advances forward, so
      // without this a rewind would never re-show earlier subtitles.
      if (currentSegIdx > 0 && playerCurrentTime < subtitleSegments[currentSegIdx].start) {
        currentSegIdx = 0;
      }

      // Advance pointer forward (segments are chronological) - O(1) for stable
      // playback, O(n) only on the tick right after a rewind.
      while (currentSegIdx < subtitleSegments.length - 1 &&
             playerCurrentTime > subtitleSegments[currentSegIdx].end) {
        currentSegIdx++;
      }
      const seg = subtitleSegments[currentSegIdx];
      currentSubtitle = (seg && playerCurrentTime >= seg.start && playerCurrentTime <= seg.end)
        ? seg.text : '';
      // NOTE: the interval is intentionally NOT self-cleared past the last
      // segment - a backward scrub must still re-display subtitles. It's cleared
      // in stopTranslation()/closeModal().
    }, 200);
  }

  /**
   * Escape closes the trailer. Bound to the window, because the handler used to
   * live on the overlay div with `tabindex="-1"` - nothing ever focused it, so
   * the keydown went to the still-focused trigger button and Escape closed
   * nothing at all.
   *
   * Enter/Space are deliberately not handled here (the old overlay handler did):
   * on a window listener they would fire on any keypress, and Enter is already
   * bound to mark-watched.
   */
  function handleWindowKey(e: KeyboardEvent) {
    if (modal && e.key === 'Escape') closeModal();
  }

  function closeModal() {
    modal = null;
    currentSegIdx = 0;
    document.body.style.overflow = '';
    clearTranslationError();
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

  // Map AniList MediaSource enum -> human readable label
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
      // onReady: subscribe to events and immediately suppress captions
      if (data.event === 'onReady') {
        const win = iframeElement!.contentWindow!;
        win.postMessage(JSON.stringify({ event: 'command', func: 'addEventListener', args: ['onApiChange'] }), '*');
        win.postMessage(JSON.stringify({ event: 'command', func: 'addEventListener', args: ['onStateChange'] }), '*');
        // Kill captions immediately on ready - before onApiChange fires
        if (!hasEnglishSubs) {
          win.postMessage(JSON.stringify({ event: 'command', func: 'unloadModule', args: ['captions'] }), '*');
        }
      }
      // Track play/pause state
      if (data.event === 'onStateChange') {
        if (data.info === 1) { videoPlaying = true; showControls(); }    // PLAYING
        if (data.info === 2) { videoPlaying = false; showControls(); } // PAUSED
        // On play: enforce caption state (safety net for re-plays)
        if (data.info === 1) {
          const win = iframeElement!.contentWindow!;
          if (hasEnglishSubs) {
            win.postMessage(JSON.stringify({ event: 'command', func: 'setOption', args: ['captions', 'track', { languageCode: 'en' }] }), '*');
            win.postMessage(JSON.stringify({ event: 'command', func: 'setOption', args: ['cc', 'track', { languageCode: 'en' }] }), '*');
          } else {
            win.postMessage(JSON.stringify({ event: 'command', func: 'unloadModule', args: ['captions'] }), '*');
          }
        }
      }
      // onApiChange: fires early (before /check resolves), so hasEnglishSubs is
      // false -> unloadModule kills any Japanese auto-captions immediately.
      // When /check later confirms English subs, the check handler re-enables them.
      if (data.event === 'onApiChange') {
        const win = iframeElement!.contentWindow!;
        if (hasEnglishSubs) {
          win.postMessage(JSON.stringify({ event: 'command', func: 'setOption', args: ['captions', 'track', { languageCode: 'en' }] }), '*');
          win.postMessage(JSON.stringify({ event: 'command', func: 'setOption', args: ['cc', 'track', { languageCode: 'en' }] }), '*');
        } else {
          win.postMessage(JSON.stringify({ event: 'command', func: 'unloadModule', args: ['captions'] }), '*');
        }
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
      // Wall-clock fallback anchor - used only if YouTube's infoDelivery events
      // stop sending currentTime (e.g. embed restrictions). Primary sync comes
      // from the YouTube iframe API's currentTime via infoDelivery messages.
      modalOpenedAt = Date.now();
      const win = iframeElement.contentWindow!;
      win.postMessage(JSON.stringify({ event: 'listening' }), '*');
      window.addEventListener('message', onMessage);
    }
  }

  // Blur-up cover loading: the tiny `medium` image sits blurred underneath
  // while the full `large` cover fades in once it finishes downloading. The
  // placeholder is then removed outright - leaving hundreds of blurred images
  // live costs a decoded bitmap and a compositing layer each, and merely
  // hiding them leaves invisible covers in the DOM for anything (tests
  // included) that looks for a visible cover image. `error` counts as done
  // too, otherwise a broken cover URL stays at opacity 0 forever, hiding its
  // own alt text.
  function fadeInWhenLoaded(img: HTMLImageElement) {
    const done = () => {
      img.classList.remove('opacity-0');
      img.previousElementSibling?.remove();
    };
    if (img.complete && img.naturalWidth > 0) done();
    else {
      img.addEventListener('load', done, { once: true });
      img.addEventListener('error', done, { once: true });
    }
  }
</script>

<!-- Must be top-level: <svelte:window> can't sit inside a block. The handler
     itself checks whether the trailer modal is open. -->
<svelte:window on:keydown={handleWindowKey} />

<!-- grid of horizontal cards -->
<!-- Responsive grid: 1 column, 2 columns at >=1122px, 3 columns at >=1732px -->
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
        <div class="relative shrink-0 w-32 md:w-40 rounded overflow-hidden flex items-stretch">
          <img
            src={show.coverImage.medium}
            alt=""
            aria-hidden="true"
            class="absolute inset-0 object-contain w-full h-full blur-sm scale-105"
            loading="lazy"
            decoding="async"
          />
          <img
            src={show.coverImage.large}
            alt={show.title.romaji}
            class="relative object-contain w-full h-full opacity-0 transition-opacity duration-300"
            loading="lazy"
            decoding="async"
            use:fadeInWhenLoaded
          />
        </div>

        <!-- YouTube thumbnail (clickable) -->
        {#if show.trailer?.site === 'youtube'}
          <!-- The accessible name has to name the show. This button's only name
               used to come from the image's `alt`, which was the constant
               "Trailer thumbnail" - so a screen reader announced the same thing
               for every card on the page with no way to tell them apart. `alt`
               being present means no Svelte a11y rule fires, so the clean build
               could not see it. The image is decorative now that the button is
               named, or the show would be announced twice. -->
          <button
            class="relative flex-1 aspect-video rounded overflow-hidden cursor-pointer"
            aria-label={`Play trailer for ${getDisplayTitle(show)}`}
            on:click={() => openModal(show.trailer.id, show.id)}
          >
            <img
              src={`https://i.ytimg.com/vi/${show.trailer.id}/hqdefault.jpg`}
              alt=""
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
          {@html DOMPurify.sanitize(show.description)}
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
  <!-- svelte-ignore a11y-click-events-have-key-events
       The backdrop is a convenience, not the keyboard path: Escape is handled
       on <svelte:window> above (it could not be handled here - this element is
       never focused, which is exactly the bug that shipped), and there is a
       real labelled ✕ button inside the modal. -->
  <div
  class="fixed inset-0 bg-black/80 flex items-center justify-center z-[100]"
    role="button"
    aria-label="Close trailer player"
    on:click|self={closeModal}
    tabindex="-1"
  >
    <!-- svelte-ignore a11y-no-static-element-interactions -->
    <div
      class="relative w-[95%] md:w-5/6 lg:w-4/5 xl:w-4/5 aspect-video"
      on:mouseenter={showControls}
    >
      <!-- The only close affordance used to be clicking the backdrop, which is
           a thin strip on a phone and invisible as an affordance anywhere. -->
      <button
        class="btn btn-sm btn-circle btn-ghost absolute -top-10 right-0 text-white hover:bg-white/20 z-20"
        aria-label="Close trailer"
        on:click|stopPropagation={closeModal}
      >✕</button>
      <iframe
        title="Trailer video"
        bind:this={iframeElement}
        class="w-full h-full rounded"
        src={`https://www.youtube.com/embed/${modal}?enablejsapi=1&cc_load_policy=0&cc_lang_pref=en&hl=en&autoplay=${$options.videoAutoplay ? 1 : 0}`}
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowfullscreen
        on:load={onIframeLoad}
      />

      <!-- Translation controls - spinner + CC toggle side by side.
           `translationError` is in the condition because the error handler
           clears `translationLoading`, so without it the cluster unmounts at
           exactly the moment there is something to say. -->
      {#if translationLoading || translating || translationError}
        <!-- svelte-ignore a11y-no-static-element-interactions -->
        <div
          class="absolute top-12 right-2 flex items-center gap-2 z-10"
          on:mouseenter={showControls}
          on:mousemove={showControls}
          on:mouseleave={() => { if (videoPlaying) showControls(); }}
          class:opacity-0={!controlsVisible && !(translationLoading && subtitlesVisible && checkResolved) && !(translationError && subtitlesVisible)}
          class:opacity-100={controlsVisible || (translationLoading && subtitlesVisible && checkResolved) || (translationError && subtitlesVisible)}
          style="transition: opacity 0.75s ease-out; {controlsVisible ? 'transition-duration: 0s;' : ''}"
        >
          {#if translationLoading && subtitlesVisible && checkResolved}
            <div class="flex items-center gap-2 bg-black/60 text-white text-sm px-3 py-1.5 rounded">
              <span class="loading loading-spinner loading-sm"></span>
              {translationStatus}
            </div>
          {:else if translationError && subtitlesVisible}
            <div
              class="flex items-center gap-2 bg-black/60 text-white text-sm px-3 py-1.5 rounded"
              data-translation-error
            >
              Subtitles unavailable - {translationError}
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
