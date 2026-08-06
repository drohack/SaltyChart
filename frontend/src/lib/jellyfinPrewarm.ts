/**
 * Everything the Jellyfin player needs that can be fetched *before* the viewer
 * presses Watch.
 *
 * The show pop-up sits open for several seconds while someone reads the
 * synopsis, and by then the episode's ItemId is already known, so the
 * PlaybackInfo round trip happens there and is cached here; pressing Watch then
 * costs only the stream start. Subtitles are burned into the video server-side,
 * so there is nothing else to fetch - no wasm, no fonts, no subtitle body.
 *
 * Deliberately **client-side only**. Nothing here touches the HLS manifest:
 * Jellyfin's transcode throttling is deprecated and disabled by default, and
 * its ffmpeg writes segments until the whole file is done regardless of where
 * the client is, so a pre-started stream would race an entire ~1 GB episode
 * onto the server's transcode disk for a pop-up that may never be played.
 */
import { get } from 'svelte/store';
import { authToken } from '../stores/auth';

export interface SubStream {
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

export interface PlaybackInfo {
  playSessionId: string;
  subtitles: SubStream[];
  /** The stream URL Jellyfin chose for the profile we sent. */
  transcodingUrl: string;
  sourceWidth: number | null;
  sourceBitrate: number | null;
}

export function api(path: string): string {
  return `/api/jellyfin${path}`;
}

/**
 * The track to start with.
 *
 * A plain English dialogue track wins: SDH interleaves "[door creaks]",
 * "dubtitle" tracks are written for the dub rather than the Japanese audio,
 * and signs/songs tracks aren't dialogue at all. The file's own flags break
 * the tie within that set rather than deciding on their own, because releases
 * do ship with a signs-only track marked default.
 *
 * ASS is preferred over SRT of the same content: Jellyfin renders it with
 * libass, positioning and karaoke intact, and this library has episodes whose
 * track *names* are useless ('1', '2', 'final'), so codec and flags are what
 * can be trusted.
 */
export function defaultSubtitleIndex(subStreams: SubStream[]): number | null {
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

export function isAss(subStreams: SubStream[], index: number): boolean {
  const s = subStreams.find((x) => x.index === index);
  return !!s && /ass|ssa/i.test(s.codec);
}


/**
 * video.js, loaded once per session.
 *
 * The player component imports this rather than calling `import('video.js')`
 * itself, so that warming it from the Randomize page and mounting the player
 * share one promise. Importing the component's own chunk is not enough - the
 * bulk is this dependency, and a dynamic import inside `onMount` doesn't come
 * along with it.
 */
let videojsPromise: Promise<any> | null = null;

export function loadVideoJs(): Promise<any> {
  if (!videojsPromise) {
    videojsPromise = Promise.all([
      import('video.js'),
      import('video.js/dist/video-js.css'),
    ]).then(([mod]: any[]) => mod.default);
    videojsPromise.catch(() => {});
  }
  return videojsPromise;
}

/**
 * Google's Cast sender SDK, started early and never waited on.
 *
 * It is fetched from gstatic.com, so it is the one asset here whose latency is
 * someone else's internet rather than the LAN. The player used to `await` it
 * before constructing itself, which put a third party on the path between
 * pressing Watch and the first byte of video - for a button that cannot appear
 * at all unless the app is served over HTTPS. Warmed here instead, and consumed
 * only if it happens to be ready.
 */
let castPromise: Promise<void> | null = null;

export function loadCastSdk(): Promise<void> {
  if (!castPromise) {
    castPromise = window.isSecureContext
      ? new Promise<void>((resolve, reject) => {
          const s = document.createElement('script');
          s.src = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
          s.onload = () => resolve();
          s.onerror = () => reject(new Error('cast sdk blocked'));
          document.head.appendChild(s);
        })
      : Promise.reject(new Error('not a secure context'));
    castPromise.catch(() => {});
  }
  return castPromise;
}

/** True only if the SDK is already usable - never a reason to wait. */
export function castReady(): boolean {
  return !!(window as any).chrome?.cast;
}


/**
 * Bounded so a long session of wheel spins can't grow these without limit.
 * Small enough that eviction is a non-event - a re-fetch is one cheap request.
 */
const MAX_CACHED = 24;

function remember<T>(cache: Map<string, T>, key: string, make: () => T): T {
  const hit = cache.get(key);
  if (hit) return hit;
  const value = make();
  cache.set(key, value);
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value as string);
  return value;
}

const playbackCache = new Map<string, Promise<PlaybackInfo | null>>();

/**
 * The session id and subtitle tracks - one call, cached.
 *
 * `fresh` is not optional politeness: a cached response carries the
 * `playSessionId` of a session that may since have been stopped or wedged, so
 * anything *restarting* a stream must ask for a new one or it will rebuild the
 * stream around the dead session it was trying to escape.
 */
export function playbackInfo(
  itemId: string,
  mediaSourceId: string,
  opts: { fresh?: boolean; quality?: string; subtitleIndex?: number | null } = {}
): Promise<PlaybackInfo | null> {
  // Quality and subtitle track are part of the identity: each combination is a
  // different stream from Jellyfin, so they cannot share a cache entry.
  const quality = opts.quality ?? 'auto';
  // Three states, not two. Omitting the key means "you choose" (the opening
  // probe, before the tracks are even known); `null` means the viewer turned
  // subtitles off, and that has to be sent as Jellyfin's -1 - leaving it out
  // lets Jellyfin pick a default track, which with burn-in puts subtitles on
  // screen for someone who just asked for none.
  const stated = 'subtitleIndex' in opts;
  const sub = opts.subtitleIndex ?? -1;
  const key = `${itemId}:${mediaSourceId}:${quality}:${stated ? sub : 'default'}`;
  if (opts.fresh) playbackCache.delete(key);
  return remember(playbackCache, key, async () => {
    try {
      const params = new URLSearchParams({
        mediaSourceId,
        quality,
        ...(stated ? { subtitleIndex: String(sub) } : {}),
      });
      const res = await fetch(api(`/playback/${itemId}?${params}`), {
        headers: { Authorization: `Bearer ${get(authToken)}` },
      });
      if (!res.ok) return null;
      const info = await res.json();
      return {
        playSessionId: info.playSessionId ?? '',
        subtitles: info.subtitles ?? [],
        transcodingUrl: info.transcodingUrl ?? '',
        sourceWidth: info.sourceWidth ?? null,
        sourceBitrate: info.sourceBitrate ?? null,
      };
    } catch {
      return null;
    }
  });
}

/**
 * Warm everything the player will want, from the pop-up.
 *
 * Fire-and-forget: a failure here must be invisible, because the player still
 * does all of this itself and will simply find a cold cache.
 */
export function prewarm(itemId: string, mediaSourceId: string, quality = 'auto'): void {
  void (async () => {
    try {
      // All this buys is the PlaybackInfo round trip and Jellyfin's stream
      // URL, so pressing Watch is one less request.
      const info = await playbackInfo(itemId, mediaSourceId, { quality });
      if (!info) return;
      const index = defaultSubtitleIndex(info.subtitles);
      // Warm the exact stream the player will ask for, not a different one:
      // the cache is keyed by quality *and* track.
      if (index != null) {
        await playbackInfo(itemId, mediaSourceId, { quality, subtitleIndex: index });
      }
    } catch {
      /* cold cache is the only cost */
    }
  })();
}
