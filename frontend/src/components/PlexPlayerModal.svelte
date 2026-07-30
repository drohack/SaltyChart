<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import { get } from 'svelte/store';
  import { authToken } from '../stores/auth';

  // A thin wrapper around video.js (Apache-2.0). video.js owns the player:
  // control bar, menus, fullscreen, keyboard, error handling. The only
  // thing added here is 0.10x speed stepping on [ and ], which Plex's own
  // player can't do — that's the reason this exists.

  /** Plex ratingKey of the episode to play. */
  export let episodeRatingKey: string;
  /** Series display name (custom nickname or title). */
  export let title: string;
  export let episodeTitle = '';

  const dispatch = createEventDispatcher();

  let videoEl: HTMLVideoElement;
  // The speed flash lives inside the video.js element so it's part of the
  // fullscreen subtree (a sibling overlay simply isn't rendered in fullscreen).
  let flashEl: HTMLDivElement;
  let flashHome: HTMLElement | null = null;
  let player: any = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let rate = 1.0;

  // 0.10 steps across 0.2x–4.0x, used for both the keys and video.js's speed
  // menu so the two can't disagree.
  const SPEED_MIN = 0.2;
  const SPEED_MAX = 4;
  const SPEED_STEPS = Array.from(
    { length: Math.round((SPEED_MAX - SPEED_MIN) / 0.1) + 1 },
    (_, i) => +(SPEED_MIN + i * 0.1).toFixed(2)
  );

  // Plex needs a session id to track (and later stop) the transcode.
  // crypto.randomUUID() only exists in secure contexts — over plain http on
  // a LAN IP it's undefined.
  function newSessionId(): string {
    return typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
          b.toString(16).padStart(2, '0')
        ).join('');
  }
  // One session for the lifetime of this player — seeks reposition it, and
  // it's stopped once on close.
  const session = newSessionId();

  let subtitlesLoading = false; // English track still being extracted
  // Playback waits for the English track, but never longer than this.
  const SUBTITLE_WAIT_MS = 45_000;
  let subtitleWaitTimer: ReturnType<typeof setTimeout> | null = null;
  let playbackStarted = false;

  /** Begin playback — once only, whoever gets here first. */
  function startPlayback() {
    if (playbackStarted || !player) return;
    playbackStarted = true;
    if (subtitleWaitTimer) {
      clearTimeout(subtitleWaitTimer);
      subtitleWaitTimer = null;
    }
    player.play()?.catch?.(() => {});
  }
  // onMount awaits (Cast SDK, subtitle list) can outlive a quick close; every
  // await point re-checks this so nothing is built after teardown.
  let destroyed = false;

  function streamPath(rest: string): string {
    return `/api/plex/stream${rest}`;
  }

  /** Plex's HLS URL for this episode, served through our token-injecting proxy. */
  function sourceUrl(offsetSec = 0): string {
    const params = new URLSearchParams({
      path: `/library/metadata/${episodeRatingKey}`,
      protocol: 'hls',
      directPlay: '0',
      directStream: '1',
      fastSeek: '1',
      mediaIndex: '0',
      partIndex: '0',
      session,
      // Plex 400s the transcode start without client identification.
      hasMDE: '1',
      'X-Plex-Client-Identifier': 'saltychart',
      'X-Plex-Product': 'SaltyChart',
      'X-Plex-Platform': 'Chrome',
      'X-Plex-Device': 'Web',
      'X-Plex-Version': '1.0',
      // Plex burns the part's *remembered* subtitle selection into the video
      // unless told otherwise — which showed up as doubled text on top of our
      // own WebVTT track. subtitleStreamID=0 alone is not enough.
      subtitles: 'none',
      subtitleStreamID: '0',
    });
    if (offsetSec > 0) params.set('offset', String(Math.floor(offsetSec)));
    return streamPath(`/video/:/transcode/universal/start.m3u8?${params.toString()}`);
  }

  function authedFetch(rest: string, keepalive = false) {
    return fetch(streamPath(rest), {
      headers: { Authorization: `Bearer ${get(authToken)}` },
      keepalive,
    }).catch(() => {});
  }

  interface SubStream {
    index: number;
    label: string;
    lang: string;
    isEnglish: boolean;
    /** The file's own "this is the one" flag — authoritative. */
    isDefault: boolean;
    /** Signs/songs only, not dialogue. */
    isForced: boolean;
    key: string;
  }
  let subStreams: SubStream[] = [];
  let partId: number | null = null;

  /** The file's subtitle streams, from Plex metadata. */
  async function loadSubtitleList() {
    try {
      const res = await fetch(streamPath(`/library/metadata/${episodeRatingKey}`), {
        headers: { Authorization: `Bearer ${get(authToken)}`, Accept: 'application/json' },
      });
      if (!res.ok) return;
      const part = (await res.json())?.MediaContainer?.Metadata?.[0]?.Media?.[0]?.Part?.[0];
      if (part?.id == null) return;
      partId = part.id;
      subStreams = (part.Stream ?? [])
        .filter((s: any) => s.streamType === 3 && typeof s.index === 'number')
        .map((s: any) => {
          const lang = String(s.languageTag || s.languageCode || 'und');
          const base = String(s.displayTitle || s.language || 'Unknown');
          // Plex shows several distinct tracks as plain "English" — the
          // file's own title ("Dubtitle", "Forced") is what tells them
          // apart, so fold it into the menu label.
          const extra = String(s.title || '');
          const label =
            extra && !base.toLowerCase().includes(extra.toLowerCase())
              ? `${base} (${extra})`
              : base;
          return {
            index: s.index,
            label,
            lang: lang.slice(0, 8),
            isEnglish: /^en/i.test(lang) || /english/i.test(label),
            isDefault: !!s.default,
            isForced: !!s.forced,
            // Sidecar files carry a key; the backend can fetch those directly
            // instead of reading the whole video to extract them.
            key: typeof s.key === 'string' ? s.key : '',
          };
        });
    } catch {}
  }

  function vttUrl(index: number): string {
    const s = subStreams.find((x) => x.index === index);
    const params = new URLSearchParams({
      partId: String(partId),
      streamIndex: String(index),
      token: get(authToken) ?? '',
    });
    if (s?.key) params.set('streamKey', s.key);
    // Hand the server every subtitle index for this file so one extraction
    // pass covers all languages (it reads the source file once either way).
    const all = subStreams.map((x) => x.index).filter((i) => i != null);
    if (all.length) params.set('indexes', all.join(','));
    return `/api/plex/subtitles?${params.toString()}`;
  }

  /**
   * Register the file's subtitle tracks with video.js — but only if no
   * subtitle track is present yet. That covers two cases: Plex's HLS output
   * carrying its own (it never does today — the tracks sit inside the source
   * file as ASS), and a second call after a stream restart, where video.js
   * keeps the remote tracks already added. Either way the viewer uses the
   * same captions menu.
   */
  function addSubtitleTracks() {
    if (!player || partId == null) return;
    const existing = player.textTracks();
    for (let i = 0; i < existing.length; i++) {
      const kind = existing[i].kind;
      if (kind === 'subtitles' || kind === 'captions') return; // stream provided them
    }
    const wantIndex = defaultSubtitleIndex();
    for (const s of subStreams) {
      const el = player.addRemoteTextTrack(
        { src: vttUrl(s.index), kind: 'subtitles', label: s.label, srclang: s.lang },
        false
      );
      // Enable exactly one track by object identity. Matching on the label
      // switched on every English variant at once ("English", "English SDH",
      // "English [Signs & Songs]") — which renders as double subtitles.
      if (el?.track && s.index === wantIndex) el.track.mode = 'showing';
    }
  }

  /**
   * The English track to start with.
   *
   * A plain dialogue track wins: SDH interleaves "[door creaks]" noise,
   * "dubtitle" tracks are written for the dub rather than the Japanese audio,
   * and signs/songs tracks aren't dialogue at all. Releases do sometimes flag
   * one of those as the file's `default`, which is why the flag isn't taken
   * as the answer on its own — it breaks the tie *within* whichever set we're
   * choosing from (a release can ship several plain English tracks and mark
   * the intended one). If nothing plain exists, the flag decides among the
   * rest, and failing that we take the first English track.
   */
  function defaultSubtitleIndex(): number | null {
    const english = subStreams.filter((s) => s.isEnglish && !s.isForced);
    if (!english.length) return null;
    const plain = english.filter((s) => !/sdh|dubtitle|sign|song/i.test(s.label));
    const pool = plain.length ? plain : english;
    return (pool.find((s) => s.isDefault) ?? pool[0]).index;
  }

  // VLC-style speed flash in the video's top-right corner.
  let rateFlashVisible = false;
  let flashTimer: ReturnType<typeof setTimeout> | null = null;
  /** While in the future, video.js is not allowed to mark the user active. */
  let suppressActivityUntil = 0;

  function changeRate(delta: number) {
    const barWasActive = !!player?.userActive?.();
    rate = Math.min(SPEED_MAX, Math.max(SPEED_MIN, +(rate + delta).toFixed(2)));
    player?.playbackRate(rate);
    rateFlashVisible = true;
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => (rateFlashVisible = false), 3000);
    // Changing speed must not count as "user activity" — the corner flash is
    // the feedback. Every activity path in video.js funnels through
    // reportUserActivity, so gate that (see the wrapper in onMount) instead
    // of trying to clear the flag afterwards, which loses the race.
    if (!barWasActive) {
      suppressActivityUntil = Date.now() + 600;
      player?.userActive(false);
    }
  }

  // ── Self-heal ────────────────────────────────────────────────────────
  // Plex sometimes drops a transcode session while it's still being played
  // (its segments and the session ping start returning 404). video.js then
  // retries the dead playlist forever, which looks like an endless buffer.
  // When playback stops advancing, start a fresh session at the same spot.
  let lastProgressTime = 0;
  let lastProgressAt = Date.now();
  let watchdog: ReturnType<typeof setInterval> | null = null;
  let heals = 0;

  function startStallWatchdog() {
    if (watchdog || !player) return;
    lastProgressTime = player.currentTime() ?? 0;
    lastProgressAt = Date.now();
    player.on('timeupdate', () => {
      const t = player?.currentTime?.() ?? 0;
      if (Math.abs(t - lastProgressTime) > 0.25) {
        lastProgressTime = t;
        lastProgressAt = Date.now();
        heals = 0; // playback recovered
      }
    });
    // NOTE: deliberately does *not* skip while `seeking()` is true — a seek
    // that lands outside the transcoded range is the main way playback gets
    // stuck, so that's exactly when the restart is needed.
    watchdog = setInterval(() => {
      if (!player || player.paused()) return;
      // A restart already in flight is the fix in progress — piling another
      // on top stacks loadedmetadata handlers and churns the transcoder.
      if (restarting) return;
      if (Date.now() - lastProgressAt < 10_000) return;
      if (heals >= 5) return; // don't loop forever on a genuinely dead stream
      heals++;
      restartStream(player.currentTime() ?? 0);
    }, 3000);

    // Plex serves one fixed transcode session per playlist: seeking beyond
    // what it has produced yields 404s that VHS retries forever. Jumping
    // outside the buffer therefore needs a fresh session at that position.
    player.on('seeked', () => {
      const target = player?.currentTime?.() ?? 0;
      if (!player || isBuffered(target)) return;
      // Loading a stream at an offset makes the player seek to that offset,
      // which lands here before anything is buffered. Treating that as a new
      // user seek would restart at the same spot, forever.
      if (restarting && Math.abs(target - restartTarget) < 5) return;
      lastProgressAt = Date.now();
      // A genuine seek arriving mid-restart would otherwise be swallowed by
      // the source swap: remember it and apply once the new stream is ready.
      if (restarting) {
        pendingSeek = target;
        return;
      }
      restartStream(target);
    });
  }

  /** Is this position already downloaded (so a normal seek will just work)? */
  function isBuffered(t: number): boolean {
    const b = player?.buffered?.();
    if (!b) return false;
    for (let i = 0; i < b.length; i++) {
      if (t >= b.start(i) && t <= b.end(i) - 0.5) return true;
    }
    return false;
  }

  let restarting = false;
  let restartTarget = 0;
  let pendingSeek: number | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Reposition playback to `atSec`.
   *
   * Deliberately keeps the SAME session id and just re-requests the playlist
   * with a new `offset` — that's what Plex's own clients do, and Plex moves
   * the existing transcoder rather than spawning another (verified: the
   * session count is unchanged after a reseek). Minting a session per seek
   * churned through them and leaked one whenever a /stop was missed.
   */
  function restartStream(atSec: number) {
    if (!player) return;
    restarting = true;
    restartTarget = atSec;
    pendingSeek = null;
    lastProgressAt = Date.now();
    // If the new source never reaches loadedmetadata (Plex refused it, network
    // dropped), the flag must not latch — a stuck `restarting` silently
    // swallows every later seek.
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      restarting = false;
    }, 30_000);
    player.src({ src: sourceUrl(atSec), type: 'application/x-mpegURL' });
    player.one('loadedmetadata', () => {
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      player.playbackRate(rate);
      addSubtitleTracks();
      restarting = false;
      lastProgressAt = Date.now();
      // Honour whatever the viewer asked for while this was loading.
      if (pendingSeek != null) {
        const next = pendingSeek;
        pendingSeek = null;
        restartStream(next);
      }
    });
    player.play()?.catch?.(() => {});
  }

  function handleKey(e: KeyboardEvent) {
    const target = e.target as HTMLElement | null;
    if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
    if (e.key === ']') changeRate(+0.1);
    else if (e.key === '[') changeRate(-0.1);
    else if (e.key === 'Escape' && !player?.isFullscreen?.()) dispatch('close');
    else return;
    e.stopPropagation();
    e.preventDefault();
  }

  /**
   * Register the Chromecast plugin and load Google's Cast sender SDK.
   * Returns false (and the player just skips casting) if the SDK can't load
   * — e.g. no internet, or a browser without the Cast framework.
   */
  async function setupChromecast(videojs: any): Promise<boolean> {
    // The Cast sender SDK only initialises in a secure context. SaltyChart is
    // served over plain http on the LAN, so loading it there would delay every
    // player open for a button that can never appear. This lights up on its
    // own if the app is ever served over https.
    if (!window.isSecureContext) return false;
    try {
      const [{ default: chromecast }] = await Promise.all([
        import('@silvermine/videojs-chromecast'),
        import('@silvermine/videojs-chromecast/dist/silvermine-videojs-chromecast.css'),
      ]);
      chromecast(videojs);
      if (!(window as any).__castSdkLoading) {
        (window as any).__castSdkLoading = new Promise<void>((resolve, reject) => {
          const s = document.createElement('script');
          s.src = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
          s.onload = () => resolve();
          s.onerror = () => reject(new Error('cast sdk blocked'));
          document.head.appendChild(s);
        });
      }
      await (window as any).__castSdkLoading;
      return true;
    } catch {
      return false; // casting simply isn't offered
    }
  }

  onMount(async () => {
    const videojs = (await import('video.js')).default;
    await import('video.js/dist/video-js.css');
    if (destroyed) return;

    // Chromecast is a video.js plugin (@silvermine/videojs-chromecast); it
    // needs Google's Cast sender SDK, loaded once and only when a player
    // actually opens.
    const chromecastReady = await setupChromecast(videojs);
    if (destroyed) return; // closed while the Cast SDK was loading

    player = videojs(videoEl, {
      controls: true,
      // Playback is started by hand once the English subtitle track is in —
      // see the subtitle warm-up below. Autoplaying an anime episode before
      // its subtitles land means missing the opening dialogue.
      autoplay: false,
      preload: 'auto',
      fluid: true,
      playbackRates: SPEED_STEPS,
      userActions: { hotkeys: true },
      // video.js remembers caption styling (its "captions settings" dialog)
      // in localStorage for us.
      persistTextTrackSettings: true,
      // Draw the frame while dragging the scrubber instead of only on release.
      enableSmoothSeeking: true,
      // Sharper than the default icon font.
      experimentalSvgIcons: true,
      controlBar: {
        // PiP removed deliberately — the browser's mini-player fights the
        // modal and the transcode session; use fullscreen instead.
        pictureInPictureToggle: false,
        // ±10s jump buttons (the components ship with video.js; they only
        // render once given a step size).
        skipButtons: { forward: 10, backward: 10 },
      },
      ...(chromecastReady
        ? {
            techOrder: ['chromecast', 'html5'],
            plugins: { chromecast: {} },
          }
        : {}),
    });

    // Our JWT on every playlist/segment request; the proxy validates it and
    // injects the Plex token server-side.
    // Every "the user did something" path in video.js ends up here, so this
    // is the one place that can reliably stop the speed keys from waking the
    // control bar.
    const reportActivity = player.reportUserActivity.bind(player);
    player.reportUserActivity = (event: any) => {
      if (Date.now() < suppressActivityUntil) return;
      reportActivity(event);
    };

    // Caption styling defaults, applied only until the viewer sets their own
    // (video.js then persists whatever they chose).
    if (!localStorage.getItem('vjs-text-track-settings') && player.textTrackSettings) {
      player.textTrackSettings.setValues({
        backgroundOpacity: '0', // transparent background
        color: '#FFF', // white text
        edgeStyle: 'uniform', // uniform outline
      });
      player.textTrackSettings.updateDisplay();
    }

    if (flashEl && player.el()) {
      flashHome = flashEl.parentElement;
      player.el().appendChild(flashEl);
    }

    player.on('xhr-hooks-ready', () => {
      player.tech({ IWillNotUseThisInPlugins: true })?.vhs?.xhr?.onRequest?.((options: any) => {
        options.beforeSend = (xhr: XMLHttpRequest) => {
          xhr.setRequestHeader('Authorization', `Bearer ${get(authToken)}`);
        };
        return options;
      });
    });

    // Keep the speed badge in sync when the rate is changed from video.js's menu.
    player.on('ratechange', () => {
      const r = player.playbackRate();
      if (typeof r === 'number') rate = r;
    });

    // Subtitle extraction reads the whole source file, which can take tens of
    // seconds the first time an episode is opened — so playback never waits
    // for it. The English track is fetched in the background and switched on
    // the moment it's ready (instant when already cached).
    await loadSubtitleList();
    // Stop Plex burning its remembered subtitle selection into the video —
    // it ignores subtitles=none on the stream URL, so the part's selection
    // must be cleared before the transcode starts, or every subtitle appears
    // twice (burned copy + our text track).
    if (partId != null) {
      await fetch(`/api/plex/clear-burn/${partId}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${get(authToken)}` },
      }).catch(() => {});
    }
    if (destroyed || !player) return; // closed while the metadata calls ran

    player.src({ src: sourceUrl(), type: 'application/x-mpegURL' });
    player.one('loadedmetadata', startStallWatchdog);

    // Fetch the English track *before* starting playback. The request itself
    // triggers the extraction, and one pass covers every language. Tracks are
    // only registered once that lands: attaching them earlier makes the
    // browser eagerly fetch each one into the still-running extraction, and
    // those stalled loads surface as video.js ParsingErrors.
    //
    // The video is loaded (and buffering) throughout, so once the track
    // arrives playback starts instantly. On a repeat play the subtitles are
    // cached and this is imperceptible; only a first open waits.
    const wantIndex = defaultSubtitleIndex();
    if (wantIndex != null) {
      subtitlesLoading = true;
      // A pathological extraction must not strand the viewer on a black
      // screen forever — start without subtitles rather than never start.
      subtitleWaitTimer = setTimeout(startPlayback, SUBTITLE_WAIT_MS);
      fetch(vttUrl(wantIndex))
        .catch(() => {})
        .finally(() => {
          subtitlesLoading = false;
          addSubtitleTracks();
          startPlayback();
        });
    } else {
      // Nothing to wait for — this file has no English subtitles.
      addSubtitleTracks();
      startPlayback();
    }

    // Plex reaps a transcode session that stops being pinged.
    pingTimer = setInterval(() => {
      authedFetch(`/video/:/transcode/universal/ping?session=${session}`);
    }, 30_000);
    window.addEventListener('keydown', handleKey, { capture: true });
  });

  onDestroy(() => {
    destroyed = true;
    if (pingTimer) clearInterval(pingTimer);
    if (watchdog) clearInterval(watchdog);
    if (flashTimer) clearTimeout(flashTimer);
    if (restartTimer) clearTimeout(restartTimer);
    if (subtitleWaitTimer) clearTimeout(subtitleWaitTimer);
    window.removeEventListener('keydown', handleKey, { capture: true });
    // Hand the flash back to Svelte before video.js destroys its subtree,
    // otherwise Svelte's own cleanup can't find the node.
    if (flashEl && flashHome && flashEl.parentElement !== flashHome) flashHome.appendChild(flashEl);
    player?.dispose?.();
    player = null;
    authedFetch(`/video/:/transcode/universal/stop?session=${session}`, true);
  });
</script>

<dialog open class="modal z-[999]">
  <div class="modal-box w-full max-w-5xl p-3 flex flex-col gap-2">
    <div class="flex items-center justify-between gap-2">
      <h3 class="font-bold text-lg truncate">
        {title}
        {#if episodeTitle}<span class="opacity-60 font-normal"> — {episodeTitle}</span>{/if}
      </h3>
      <button class="btn btn-sm btn-circle btn-ghost shrink-0" aria-label="Close player" on:click={() => dispatch('close')}>✕</button>
    </div>

    <div class="relative">
      <!-- svelte-ignore a11y-media-has-caption -->
      <video bind:this={videoEl} class="video-js vjs-big-play-centered w-full" playsinline></video>

      {#if subtitlesLoading}
        <!-- Playback is held until the English track lands; the button is the
             escape hatch for a slow extraction. -->
        <div class="absolute top-3 left-4 z-20 flex items-center gap-2 rounded bg-black/60 px-2 py-1 text-white">
          <span class="loading loading-spinner loading-xs"></span>
          <span class="text-xs">Loading subtitles…</span>
          {#if !playbackStarted}
            <button class="btn btn-xs btn-ghost text-white" on:click={startPlayback}>Play anyway</button>
          {/if}
        </div>
      {/if}

      <div
        bind:this={flashEl}
        class="pointer-events-none absolute top-3 right-4 z-30 select-none font-bold tabular-nums text-white text-4xl md:text-5xl transition-opacity duration-500 {rateFlashVisible ? 'opacity-100' : 'opacity-0'}"
        style="text-shadow: -2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000, 0 0 6px rgba(0,0,0,.8);"
        aria-hidden="true"
      >
        x{rate.toFixed(2)}
      </div>
    </div>

    <p class="text-xs opacity-50 m-0">
      <kbd class="kbd kbd-xs">[</kbd>/<kbd class="kbd kbd-xs">]</kbd> change speed by 0.10×.
      Playback uses the server account — progress won't sync to your own Plex profile.
    </p>
  </div>
</dialog>

<style>
  /* video.js ships elapsed/total time but its default skin hides them in
     favour of remaining-time only. Needs the .vjs-control-bar ancestor to
     outrank video.js's own `.video-js .vjs-current-time { display: none }`. */
  :global(.video-js .vjs-control-bar .vjs-current-time),
  :global(.video-js .vjs-control-bar .vjs-time-divider),
  :global(.video-js .vjs-control-bar .vjs-duration) {
    display: flex;
    align-items: center;
    padding-left: 0.3em;
    padding-right: 0.3em;
  }
  :global(.video-js .vjs-control-bar .vjs-time-divider) {
    min-width: 0.6em;
    justify-content: center;
  }
  /* Elapsed / total already say it; the countdown is redundant clutter. */
  :global(.video-js .vjs-control-bar .vjs-remaining-time) {
    display: none;
  }

  /* video.js drops subtitles to bottom:1em while the controls are hidden and
     lifts them to 3em when they appear, so they hop every time the bar slides
     in or out. Pin them clear of the bar instead. */
  :global(.video-js .vjs-text-track-display) {
    bottom: 3em !important;
  }
</style>
