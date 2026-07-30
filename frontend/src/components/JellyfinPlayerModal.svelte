<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import { get } from 'svelte/store';
  import { authToken } from '../stores/auth';
  import {
    api,
    defaultSubtitleIndex,
    fontsFor,
    fontUrl as buildFontUrl,
    isAss as isAssTrack,
    castReady,
    loadLibass,
    loadVideoJs,
    playbackInfo,
    subtitleText,
    subtitleUrl as buildSubtitleUrl,
    type Attachment,
    type SubStream,
  } from '../lib/jellyfinPrewarm';

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

  let subStreams: SubStream[] = [];
  let attachments: Attachment[] = [];
  let playSessionId = '';
  let activeSubIndex: number | null = null;
  let subtitlesLoading = false;
  /** The video has enough data to play, so any remaining wait really is ours. */
  let videoReady = false;
  let playbackStarted = false;
  /** Playback waits for subtitles, but never longer than this. */
  const SUBTITLE_WAIT_MS = 20_000;
  let subtitleWaitTimer: ReturnType<typeof setTimeout> | null = null;
  let jassub: any = null;

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

  const subtitleUrl = (index: number, format: 'ass' | 'vtt') =>
    buildSubtitleUrl(itemId, mediaSourceId, index, format);
  const fontUrl = (index: number) => buildFontUrl(itemId, mediaSourceId, index);

  // Track choice and ASS detection live in the prewarm module so the pop-up
  // warms exactly the track the player will end up showing.
  const isAss = (index: number) => isAssTrack(subStreams, index);

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
    subtitleMenu?.update(); // move the tick, whoever asked for the change
    destroyJassub();
    clearVjsTracks();
    if (index == null) return;

    if (isAss(index)) {
      subtitlesLoading = true;
      try {
        // Both of these are usually already resolved — the show pop-up warmed
        // them while the viewer was reading the synopsis.
        const subContent = await subtitleText(subtitleUrl(index, 'ass'));
        if (destroyed || !player) return;
        const { JASSUB, workerUrl, wasmUrl, modernWasmUrl, defaultFontUrl } = await loadLibass();
        if (destroyed || !player) return;
        const { initial, deferred } = fontsFor(subContent, attachments);
        jassub = new JASSUB({
          video: videoEl,
          subContent,
          workerUrl,
          wasmUrl,
          modernWasmUrl,
          // The release's own fonts, straight out of the MKV. Without them
          // libass substitutes and signs render in the wrong typeface.
          fonts: initial.map((a) => fontUrl(a.index)),
          // The substitute for anything those don't cover, and **both lines are
          // required**. Scripts routinely name a font their own MKV doesn't
          // carry — The Elusive Samurai asks for "Arial Unicode MS" and
          // attaches only plain Arial. jassub registers its bundled fallback in
          // `availableFonts` on its own, but never nominates it as the default
          // family, so libass had no face to substitute and drew *nothing*:
          // empty frames, worker healthy, canvas correctly sized, no error
          // anywhere. `defaultFont` is what actually makes it substitute.
          //
          // The URL is passed explicitly because jassub resolves its own copy
          // as `new URL('./default.woff2', import.meta.url)` — a runtime URL
          // relative to its bundle, which under Vite points into
          // `node_modules/.vite/deps/` where the file isn't.
          availableFonts: { 'liberation sans': defaultFontUrl },
          defaultFont: 'liberation sans',
        });
        // A safety net that should never fire: libass resolves `ready` once its
        // worker is up, and if that never happens we must not sit on a blank
        // screen — the server-converted WebVTT needs no worker. But falling
        // back is a *silent* downgrade of the whole reason this player exists,
        // and it once fired for every ASS release because of a bad workerUrl.
        // `test_player.py` step 8 fails on the warning below so that can't
        // recur quietly; treat it firing as a bug, not as the net working.
        await Promise.race([
          jassub.ready,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('libass worker never started')), 8000)
          ),
        ]);
        if (destroyed || !player) return;
        // jassub keeps its own ResizeObserver on the video, so it self-corrects
        // as the box changes; these cover the video.js-specific moments that
        // resize the player without resizing the element it watches.
        resizeJassub();
        player.on('playing', resizeJassub);
        player.on('fullscreenchange', resizeJassub);
        player.on('playerresize', resizeJassub);
        topUpFonts(deferred);
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

  /**
   * Insurance against the font-name heuristic.
   *
   * `fontsFor` matches a script's font names against attachment *filenames*,
   * and a file called `f1.ttf` can hold "Helvetica Neue". When a name found no
   * file, the leftovers arrive here and are added once rendering is already
   * under way — so a bad guess costs a moment of substituted type rather than
   * the wrong typeface for the whole episode. Nothing is queued when every
   * name matched, which is the common case.
   */
  function topUpFonts(deferred: Attachment[]) {
    if (!deferred.length || !jassub) return;
    const inst = jassub;
    Promise.resolve(inst.ready)
      .then(() => {
        if (jassub !== inst || destroyed) return;
        return inst.renderer?.addFonts?.(deferred.map((a) => fontUrl(a.index)));
      })
      .catch((err: unknown) => console.warn('[player] font top-up failed', err));
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

  /**
   * One subtitle control, in the control bar where it belongs.
   *
   * video.js's own captions menu can only ever list text tracks the player
   * owns, so it is blind to the ASS tracks libass paints — leaving it in place
   * alongside this one gives two subtitle buttons that disagree. So it is
   * removed and this menu covers both paths, since showSubtitle already routes
   * ASS to libass and everything else to a text track. Its caption-styling
   * dialog is the one thing worth keeping, so it comes along as a last item.
   */
  let subtitleMenu: any = null;

  function buildSubtitleMenu(videojs: any) {
    if (!player || !subStreams.length) return;
    const MenuButton = videojs.getComponent('MenuButton');
    const MenuItem = videojs.getComponent('MenuItem');

    class SubtitleMenuButton extends MenuButton {
      constructor(p: any, options: any) {
        super(p, options);
        this.controlText('Subtitles');
        this.setIcon?.('subtitles');
        this.addClass('vjs-subtitles-button');
      }
      createItems() {
        const choices: Array<{ label: string; index: number | null }> = [
          { label: 'Off', index: null },
          ...subStreams.map((s) => ({ label: trackLabel(s), index: s.index })),
        ];
        const items = choices.map((c) => {
          const item = new MenuItem(this.player_, {
            label: c.label,
            selectable: true,
            multiSelectable: false,
            selected: activeSubIndex === c.index,
          });
          item.handleClick = () => showSubtitle(c.index);
          return item;
        });
        // video.js's caption styling applies to *its* text-track rendering, so
        // it does nothing at all while libass is painting an ASS track. Offer
        // it only when it can actually change something, rather than leaving a
        // dead control under a menu that is mostly ASS on this library.
        const stylable = activeSubIndex != null && !isAss(activeSubIndex);
        if (!stylable) return items;
        const settings = new MenuItem(this.player_, { label: 'Caption settings…' });
        settings.handleClick = () => player?.textTrackSettings?.open?.();
        return [...items, settings];
      }
    }

    videojs.registerComponent('SaltySubtitlesButton', SubtitleMenuButton);
    const bar = player.getChild('controlBar');
    if (!bar) return;
    // Take the built-in button's place rather than sitting next to it.
    const native = bar.getChild('subsCapsButton') ?? bar.getChild('subtitlesButton');
    const at = native ? bar.children().indexOf(native) : bar.children().indexOf(bar.getChild('fullscreenToggle'));
    if (native) bar.removeChild(native);
    subtitleMenu = bar.addChild('SaltySubtitlesButton', {}, at >= 0 ? at : undefined);
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
  // Seeking itself needs no client-side help: Jellyfin serves a complete VOD
  // playlist and repositions its own transcoder for an out-of-range segment,
  // so none of the Plex-era reposition machinery survives here.
  //
  // What does survive is recovery. That repositioning races Jellyfin's own
  // segment cleanup on remux/direct-stream jobs (jellyfin#16608), and a burst
  // of scrubbing can leave a session serving nothing at any offset —
  // permanently, since VHS retries a sole playlist forever. Reported from the
  // field, and not reproducible on demand, which is the argument for healing
  // rather than only detecting.
  let lastProgressTime = 0;
  let lastProgressAt = Date.now();
  let watchdog: ReturnType<typeof setInterval> | null = null;
  let stalled = false;
  let everProgressed = false;
  let recovering = false;
  let recoveries = 0;
  /** Enough attempts to survive a wedged session, few enough to never loop. */
  const MAX_RECOVERIES = 2;
  const STALL_MS = 10_000;

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
        everProgressed = true;
        recoveries = 0; // real progress means the stream is healthy again
      }
    });
    watchdog = setInterval(() => {
      if (!player || player.paused() || !playbackStarted || recovering) return;
      if (player.seeking?.()) return; // a seek in flight is not a stall
      // A slow *start* is not a stall. `paused` goes false the moment play() is
      // called, so without this a first segment that legitimately takes 25s
      // (measured: up to 50s on a cold disk) would look stalled and get
      // restarted — throwing away the ffmpeg that was about to deliver, and
      // doing it again on the restart.
      if (!everProgressed) return;
      if (Date.now() - lastProgressAt <= STALL_MS) return;
      if (recoveries < MAX_RECOVERIES) restartStream();
      else stalled = true;
    }, 2000);
  }

  /**
   * Rebuild the stream around a fresh session, keeping the viewer's position.
   *
   * Jellyfin restarts its ffmpeg wherever an out-of-range segment is asked for,
   * which is why seeking needs no client-side machinery — but on a
   * remux/direct-stream job that repositioning races its own segment cleanup
   * (jellyfin#16608), and a run of quick scrubs can leave the session serving
   * nothing at any offset. VHS will retry that playlist forever, so the picture
   * simply stays black until someone closes the modal. Asking for a new
   * playSessionId costs one round trip and gets the viewer moving again.
   */
  async function restartStream() {
    if (recovering || destroyed || !player) return;
    recovering = true;
    recoveries += 1;
    const resumeAt = player.currentTime?.() ?? 0;
    console.warn(`[player] no progress for ${STALL_MS / 1000}s — restarting stream at ${resumeAt.toFixed(1)}s`);
    try {
      // `fresh` matters: the cached info holds the session we are escaping.
      const info = await playbackInfo(itemId, mediaSourceId, { fresh: true });
      if (destroyed || !player) return;
      if (info) playSessionId = info.playSessionId;
      player.src({ src: sourceUrl(), type: 'application/x-mpegURL' });
      player.one('loadedmetadata', () => {
        if (destroyed || !player) return;
        player.currentTime(resumeAt);
        player.play()?.catch?.(() => {});
      });
      lastProgressAt = Date.now();
    } catch (err) {
      console.warn('[player] stream restart failed', err);
      stalled = true;
    } finally {
      recovering = false;
    }
  }

  /**
   * Offer casting only if it is *already* possible.
   *
   * The Cast sender SDK comes from gstatic.com and only initialises in a secure
   * context — and SaltyChart is served over plain http on the LAN, so the
   * button usually cannot appear at all. It is warmed on the Randomize page and
   * merely checked here: nothing about starting playback should ever wait on a
   * third party's CDN. Measured, awaiting it sat between the Watch click and
   * the first manifest request.
   */
  async function setupChromecast(videojs: any): Promise<boolean> {
    if (!window.isSecureContext || !castReady()) return false;
    try {
      const [{ default: chromecast }] = await Promise.all([
        import('@silvermine/videojs-chromecast'),
        import('@silvermine/videojs-chromecast/dist/silvermine-videojs-chromecast.css'),
      ]);
      // Plugins are registered on videojs itself, not per player, so doing this
      // on every open warns "a plugin named chromecast already exists" from the
      // second episode onwards. Harmless, but it is console noise in a path
      // where a real warning (the libass fallback) is worth noticing.
      if (!videojs.getPlugin?.('chromecast')) chromecast(videojs);
      return true;
    } catch {
      return false; // casting simply isn't offered
    }
  }

  onMount(async () => {
    loadLibass(); // deliberately not awaited — see loadLibass
    // Shared with the Randomize page's idle warm-up, so this is usually
    // already resolved by the time anyone presses Watch.
    const videojs = await loadVideoJs();
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

    // The session id, subtitle tracks and embedded fonts — normally already
    // resolved, because the show pop-up asked for them when it opened.
    const info = await playbackInfo(itemId, mediaSourceId);
    if (info) {
      playSessionId = info.playSessionId;
      subStreams = info.subtitles;
      attachments = info.attachments;
    } else {
      console.warn('[player] playback info failed');
    }
    if (destroyed || !player) return;

    buildSubtitleMenu(videojs);
    player.src({ src: sourceUrl(), type: 'application/x-mpegURL' });
    player.one('loadedmetadata', startStallWatchdog);
    // Drives the subtitle chip: until this fires, the wait is Jellyfin building
    // the first segment and video.js's own spinner is the right thing to show.
    player.on('canplay', () => (videoReady = true));

    // Start with subtitles already showing: an anime episode that begins
    // before its subtitles arrive means missing the opening dialogue.
    const wantIndex = defaultSubtitleIndex(subStreams);
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

      <!-- Only claim to be waiting on subtitles when that is actually what is
           holding playback up. Measured on a normal open, subtitles are ready
           at ~240ms while the video needs ~3.3s, so showing this for the whole
           wait told the viewer the wrong thing about the slow part — and hid
           video.js's own loading spinner, which is the honest indicator while
           Jellyfin builds the first segment. -->
      {#if subtitlesLoading && videoReady}
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
