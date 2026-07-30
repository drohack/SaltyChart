/**
 * Everything the Jellyfin player needs that can be fetched *before* the viewer
 * presses Watch.
 *
 * The show pop-up sits open for several seconds while someone reads the
 * synopsis, and by then the episode's ItemId is already known. So the subtitle
 * text, its fonts and the ~2 MB libass wasm are all started there and cached
 * here; pressing Watch then costs only the stream start.
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

export interface Attachment {
  index: number;
  fileName: string;
  mimeType: string;
}

export interface PlaybackInfo {
  playSessionId: string;
  subtitles: SubStream[];
  attachments: Attachment[];
}

export interface LibassBundle {
  JASSUB: any;
  workerUrl: string;
  wasmUrl: string;
  modernWasmUrl: string;
}

export function api(path: string): string {
  return `/api/jellyfin${path}`;
}

export function subtitleUrl(
  itemId: string,
  mediaSourceId: string,
  index: number,
  format: 'ass' | 'vtt'
): string {
  const params = new URLSearchParams({
    itemId,
    mediaSourceId,
    index: String(index),
    format,
    token: get(authToken) ?? '',
  });
  return api(`/subtitles?${params.toString()}`);
}

export function fontUrl(itemId: string, mediaSourceId: string, index: number): string {
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
 * the tie within that set rather than deciding on their own, because releases
 * do ship with a signs-only track marked default.
 *
 * ASS is preferred over SRT of the same content: libass renders it exactly,
 * and this library has episodes whose track *names* are useless ('1', '2',
 * 'final'), so codec and flags are what can be trusted.
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

const normFont = (s: string) =>
  s.trim().replace(/^@/, '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Split an MKV's font attachments into what this script needs now, and what is
 * only worth loading as insurance.
 *
 * Releases bundle a whole font pack rather than just what they use: a measured
 * episode ships 39 attachments totalling 28 MB, of which the script names three
 * — 0.7 MB. libass ingests every font handed to it before drawing anything, and
 * 23.5 MB of that pack was a single Arial Unicode MS, so passing the lot (which
 * is what jellyfin-web does) buys a long blank screen for nothing.
 *
 * Matching is by *filename*, which is a heuristic: a file called `f1.ttf` can
 * contain "Helvetica Neue". So it is deliberately generous both ways — a
 * `Helvetica` style still picks up `Helvetica-Bold.ttf` — and when a named font
 * matches nothing, the unattributed leftovers come back as `deferred` for the
 * caller to load in the background. A wrong guess then costs a moment of
 * substituted type instead of the wrong typeface for the whole episode.
 */
export function fontsFor(
  subContent: string,
  attachments: Attachment[]
): { initial: Attachment[]; deferred: Attachment[] } {
  const embedded = attachments.filter((a) =>
    /font|otf|ttf/i.test(`${a.mimeType} ${a.fileName}`)
  );

  const named = new Set<string>();
  for (const [, font] of subContent.matchAll(/^Style:\s*[^,]+,\s*([^,]+),/gm)) named.add(font);
  for (const [, font] of subContent.matchAll(/\\fn([^\\}]+)/g)) named.add(font);
  const wanted = [...named].map(normFont).filter(Boolean);
  if (!wanted.length) return { initial: embedded, deferred: [] };

  const stem = (a: Attachment) => normFont(a.fileName.replace(/\.[^.]+$/, ''));

  // Prefer the tightest interpretation of a name that finds anything. Exact and
  // prefix keep the weight/style variants a script needs (`Arial` → `arialbd`)
  // without a short name dragging in every neighbour: matching `Arial` loosely
  // pulls in Arial Unicode MS, which is 23 MB on its own and turned one
  // release's 4 named fonts into 24 MB of up-front loading. Loose matching is
  // still the last resort, since a font we fail to place is the worse failure.
  const placedBy = (w: string) => {
    const exact = embedded.filter((a) => stem(a) === w);
    if (exact.length) return exact;
    const prefix = embedded.filter((a) => stem(a).startsWith(w) || w.startsWith(stem(a)));
    if (prefix.length) return prefix;
    return embedded.filter((a) => stem(a).includes(w) || w.includes(stem(a)));
  };

  const initial: Attachment[] = [];
  const unplaced: string[] = [];
  for (const w of wanted) {
    const hits = placedBy(w);
    if (!hits.length) unplaced.push(w);
    for (const a of hits) if (!initial.includes(a)) initial.push(a);
  }
  if (!initial.length) return { initial: embedded, deferred: [] };

  // Only insure against names we failed to place. When every name found a file
  // there is nothing missing, so nothing is queued.
  const deferred = unplaced.length ? embedded.filter((a) => !initial.includes(a)) : [];
  return { initial, deferred };
}

/**
 * video.js, loaded once per session.
 *
 * The player component imports this rather than calling `import('video.js')`
 * itself, so that warming it from the Randomize page and mounting the player
 * share one promise. Importing the component's own chunk is not enough — the
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
 * pressing Watch and the first byte of video — for a button that cannot appear
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

/** True only if the SDK is already usable — never a reason to wait. */
export function castReady(): boolean {
  return !!(window as any).chrome?.cast;
}

/**
 * libass, loaded once per session.
 *
 * ~2 MB of wasm that none of the per-episode choices depend on, so it is
 * started as early as anything knows a player might open.
 */
let libassPromise: Promise<LibassBundle> | null = null;

export function loadLibass(): Promise<LibassBundle> {
  if (!libassPromise) {
    libassPromise = Promise.all([
      import('jassub'),
      // `dist/worker/worker.js` is jassub's worker entry point.
      // `dist/wasm/jassub-worker.js` — which its README names, and which is
      // stale for 2.x — is the emscripten glue and never completes the
      // handshake, so `ready` hangs and `renderer` stays undefined.
      // `?worker&url` so Vite rewrites the worker's own imports.
      import('jassub/dist/worker/worker.js?worker&url'),
      import('jassub/dist/wasm/jassub-worker.wasm?url'),
      import('jassub/dist/wasm/jassub-worker-modern.wasm?url'),
    ]).then(([mod, worker, wasm, modernWasm]: any[]) => ({
      JASSUB: mod.default,
      workerUrl: worker.default,
      wasmUrl: wasm.default,
      modernWasmUrl: modernWasm.default,
    }));
    // Pre-warming means nothing may be awaiting this yet; keep a failure from
    // surfacing as an unhandled rejection. The await at the use site reports.
    libassPromise.catch(() => {});
  }
  return libassPromise;
}

/**
 * Bounded so a long session of wheel spins can't grow these without limit.
 * Small enough that eviction is a non-event — a re-fetch is one cheap request.
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
const subtitleCache = new Map<string, Promise<string>>();

/**
 * The session id, subtitle tracks and font attachments — one call, cached.
 *
 * `fresh` is not optional politeness: a cached response carries the
 * `playSessionId` of a session that may since have been stopped or wedged, so
 * anything *restarting* a stream must ask for a new one or it will rebuild the
 * stream around the dead session it was trying to escape.
 */
export function playbackInfo(
  itemId: string,
  mediaSourceId: string,
  opts: { fresh?: boolean } = {}
): Promise<PlaybackInfo | null> {
  if (opts.fresh) playbackCache.delete(`${itemId}:${mediaSourceId}`);
  return remember(playbackCache, `${itemId}:${mediaSourceId}`, async () => {
    try {
      const res = await fetch(
        api(`/playback/${itemId}?mediaSourceId=${encodeURIComponent(mediaSourceId)}`),
        { headers: { Authorization: `Bearer ${get(authToken)}` } }
      );
      if (!res.ok) return null;
      const info = await res.json();
      return {
        playSessionId: info.playSessionId ?? '',
        subtitles: info.subtitles ?? [],
        attachments: info.attachments ?? [],
      };
    } catch {
      return null;
    }
  });
}

/** Subtitle body, cached by URL (which carries the token, so it self-expires). */
export function subtitleText(url: string): Promise<string> {
  return remember(subtitleCache, url, async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`subtitles ${res.status}`);
    return res.text();
  });
}

/**
 * Warm everything the player will want, from the pop-up.
 *
 * Fire-and-forget: a failure here must be invisible, because the player still
 * does all of this itself and will simply find a cold cache.
 */
export function prewarm(itemId: string, mediaSourceId: string): void {
  loadLibass();
  void (async () => {
    try {
      const info = await playbackInfo(itemId, mediaSourceId);
      if (!info) return;
      const index = defaultSubtitleIndex(info.subtitles);
      if (index == null || !isAss(info.subtitles, index)) return;

      const body = await subtitleText(subtitleUrl(itemId, mediaSourceId, index, 'ass'));
      // Pull the fonts into the browser cache so libass's worker gets them
      // from disk rather than the network. Backed by Cache-Control on
      // /api/jellyfin/attachments.
      const { initial } = fontsFor(body, info.attachments);
      await Promise.all(
        initial.map((a) => fetch(fontUrl(itemId, mediaSourceId, a.index)).catch(() => {}))
      );
    } catch {
      /* cold cache is the only cost */
    }
  })();
}
