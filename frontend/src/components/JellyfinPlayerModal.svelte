<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import { get } from 'svelte/store';
  import { authToken } from '../stores/auth';
  import {
    api,
    defaultSubtitleIndex,
    castReady,
    loadVideoJs,
    playbackInfo,
    type SubStream,
  } from '../lib/jellyfinPrewarm';

  // A thin wrapper around video.js (Apache-2.0). video.js owns the player:
  // control bar, menus, fullscreen, keyboard, error handling. Two things are
  // added on top:
  //   1. 0.10x speed stepping on [ and ] - the reason this exists at all,
  //      since Plex's and Jellyfin's own players are locked to coarser steps.
  //   2. quality selection, because Jellyfin's own client has no equivalent
  //      when the stream is coming through a proxy.
  //
  // Subtitles are NOT rendered here. Jellyfin burns them into the video with
  // libass and the episode's own fonts, composited on the GPU. That deleted a
  // wasm worker, per-episode font downloads, and a canvas that could paint
  // itself opaque over a healthy video with no error reported anywhere.

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
  /** Poll that waits for the cast plugin to add its button; cleared on destroy. */
  let castFixTimer: ReturnType<typeof setInterval> | null = null;
  let player: any = null;
  let rate = 1.0;
  // onMount awaits can outlive a quick close; every await point re-checks this.
  let destroyed = false;

  // 0.10 steps across 0.2x-4.0x, used for both the keys and video.js's speed
  // menu so the two can't disagree.
  const SPEED_MIN = 0.2;
  const SPEED_MAX = 4;
  const SPEED_STEPS = Array.from(
    { length: Math.round((SPEED_MAX - SPEED_MIN) / 0.1) + 1 },
    (_, i) => +(SPEED_MIN + i * 0.1).toFixed(2)
  );

  let subStreams: SubStream[] = [];
  let playSessionId = '';
  let activeSubIndex: number | null = null;
  /** The video has enough data to play, so any remaining wait really is ours. */
  let videoReady = false;
  let playbackStarted = false;
  /** Quality tier; 'auto' means the source's own bitrate. */
  export let quality = 'auto';
  let sourceWidth: number | null = null;
  let sourceBitrate: number | null = null;
  let switching = '';

  /**
   * The stream URL Jellyfin told us to use, routed through our proxy.
   *
   * Not assembled here any more. Hand-built query parameters meant guessing at
   * a contract Jellyfin already defines, and it has no "assume everything is
   * supported" fallback - an under-specified request came back as 416x234. The
   * backend sends a DeviceProfile and returns the server's own TranscodingUrl;
   * this only prefixes the proxy mount so the API key stays server-side.
   */
  let transcodingUrl = '';

  function sourceUrl(): string {
    return api(`/stream${transcodingUrl.replace(/^\/+/, '/')}`);
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

  // -- Subtitle selection -----------------------------------------------
  //
  // Burned into the picture by Jellyfin, so there is nothing to render and
  // nothing that can fail to render. Changing track means a different stream,
  // which is why this restarts instead of swapping a track.
  async function showSubtitle(index: number | null) {
    if (index === activeSubIndex) return;
    activeSubIndex = index;
    subtitleMenu?.update();
    switching = index == null ? 'Turning subtitles off' : 'Changing subtitles';
    await restartStream('subtitle track changed');
    switching = '';
  }

  async function changeQuality(next: string) {
    if (next === quality) return;
    quality = next;
    qualityMenu?.update();
    switching = `Switching to ${next === 'auto' ? 'source quality' : next}`;
    await restartStream('quality changed');
    switching = '';
  }

  /**
   * One subtitle control, in the control bar where it belongs.
   *
   * video.js's own captions menu can only ever list text tracks the player
   * owns, and with subtitles burned into the picture there are none. Leaving
   * it in place would offer a menu that silently does nothing, so it is removed
   * and this one drives the stream instead.
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
        // No "Caption settings" item: video.js styles its own text tracks,
        // and burned-in subtitles are pixels in the video. Offering it would be
        // a control that silently does nothing.
        return items;
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

  /**
   * Quality picker. Same shape as the subtitle menu, and for the same reason:
   * the tier is baked into the stream Jellyfin produces, so changing it means
   * asking for a different stream.
   *
   * "Auto" is the source's own bitrate. Jellyfin will not encode above it, so
   * that is the honest ceiling rather than a number we invented.
   */
  let qualityMenu: any = null;
  const QUALITY_TIERS = ['auto', '1080p', '720p', '480p'];

  function qualityLabel(tier: string): string {
    if (tier !== 'auto') return tier;
    const mbps = sourceBitrate ? (sourceBitrate / 1e6).toFixed(1) : null;
    return mbps ? `Auto (source, ${mbps} Mbps)` : 'Auto (source)';
  }

  function buildQualityMenu(videojs: any) {
    if (!player) return;
    const MenuButton = videojs.getComponent('MenuButton');
    const MenuItem = videojs.getComponent('MenuItem');

    class QualityMenuButton extends MenuButton {
      constructor(p: any, options: any) {
        super(p, options);
        this.controlText('Quality');
        this.setIcon?.('cog');
        this.addClass('vjs-quality-button');
      }
      createItems() {
        return QUALITY_TIERS.map((tier) => {
          const item = new MenuItem(this.player_, {
            label: qualityLabel(tier),
            selectable: true,
            multiSelectable: false,
            selected: quality === tier,
          });
          item.handleClick = () => changeQuality(tier);
          return item;
        });
      }
    }

    videojs.registerComponent('SaltyQualityButton', QualityMenuButton);
    const bar = player.getChild('controlBar');
    if (!bar) return;
    const at = bar.children().indexOf(bar.getChild('fullscreenToggle'));
    qualityMenu = bar.addChild('SaltyQualityButton', {}, at >= 0 ? at : undefined);
  }

  // -- Speed control (the reason this component exists) ------------------
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
    // Changing speed must not count as "user activity" - the corner flash is
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

  /**
   * Offer the play button only when the browser truly refused.
   *
   * `play()` rejects for two very different reasons and only one of them means
   * the viewer has to do something:
   *   - `NotAllowedError` - autoplay policy. The gesture that opened the modal
   *     is too old, nothing will start without a click, so show the button.
   *   - `AbortError` - the play was interrupted by a `pause()` or a new
   *     `load()`. That happens on every deliberate stream rebuild, and playback
   *     resumes on its own. Treating it as a block put a big play button over a
   *     video that was already restarting - the jarring flash mid-switch.
   */
  function offerPlayButtonIfBlocked(err: unknown) {
    if ((err as DOMException | undefined)?.name !== 'NotAllowedError') return;
    console.warn('[player] autoplay was blocked, offering the play button', err);
    player?.addClass('sc-autoplay-blocked');
  }

  /** Begin playback - once only, whoever gets here first. */
  function startPlayback() {
    if (playbackStarted || !player) return;
    playbackStarted = true;
    player.play()?.catch?.(offerPlayButtonIfBlocked);
  }

  // -- Stall detection --------------------------------------------------
  //
  // Seeking itself needs no client-side help: Jellyfin serves a complete VOD
  // playlist and repositions its own transcoder for an out-of-range segment,
  // so none of the Plex-era reposition machinery survives here.
  //
  // What does survive is recovery. That repositioning races Jellyfin's own
  // segment cleanup on remux/direct-stream jobs (jellyfin#16608), and a burst
  // of scrubbing can leave a session serving nothing at any offset -
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
  /**
   * A dead *picture* is caught separately from a dead stream, and needs longer.
   *
   * Reported from the field: pause, seek a few minutes ahead, resume - audio
   * keeps playing and the picture stays black. `currentTime` advances happily
   * throughout, so a watchdog that only reads the clock sees a perfectly
   * healthy stream and never fires. What actually stops is frame decoding.
   */
  const VIDEO_STALL_MS = 8_000;
  /**
   * How long a deliberate restart is allowed to produce no frames.
   *
   * A quality or subtitle change tears the stream down and asks Jellyfin for a
   * new one, which means a fresh ffmpeg and a fresh buffer - frames genuinely
   * stop for several seconds. `recovering` does not cover it, because that is
   * cleared as soon as `player.src()` is called rather than when frames resume.
   * Without this the stall detector fired 9s into an intentional switch and
   * restarted on top of it, so the two raced and the new tier never took.
   */
  const RESTART_GRACE_MS = 25_000;
  let restartedAt = 0;
  let lastFrames = 0;
  let lastFrameAt = Date.now();

  function decodedFrames(): number {
    return videoEl?.getVideoPlaybackQuality?.()?.totalVideoFrames ?? 0;
  }

  function startStallWatchdog() {
    if (watchdog || !player) return;
    lastProgressTime = player.currentTime() ?? 0;
    lastProgressAt = Date.now();
    lastFrames = decodedFrames();
    lastFrameAt = Date.now();
    player.on('timeupdate', () => {
      const t = player?.currentTime?.() ?? 0;
      if (Math.abs(t - lastProgressTime) > 0.25) {
        lastProgressTime = t;
        lastProgressAt = Date.now();
        stalled = false;
        everProgressed = true;
        // Deliberately NOT resetting `recoveries` here. A moving clock is not
        // proof of health - in the picture-stall failure the audio keeps the
        // clock moving while nothing decodes, so resetting on `timeupdate`
        // defeats the retry cap and restarts forever. Decoded frames are the
        // honest health signal; see below.
      }
    });
    watchdog = setInterval(() => {
      if (!player || player.paused() || !playbackStarted || recovering) return;
      if (player.seeking?.()) return; // a seek in flight is not a stall
      // A slow *start* is not a stall. `paused` goes false the moment play() is
      // called, so without this a first segment that legitimately takes 25s
      // (measured: up to 50s on a cold disk) would look stalled and get
      // restarted - throwing away the ffmpeg that was about to deliver, and
      // doing it again on the restart.
      if (!everProgressed) return;
      if (Date.now() - restartedAt < RESTART_GRACE_MS) return;

      // 1. The clock has stopped: nothing is arriving at all.
      if (Date.now() - lastProgressAt > STALL_MS) {
        if (recoveries < MAX_RECOVERIES) restartStream('no progress');
        else stalled = true;
        return;
      }

      // 2. The clock is fine but the picture is not. Only meaningful once
      //    frames have actually been decoded, so audio-only sources and the
      //    pre-roll are never mistaken for a black screen.
      const frames = decodedFrames();
      if (frames > lastFrames) {
        lastFrames = frames;
        lastFrameAt = Date.now();
        recoveries = 0; // frames decoding is the one unambiguous sign of health
        return;
      }
      if (lastFrames > 0 && Date.now() - lastFrameAt > VIDEO_STALL_MS) {
        if (recoveries < MAX_RECOVERIES) restartStream('picture stopped while audio continued');
        else stalled = true;
      }
    }, 2000);
  }

  /**
   * Tell Jellyfin to tear a transcode down.
   *
   * Needed on two paths, and it is the same call for both: closing the modal,
   * and abandoning a session mid-playback to rebuild the stream. Nothing else
   * stops these - Jellyfin only reclaims a session on its own idle timeout, and
   * its ffmpeg keeps writing to the transcode cache in the meantime.
   *
   * `keepalive` so a stop issued as the page goes away still gets sent.
   */
  function stopSession(id: string) {
    if (!id) return;
    fetch(api('/playback/stop'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${get(authToken)}` },
      body: JSON.stringify({ playSessionId: id }),
      keepalive: true,
    }).catch(() => {});
  }

  /**
   * Rebuild the stream around a fresh playSessionId at the viewer's position -
   * why a wedged session needs this is in the stall-detection block above.
   */
  async function restartStream(reason = 'no progress') {
    if (recovering || destroyed || !player) return;
    recovering = true;
    restartedAt = Date.now();
    recoveries += 1;
    const resumeAt = player.currentTime?.() ?? 0;
    const abandoned = playSessionId;
    console.warn(`[player] ${reason} - restarting stream at ${resumeAt.toFixed(1)}s`);
    // Hold the seek bar where the viewer actually is.
    //
    // `player.src()` resets the tech's clock to 0, and the seek bar repaints
    // from that before `loadedmetadata` lets us seek back - so the played
    // section empties for 1.5-5s while the time readout stays correct. Nothing
    // is wrong, but an empty bar reads as "you lost your place" in the middle
    // of a deliberate track change. Pinned via a CSS variable because video.js
    // owns the inline width and would overwrite anything set here directly.
    const total = player.duration?.() ?? 0;
    if (Number.isFinite(total) && total > 0) {
      player.el()?.style?.setProperty('--sc-resume', `${(resumeAt / total) * 100}%`);
      player.addClass?.('sc-rebuilding');
    }
    try {
      // The current quality and track are what makes this a *different* stream,
      // so they have to be asked for - a restart that omits them replays the
      // URL it was trying to change, which is exactly how the quality menu came
      // to select a tier and change nothing.
      // `fresh` matters too: the cached info holds the session we are escaping.
      const info = await playbackInfo(itemId, mediaSourceId, {
        fresh: true,
        quality,
        subtitleIndex: activeSubIndex,
      });
      if (destroyed || !player) return;
      if (info) {
        playSessionId = info.playSessionId;
        if (info.transcodingUrl) transcodingUrl = info.transcodingUrl;
      }
      player.src({ src: sourceUrl(), type: 'application/x-mpegURL' });
      player.one('loadedmetadata', () => {
        if (destroyed || !player) return;
        player.currentTime(resumeAt);
        // A rebuild can genuinely be refused too (a long switch can outlive the
        // opening gesture), so the same check applies - but an interrupted play
        // during the rebuild must not count.
        player.removeClass?.('sc-autoplay-blocked');
        player.play()?.catch?.(offerPlayButtonIfBlocked);
        // Release the pinned seek bar only once the clock has actually caught
        // up, so it never hands back to a bar that would repaint at 0. Capped,
        // because a stream that never resumes must not leave it pinned forever
        // - a frozen bar on a dead stream would be a worse lie than an empty one.
        const settle = () => {
          if (!player) return;
          if (Math.abs((player.currentTime?.() ?? 0) - resumeAt) < 5) {
            player.off?.('timeupdate', settle);
            // Not immediately: the clock is restored a repaint before the bar
            // is, so releasing the pin the moment the times agree hands back to
            // a bar that still paints at zero for a frame or two - the very
            // flash this exists to prevent.
            setTimeout(() => player?.removeClass?.('sc-rebuilding'), 400);
          }
        };
        player.on('timeupdate', settle);
        setTimeout(() => {
          player?.removeClass?.('sc-rebuilding');
          player?.off?.('timeupdate', settle);
        }, 20_000);
      });
      lastProgressAt = Date.now();
      // Re-baseline against what the element reports *now*, not zero. A fresh
      // source resets the counter to 0 and climbs, which reads as recovery; a
      // session that is still wedged keeps reporting its old total, which
      // correctly reads as no progress. Zeroing it made any stuck non-zero
      // count look like a recovery and let the retry cap reset forever.
      lastFrames = decodedFrames();
      lastFrameAt = Date.now();
    } catch (err) {
      console.warn('[player] stream restart failed', err);
      stalled = true;
    } finally {
      recovering = false;
      // The session we walked away from still has an ffmpeg attached, and
      // Jellyfin's writes to the transcode cache until the whole episode is
      // done regardless of where anyone is watching (jellyfin#16608). Closing
      // the modal only ever stopped the *current* session, so before this every
      // quality or subtitle change left one behind re-encoding a ~1 GB episode
      // for nobody.
      //
      // In `finally`, not after `player.src()`: a throw from there skipped it
      // and stranded the encode on exactly the path - a failing rebuild - where
      // an orphan is most likely. It is fire-and-forget, so this cannot delay
      // playback wherever it sits.
      if (abandoned && abandoned !== playSessionId) stopSession(abandoned);
    }
  }

  /** Offer casting only if it is *already* possible - why the Cast SDK is
   * warmed elsewhere and never awaited is on `loadCastSdk` in jellyfinPrewarm.ts. */
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
      // where a real warning (a stream restart) is worth noticing.
      if (!videojs.getPlugin?.('chromecast')) chromecast(videojs);
      return true;
    } catch {
      return false; // casting simply isn't offered
    }
  }

  onMount(async () => {
    // Registered before anything can fail. If this waited until after the
    // stream started, a throw in between would leave the tab able to close on
    // a live encode with nothing listening to stop it. Harmless to have armed
    // early - it no-ops while there is no session yet.
    window.addEventListener('pagehide', onPageHide);
    // Shared with the Randomize page's idle warm-up, so this is usually
    // already resolved by the time anyone presses Watch.
    const videojs = await loadVideoJs();
    if (destroyed) return;

    const chromecastReady = await setupChromecast(videojs);
    if (destroyed) return; // closed while the Cast SDK was loading

    player = videojs(videoEl, {
      controls: true,
      // Playback is started by hand so video.js never sits showing its big
      // play button during the 1-30s Jellyfin spends on the first segment.
      autoplay: false,
      preload: 'auto',
      fluid: true,
      playbackRates: SPEED_STEPS,
      userActions: { hotkeys: true },
      persistTextTrackSettings: true,
      enableSmoothSeeking: true,
      experimentalSvgIcons: true,
      controlBar: {
        // PiP removed deliberately - the browser's mini-player fights the
        // modal and the transcode session; use fullscreen instead.
        pictureInPictureToggle: false,
        skipButtons: { forward: 10, backward: 10 },
      },
      ...(chromecastReady ? { techOrder: ['chromecast', 'html5'], plugins: { chromecast: {} } } : {}),
    });

    // Cast button: put it before fullscreen, and give it its icon back.
    //
    // Done on the DOM, not through video.js components, and retried - the
    // previous attempt used `bar.getChild('chromecastButton')` immediately
    // after construction and silently did nothing, because the plugin adds its
    // button asynchronously once the Cast SDK reports in. There was no button
    // to find yet.
    //
    // Two fixes:
    //  * position - fullscreen must be the last control, always.
    //  * icon - with `experimentalSvgIcons` video.js no longer renders the
    //    `.vjs-icon-placeholder` span, and the plugin's stylesheet draws its
    //    (shipped, bundled) PNG as that span's background. No span, no icon.
    //    Re-adding the span makes the plugin's own artwork appear; nothing
    //    custom is drawn.
    if (chromecastReady) {
      const fixCastButton = () => {
        const barEl = player?.el()?.querySelector('.vjs-control-bar');
        const cast = barEl?.querySelector('.vjs-chromecast-button') as HTMLElement | null;
        const full = barEl?.querySelector('.vjs-fullscreen-control');
        if (!barEl || !cast || !full) return false;
        if (!cast.querySelector('.vjs-icon-placeholder')) {
          const icon = document.createElement('span');
          icon.className = 'vjs-icon-placeholder';
          icon.setAttribute('aria-hidden', 'true');
          cast.insertBefore(icon, cast.firstChild);
        }
        if (cast.nextElementSibling !== full) barEl.insertBefore(cast, full);
        return true;
      };
      if (!fixCastButton()) {
        // The SDK can take a moment; give up rather than watch forever, since a
        // machine with no Cast receiver never gets a button at all.
        let tries = 0;
        const iv = setInterval(() => {
          if (fixCastButton() || ++tries > 40) clearInterval(iv);
        }, 250);
        castFixTimer = iv;
      }
    }

    // Every "the user did something" path in video.js ends up here, so this is
    // the one place that can reliably stop the speed keys waking the bar.
    const reportActivity = player.reportUserActivity.bind(player);
    player.reportUserActivity = (event: any) => {
      if (Date.now() < suppressActivityUntil) return;
      reportActivity(event);
    };

    // Caption-styling defaults for video.js's text-track renderer, which never
    // has a track here (subtitles are burned in). Inert for local playback;
    // seeded - only until the viewer sets their own - in case a future
    // receiver or text track ever appears.
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

    // The session id and subtitle tracks - normally already
    // resolved, because the show pop-up asked for them when it opened.
    // The first call tells us which tracks exist; the chosen one then has to
    // be baked into the stream, so the request we actually play is the second.
    const probe = await playbackInfo(itemId, mediaSourceId, { quality });
    if (!probe) {
      console.warn('[player] playback info failed');
      return;
    }
    subStreams = probe.subtitles;
    sourceWidth = probe.sourceWidth;
    sourceBitrate = probe.sourceBitrate;
    activeSubIndex = defaultSubtitleIndex(subStreams);

    const info =
      activeSubIndex == null
        ? probe
        : (await playbackInfo(itemId, mediaSourceId, {
            quality,
            subtitleIndex: activeSubIndex,
          })) ?? probe;
    if (destroyed || !player) return;
    playSessionId = info.playSessionId;
    transcodingUrl = info.transcodingUrl;

    buildSubtitleMenu(videojs);
    buildQualityMenu(videojs);
    player.src({ src: sourceUrl(), type: 'application/x-mpegURL' });
    player.one('loadedmetadata', startStallWatchdog);
    player.on('canplay', () => (videoReady = true));

    // Nothing to wait for: the subtitles are already in the picture. The old
    // gate existed because libass had to be ready before the first frame, or
    // the opening dialogue was missed.
    startPlayback();

    window.addEventListener('keydown', handleKey, { capture: true });
  });

  /**
   * Closing the tab must stop the transcode too.
   *
   * `onDestroy` does not run when the page is closed, reloaded or navigated
   * away from - and closing the tab is how most people actually stop watching.
   * Every one of those left an encode running, and Jellyfin's ffmpeg keeps
   * writing until the whole episode is done regardless of where the viewer got
   * to (jellyfin#16608), so the cost is a full episode re-encoded for nobody.
   *
   * `pagehide` rather than `beforeunload`: it fires on mobile and on bfcache
   * navigations, where `beforeunload` frequently does not. The stop request
   * already sets `keepalive`, which is what lets it survive the page going away.
   */
  function onPageHide() {
    stopSession(playSessionId);
  }

  onDestroy(() => {
    destroyed = true;
    window.removeEventListener('pagehide', onPageHide);
    if (watchdog) clearInterval(watchdog);
    if (flashTimer) clearTimeout(flashTimer);
    window.removeEventListener('keydown', handleKey, { capture: true });
    // Hand the flash back to Svelte before video.js destroys its subtree,
    // otherwise Svelte's own cleanup can't find the node.
    if (castFixTimer) { clearInterval(castFixTimer); castFixTimer = null; }
    if (flashEl && flashHome && flashEl.parentElement !== flashHome) flashHome.appendChild(flashEl);
    player?.dispose?.();
    player = null;
    // Let Jellyfin tear the transcode down rather than waiting for it to time
    // out on a box that is also serving everyone else.
    stopSession(playSessionId);
  });
</script>

<dialog open class="modal z-[999]">
  <!-- Sized like the trailer modal, which scales with the viewport. This was
       `max-w-5xl`, a hard 64rem cap at any screen size - ~1024px of video on a
       1905px display against the trailer's ~1524px.
       The video itself is fully fluid - it is always a percentage of the window
       and never a fixed size. The one constant is the `8rem` allowance for the
       title row, the hint and the padding, used to stop a *tall* video pushing
       the modal past the viewport on a short screen. It is a bound, not a size:
       it only binds when height would otherwise be the limit, and being a little
       generous just means a slightly smaller video, never an overlap.
       Constraining height directly instead (forcing the player to fill a
       fixed-height box) is what letterboxed the picture and stranded the control
       bar in the dead space below it. -->
  <div class="modal-box w-[95%] md:w-5/6 lg:w-4/5 max-w-[calc((92vh-8rem)*16/9)] p-3 pb-1.5 flex flex-col gap-1.5">
    <div class="shrink-0 flex items-center justify-between gap-2">
      <h3 class="font-bold text-lg truncate">
        {title}
        {#if episodeTitle}<span class="opacity-60 font-normal"> - {episodeTitle}</span>{/if}
      </h3>
      <button
        class="btn btn-sm btn-circle btn-ghost shrink-0"
        aria-label="Close player"
        on:click={() => dispatch('close')}>✕</button
      >
    </div>

    <div class="sc-stage relative">
      <!-- svelte-ignore a11y-media-has-caption -->
      <video bind:this={videoEl} class="video-js vjs-big-play-centered w-full" playsinline></video>

      {#if !playbackStarted && !stalled}
        <div class="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 text-white">
          <span class="loading loading-spinner loading-lg"></span>
          <span class="text-xs opacity-70">Starting playback...</span>
        </div>
      {/if}

      <!-- Switching quality or subtitle track rebuilds the stream, which
           takes a moment; say which, so it doesn't look like a stall. -->
      {#if switching}
        <div class="absolute top-3 left-4 z-20 flex items-center gap-2 rounded bg-black/60 px-2 py-1 text-white">
          <span class="loading loading-spinner loading-xs"></span>
          <span class="text-xs">{switching}...</span>
        </div>
      {/if}

      {#if stalled}
        <div class="absolute inset-x-0 bottom-16 z-20 flex justify-center">
          <div class="rounded bg-error/90 px-3 py-1 text-sm text-error-content">
            Playback stalled - try closing and reopening.
          </div>
        </div>
      {/if}

      <div
        bind:this={flashEl}
        class="sc-rate-flash pointer-events-none absolute top-3 right-4 z-30 select-none font-bold tabular-nums text-white transition-opacity duration-500 {rateFlashVisible
          ? 'opacity-100'
          : 'opacity-0'}"
        style="text-shadow: -2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 2px 2px 0 #000, 0 0 6px rgba(0,0,0,.8);"
        aria-hidden="true"
      >
        x{rate.toFixed(2)}
      </div>
    </div>

    <!-- 6px above (the column's `gap-1.5`) and 6px below (`pb-1.5` overriding
         the modal's `p-3`), so the hint sits in an evenly balanced band and the
         video gets the space instead. -->
    <p class="shrink-0 text-xs opacity-50 m-0 text-center">
      <kbd class="kbd kbd-xs">[</kbd> / <kbd class="kbd kbd-xs">]</kbd> change speed by 0.10×
    </p>
  </div>
</dialog>

<style>
  /*
   * No big play button while we are starting playback ourselves.
   *
   * `autoplay` is off (playback is started by hand), so video.js sits in its
   * not-yet-started state for however long Jellyfin takes to build the first
   * segment (1-30s) and puts a large play button over it - offering the viewer
   * an action that is already under way. The loading spinner is the honest
   * indicator during that wait.
   *
   * It comes back if play() is rejected, which is the only time clicking is
   * actually required of the viewer.
   *
   * `!important` is deliberate. `player.src()` clears `vjs-has-started`, so
   * video.js's own skin puts the button back mid-switch - and which stylesheet
   * wins then depends on the order video.js's CSS and this component's chunk
   * happen to load in, which is not something to leave to chance for a control
   * that must not appear.
   */
  :global(.video-js .vjs-big-play-button) {
    display: none !important;
  }
  :global(.video-js.sc-autoplay-blocked .vjs-big-play-button) {
    display: block !important;
  }
  /*
   * Hold the played section where the viewer is while the stream is rebuilt.
   *
   * A track or quality change swaps `player.src()`, which resets the tech's
   * clock to 0 and empties the bar for 1.5-5s before we can seek back - the
   * time readout stays right, so the bar alone claims the position was lost.
   * `!important` because video.js writes this width inline on every update.
   */
  :global(.video-js.sc-rebuilding .vjs-play-progress) {
    width: var(--sc-resume, 0%) !important;
  }
  /* The default skin hides these; they're the most useful readouts there are. */
  :global(.video-js .vjs-control-bar .vjs-current-time),
  :global(.video-js .vjs-control-bar .vjs-time-divider),
  :global(.video-js .vjs-control-bar .vjs-duration) {
    display: block;
  }
  /* Keep WebVTT captions clear of the control bar (video.js otherwise drops
     them to 1em while the bar is hidden, so they hop as it slides in and out).
     Inert for local playback - subtitles are burned in, so no text track ever
     renders - kept in case a future receiver or text track appears. */
  :global(.video-js .vjs-text-track-display) {
    bottom: 3em !important;
  }
  /* The speed flash is sized against the *player*, not the viewport.
     It was `text-4xl md:text-5xl`, which keys off screen width in two coarse
     steps - so it stayed the same size whether the player filled the window or
     sat small inside it, and jumped a step when the browser crossed 768px for
     reasons nothing to do with the video. A container query ties it to the box
     it actually sits in; `clamp` keeps it legible on a phone and stops it
     dominating a fullscreen 4K frame. */
  /* The stage must NOT impose a height - video.js derives the player's height
     from the video's own ratio. Two attempts at being cleverer both broke it,
     and both are worth not repeating: stretching `.video-js` to fill a
     taller box letterboxed the picture while pinning the control bar to the
     *box's* bottom (reading as "controls gone" plus a huge gap), and giving the
     stage `aspect-ratio` + `self-center` in a column flex collapsed it to 0x0,
     because `self-center` makes the cross-axis size shrink-to-fit and the video
     inside is a percentage of that.
     This element exists only as the reference box for the speed flash's `cqw`
     sizing. */
  .sc-stage {
    container-type: inline-size;
  }
  .sc-rate-flash {
    font-size: clamp(1.5rem, 6cqw, 5rem);
    line-height: 1;
  }
  /* Fullscreen needs its own rule. The flash is re-parented into `player.el()`
     on mount (so it survives fullscreen at all - the overlay would otherwise be
     outside the fullscreen subtree), but `.sc-stage` stays laid out at the
     modal's size while `.video-js` fills the screen. A container query would
     therefore resolve against the *small* box and render the smallest text
     exactly when the screen is largest. In fullscreen the player is the
     viewport, so viewport units are the honest measure. */
  :global(.video-js.vjs-fullscreen) .sc-rate-flash {
    font-size: clamp(2rem, 5vw, 7rem);
  }
  /* The cast button's icon is a PNG the plugin ships, drawn as the background of
     a `.vjs-icon-placeholder` span. Under `experimentalSvgIcons` video.js stops
     rendering that span, so the button came out empty - the span is re-added in
     script (see `fixCastButton`) and this only sizes it, since the plugin's own
     rule is 12px, about half the height of every neighbouring control. */
  :global(.video-js .vjs-chromecast-button .vjs-icon-placeholder) {
    width: 1.5em;
    height: 1.5em;
    background-size: contain;
  }
  /* Never show a control that can't do anything. The plugin hides its button
     via `vjs-hidden` when no receiver is reachable; make that unambiguous so a
     dead button can't sit in the bar looking clickable. */
  :global(.video-js .vjs-chromecast-button.vjs-hidden) {
    display: none !important;
  }
</style>
