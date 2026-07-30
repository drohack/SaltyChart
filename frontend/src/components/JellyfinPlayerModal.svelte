<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import { get } from 'svelte/store';
  import { authToken } from '../stores/auth';

  // A thin wrapper around video.js (Apache-2.0). video.js owns the player:
  // control bar, menus, fullscreen, keyboard, error handling. Two things are
  // added on top:
  //   1. 0.10x speed stepping on [ and ] — the reason this exists at all,
  //      since Plex's and Jellyfin's own players are locked to coarser steps.
  //   2. ASS subtitle rendering via libass (jassub), because anime releases
  //      put signs, songs and karaoke in ASS and WebVTT cannot represent any
  //      of it — positioning, transforms and drawings are simply lost.

  /** Jellyfin ItemId of the episode. */
  export let itemId: string;
  /** Which media source (a file) of that item to play. */
  export let mediaSourceId: string;
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
  let rate = 1.0;
  // onMount awaits can outlive a quick close; every await point re-checks this.
  let destroyed = false;

  // 0.10 steps across 0.2x–4.0x, used for both the keys and video.js's speed
  // menu so the two can't disagree.
  const SPEED_MIN = 0.2;
  const SPEED_MAX = 4;
  const SPEED_STEPS = Array.from(
    { length: Math.round((SPEED_MAX - SPEED_MIN) / 0.1) + 1 },
    (_, i) => +(SPEED_MIN + i * 0.1).toFixed(2)
  );

  interface SubStream {
    index: number;
    codec: string;
    language: string;
    title: string;
    displayTitle: string;
    isDefault: boolean;
    isForced: boolean;
    isHearingImpaired: boolean;
    isTextSubtitle: boolean;
  }
  interface Attachment {
    index: number;
    fileName: string;
    mimeType: string;
  }

  let subStreams: SubStream[] = [];
  let attachments: Attachment[] = [];
  let playSessionId = '';
  let activeSubIndex: number | null = null;
  let subtitlesLoading = false;
  let playbackStarted = false;
  /** Playback waits for subtitles, but never longer than this. */
  const SUBTITLE_WAIT_MS = 20_000;
  let subtitleWaitTimer: ReturnType<typeof setTimeout> | null = null;
  let jassub: any = null;

  function api(path: string): string {
    return `/api/jellyfin${path}`;
  }

  /** Jellyfin's HLS URL for this episode, served through our proxy. */
  function sourceUrl(): string {
    const params = new URLSearchParams({
      mediaSourceId,
      playSessionId,
      videoCodec: 'h264',
      audioCodec: 'aac',
      container: 'ts',
      deviceId: 'saltychart',
      maxStreamingBitrate: '120000000',
      // NOT subtitleMethod=Hls — Jellyfin embeds the caller's own API key in
      // subtitle rendition URIs, which would publish it to every viewer. The
      // proxy rejects such a manifest anyway; this keeps us from asking.
    });
    return api(`/stream/Videos/${itemId}/master.m3u8?${params.toString()}`);
  }

  function subtitleUrl(index: number, format: 'ass' | 'vtt'): string {
    const params = new URLSearchParams({
      itemId,
      mediaSourceId,
      index: String(index),
      format,
      token: get(authToken) ?? '',
    });
    return api(`/subtitles?${params.toString()}`);
  }

  function fontUrl(index: number): string {
    const params = new URLSearchParams({
      itemId,
      mediaSourceId,
      index: String(index),
      token: get(authToken) ?? '',
    });
    return api(`/attachments?${params.toString()}`);
  }

  /**
   * The track to start with.
   *
   * A plain English dialogue track wins: SDH interleaves "[door creaks]",
   * "dubtitle" tracks are written for the dub rather than the Japanese audio,
   * and signs/songs tracks aren't dialogue at all. The file's own flags break
   * the tie within that set rather than deciding on their own, because
   * releases do ship with a signs-only track marked default.
   *
   * ASS is preferred over SRT of the same content: libass renders it exactly,
   * and this library has episodes whose track *names* are useless ('1', '2',
   * 'final'), so codec and flags are what can be trusted.
   */
  function defaultSubtitleIndex(): number | null {
    const label = (s: SubStream) => `${s.title} ${s.displayTitle}`;
    const english = subStreams.filter(
      (s) => /^en/i.test(s.language) || /english/i.test(label(s))
    );
    const usable = (english.length ? english : subStreams).filter((s) => !s.isForced);
    if (!usable.length) return null;
    const plain = usable.filter(
      (s) => !s.isHearingImpaired && !/sdh|dubtitle|sign|song/i.test(label(s))
    );
    const pool = plain.length ? plain : usable;
    const ass = pool.filter((s) => /ass|ssa/i.test(s.codec));
    const preferred = ass.length ? ass : pool;
    return (preferred.find((s) => s.isDefault) ?? preferred[0]).index;
  }

  function isAss(index: number): boolean {
    const s = subStreams.find((x) => x.index === index);
    return !!s && /ass|ssa/i.test(s.codec);
  }

  /** Template expressions can't carry TS casts, so the handler lives here. */
  function onSubtitlePicked(e: Event) {
    const v = (e.currentTarget as HTMLSelectElement).value;
    showSubtitle(v === '' ? null : Number(v));
  }

  function trackLabel(s: SubStream): string {
    const name = s.displayTitle || s.title || s.language || 'Unknown';
    const extra = [
      s.isHearingImpaired ? 'SDH' : '',
      s.isForced ? 'Forced' : '',
      /ass|ssa/i.test(s.codec) ? 'ASS' : '',
    ].filter(Boolean);
    return extra.length ? `${name} (${extra.join(', ')})` : name;
  }

  // ── Subtitle rendering ───────────────────────────────────────────────
  //
  // ASS goes through libass so signs land where the release put them; plain
  // text formats use video.js's own text tracks, which is less machinery for
  // the same result.
  async function showSubtitle(index: number | null) {
    activeSubIndex = index;
    destroyJassub();
    clearVjsTracks();
    if (index == null) return;

    if (isAss(index)) {
      subtitlesLoading = true;
      try {
        const res = await fetch(subtitleUrl(index, 'ass'));
        if (!res.ok) throw new Error(`subtitles ${res.status}`);
        const subContent = await res.text();
        if (destroyed || !player) return;
        const [{ default: JASSUB }, workerUrl, wasmUrl, modernWasmUrl] = await Promise.all([
          import('jassub'),
          // `dist/worker/worker.js` is jassub's worker entry point.
          // `dist/wasm/jassub-worker.js` — which its README names, and which
          // is stale for 2.x — is the emscripten glue and never completes the
          // handshake, so `ready` hangs and `renderer` stays undefined.
          // `?worker&url` so Vite rewrites the worker's own imports.
          import('jassub/dist/worker/worker.js?worker&url'),
          import('jassub/dist/wasm/jassub-worker.wasm?url'),
          import('jassub/dist/wasm/jassub-worker-modern.wasm?url'),
        ]);
        if (destroyed || !player) return;
        jassub = new JASSUB({
          video: videoEl,
          subContent,
          workerUrl: (workerUrl as any).default,
          wasmUrl: (wasmUrl as any).default,
          modernWasmUrl: (modernWasmUrl as any).default,
          // The release's own fonts, straight out of the MKV. Without them
          // libass substitutes and signs render in the wrong typeface.
          fonts: attachments
            .filter((a) => /font|otf|ttf/i.test(`${a.mimeType} ${a.fileName}`))
            .map((a) => fontUrl(a.index)),
        });
        // libass sizes its canvas from the video's `loadedmetadata`, so it has
        // to be constructed BEFORE that fires — waiting for dimensions first
        // makes it miss the event and leaves a 300x150 canvas parked below the
        // player forever. These hooks cover the box changing afterwards.
        // libass only signals readiness once its worker is up. If that never
        // happens we must not sit there with no subtitles at all — fall back
        // to the server-converted WebVTT, which needs no worker.
        await Promise.race([
          jassub.ready,
          new Promise((_, reject) => setTimeout(() => reject(new Error('libass worker never started')), 8000)),
        ]);
        if (destroyed || !player) return;
        // libass sizes its canvas from the video's box; these cover the box
        // changing after it has attached.
        resizeJassub();
        player.on('playing', resizeJassub);
        player.on('fullscreenchange', resizeJassub);
        player.on('playerresize', resizeJassub);
      } catch (err) {
        // The usual cause is no SharedArrayBuffer: libass needs the page to be
        // cross-origin isolated (COOP/COEP), and those headers would block the
        // YouTube trailer iframes on Home. Server-converted WebVTT loses ASS
        // positioning and karaoke, but it is subtitles, and it always works.
        console.warn('[player] libass unavailable, using WebVTT instead:', err);
        destroyJassub();
        addVjsTrack(index);
      } finally {
        subtitlesLoading = false;
      }
      return;
    }

    subtitlesLoading = true;
    try {
      // Warm it so playback doesn't start before the cues exist.
      await fetch(subtitleUrl(index, 'vtt')).catch(() => {});
    } finally {
      subtitlesLoading = false;
    }
    if (destroyed || !player) return;
    addVjsTrack(index);
  }

  function addVjsTrack(index: number) {
    const s = subStreams.find((x) => x.index === index);
    if (!player || !s) return;
    const el = player.addRemoteTextTrack(
      {
        src: subtitleUrl(index, 'vtt'),
        kind: 'subtitles',
        label: trackLabel(s),
        srclang: s.language || 'und',
      },
      false
    );
    // Enable by object identity: matching on labels switched on every English
    // variant at once, which renders as doubled subtitles.
    if (el?.track) el.track.mode = 'showing';
  }

  function clearVjsTracks() {
    if (!player) return;
    const tracks = player.remoteTextTracks?.();
    for (let i = (tracks?.length ?? 0) - 1; i >= 0; i--) {
      player.removeRemoteTextTrack(tracks[i]);
    }
  }

  function destroyJassub() {
    try {
      jassub?.destroy?.();
    } catch {}
    jassub = null;
  }

  /**
   * video.js fires `playerresize` while libass's worker is still starting, and
   * resize() reaches into the renderer, so it must wait on jassub's own `ready`
   * promise or it throws on every early resize event.
   */
  function resizeJassub() {
    const inst = jassub;
    if (!inst) return;
    Promise.resolve(inst.ready)
      .then(() => {
        if (jassub === inst) inst.resize?.();
      })
      .catch(() => {});
  }

  // ── Speed control (the reason this component exists) ──────────────────
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

  // ── Stall detection ──────────────────────────────────────────────────
  //
  // Deliberately much smaller than the Plex version, which had to re-request
  // the playlist at a new offset because Plex only produced segments forward
  // from where a session started. Jellyfin serves a complete VOD playlist and
  // repositions its own transcoder when an out-of-range segment is requested,
  // so seeking is the browser's job. What remains is a safety net: VHS retries
  // a sole playlist forever, so a genuinely dead stream would spin silently
  // rather than surface an error.
  let lastProgressTime = 0;
  let lastProgressAt = Date.now();
  let watchdog: ReturnType<typeof setInterval> | null = null;
  let stalled = false;

  function startStallWatchdog() {
    if (watchdog || !player) return;
    lastProgressTime = player.currentTime() ?? 0;
    lastProgressAt = Date.now();
    player.on('timeupdate', () => {
      const t = player?.currentTime?.() ?? 0;
      if (Math.abs(t - lastProgressTime) > 0.25) {
        lastProgressTime = t;
        lastProgressAt = Date.now();
        stalled = false;
      }
    });
    watchdog = setInterval(() => {
      if (!player || player.paused() || !playbackStarted) return;
      stalled = Date.now() - lastProgressAt > 20_000;
    }, 3000);
  }

  /**
   * Register the Chromecast plugin and load Google's Cast sender SDK.
   * Returns false (and the player just skips casting) if the SDK can't load.
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

    const chromecastReady = await setupChromecast(videojs);
    if (destroyed) return; // closed while the Cast SDK was loading

    player = videojs(videoEl, {
      controls: true,
      // Playback is started by hand once subtitles are in — see below.
      autoplay: false,
      preload: 'auto',
      fluid: true,
      playbackRates: SPEED_STEPS,
      userActions: { hotkeys: true },
      persistTextTrackSettings: true,
      enableSmoothSeeking: true,
      experimentalSvgIcons: true,
      controlBar: {
        // PiP removed deliberately — the browser's mini-player fights the
        // modal and the transcode session; use fullscreen instead.
        pictureInPictureToggle: false,
        skipButtons: { forward: 10, backward: 10 },
      },
      ...(chromecastReady ? { techOrder: ['chromecast', 'html5'], plugins: { chromecast: {} } } : {}),
    });

    // Every "the user did something" path in video.js ends up here, so this is
    // the one place that can reliably stop the speed keys waking the bar.
    const reportActivity = player.reportUserActivity.bind(player);
    player.reportUserActivity = (event: any) => {
      if (Date.now() < suppressActivityUntil) return;
      reportActivity(event);
    };

    // Caption styling defaults, applied only until the viewer sets their own.
    if (!localStorage.getItem('vjs-text-track-settings') && player.textTrackSettings) {
      player.textTrackSettings.setValues({
        backgroundOpacity: '0',
        color: '#FFF',
        edgeStyle: 'uniform',
      });
      player.textTrackSettings.updateDisplay();
    }

    if (flashEl && player.el()) {
      flashHome = flashEl.parentElement;
      player.el().appendChild(flashEl);
    }

    // Our JWT on every playlist/segment request; the proxy validates it and
    // injects the Jellyfin key server-side.
    player.on('xhr-hooks-ready', () => {
      player.tech({ IWillNotUseThisInPlugins: true })?.vhs?.xhr?.onRequest?.((options: any) => {
        options.beforeSend = (xhr: XMLHttpRequest) => {
          xhr.setRequestHeader('Authorization', `Bearer ${get(authToken)}`);
        };
        return options;
      });
    });

    player.on('ratechange', () => {
      const r = player.playbackRate();
      if (typeof r === 'number') rate = r;
    });

    // One call for the session id, the subtitle tracks and the embedded fonts.
    try {
      const res = await fetch(
        api(`/playback/${itemId}?mediaSourceId=${encodeURIComponent(mediaSourceId)}`),
        { headers: { Authorization: `Bearer ${get(authToken)}` } }
      );
      if (res.ok) {
        const info = await res.json();
        playSessionId = info.playSessionId ?? '';
        subStreams = info.subtitles ?? [];
        attachments = info.attachments ?? [];
      }
    } catch (err) {
      console.warn('[player] playback info failed', err);
    }
    if (destroyed || !player) return;

    player.src({ src: sourceUrl(), type: 'application/x-mpegURL' });
    player.one('loadedmetadata', startStallWatchdog);

    // Start with subtitles already showing: an anime episode that begins
    // before its subtitles arrive means missing the opening dialogue.
    const wantIndex = defaultSubtitleIndex();
    if (wantIndex != null) {
      // A pathological fetch must not strand the viewer on a black screen.
      subtitleWaitTimer = setTimeout(startPlayback, SUBTITLE_WAIT_MS);
      showSubtitle(wantIndex).finally(startPlayback);
    } else {
      startPlayback();
    }

    window.addEventListener('keydown', handleKey, { capture: true });
  });

  onDestroy(() => {
    destroyed = true;
    if (watchdog) clearInterval(watchdog);
    if (flashTimer) clearTimeout(flashTimer);
    if (subtitleWaitTimer) clearTimeout(subtitleWaitTimer);
    window.removeEventListener('keydown', handleKey, { capture: true });
    destroyJassub();
    // Hand the flash back to Svelte before video.js destroys its subtree,
    // otherwise Svelte's own cleanup can't find the node.
    if (flashEl && flashHome && flashEl.parentElement !== flashHome) flashHome.appendChild(flashEl);
    player?.dispose?.();
    player = null;
    // Let Jellyfin tear the transcode down rather than waiting for it to time
    // out on a box that is also serving everyone else.
    if (playSessionId) {
      fetch(api('/playback/stop'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${get(authToken)}` },
        body: JSON.stringify({ playSessionId }),
        keepalive: true,
      }).catch(() => {});
    }
  });
</script>

<dialog open class="modal z-[999]">
  <div class="modal-box w-full max-w-5xl p-3 flex flex-col gap-2">
    <div class="flex items-center justify-between gap-2">
      <h3 class="font-bold text-lg truncate">
        {title}
        {#if episodeTitle}<span class="opacity-60 font-normal"> — {episodeTitle}</span>{/if}
      </h3>
      <button
        class="btn btn-sm btn-circle btn-ghost shrink-0"
        aria-label="Close player"
        on:click={() => dispatch('close')}>✕</button
      >
    </div>

    <div class="relative">
      <!-- svelte-ignore a11y-media-has-caption -->
      <video bind:this={videoEl} class="video-js vjs-big-play-centered w-full" playsinline></video>

      {#if subtitlesLoading}
        <div
          class="absolute top-3 left-4 z-20 flex items-center gap-2 rounded bg-black/60 px-2 py-1 text-white"
        >
          <span class="loading loading-spinner loading-xs"></span>
          <span class="text-xs">Loading subtitles…</span>
          {#if !playbackStarted}
            <button class="btn btn-xs btn-ghost text-white" on:click={startPlayback}
              >Play anyway</button
            >
          {/if}
        </div>
      {/if}

      {#if stalled}
        <div class="absolute inset-x-0 bottom-16 z-20 flex justify-center">
          <div class="rounded bg-error/90 px-3 py-1 text-sm text-error-content">
            Playback stalled — try closing and reopening.
          </div>
        </div>
      {/if}

      <div
        bind:this={flashEl}
        class="pointer-events-none absolute top-3 right-4 z-30 select-none font-bold tabular-nums text-white text-4xl md:text-5xl transition-opacity duration-500 {rateFlashVisible
          ? 'opacity-100'
          : 'opacity-0'}"
        style="text-shadow: -2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000, 0 0 6px rgba(0,0,0,.8);"
        aria-hidden="true"
      >
        x{rate.toFixed(2)}
      </div>
    </div>

    <!-- libass paints its own canvas and bypasses video.js's captions menu,
         so track selection lives here instead. -->
    {#if subStreams.length}
      <div class="flex items-center gap-2 text-sm">
        <label class="opacity-70" for="sub-picker">Subtitles</label>
        <select
          id="sub-picker"
          class="select select-bordered select-xs max-w-xs"
          value={activeSubIndex}
          on:change={onSubtitlePicked}
        >
          <option value="">Off</option>
          {#each subStreams as s (s.index)}
            <option value={s.index}>{trackLabel(s)}</option>
          {/each}
        </select>
      </div>
    {/if}

    <p class="text-xs opacity-50 m-0">
      <kbd class="kbd kbd-xs">[</kbd> / <kbd class="kbd kbd-xs">]</kbd> change speed by 0.10×
    </p>
  </div>
</dialog>

<style>
  /* The default skin hides these; they're the most useful readouts there are. */
  :global(.video-js .vjs-control-bar .vjs-current-time),
  :global(.video-js .vjs-control-bar .vjs-time-divider),
  :global(.video-js .vjs-control-bar .vjs-duration) {
    display: block;
  }
  /* Keep WebVTT captions clear of the control bar; video.js otherwise drops
     them to 1em while the bar is hidden, so they hop as it slides in and out. */
  :global(.video-js .vjs-text-track-display) {
    bottom: 3em !important;
  }
</style>
