import { Router, Response, NextFunction } from 'express';
import express from 'express';
import axios, { AxiosInstance } from 'axios';
import http from 'http';
import https from 'https';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import prisma from '../db';
import { requireAuth, AuthRequest } from '../middleware/auth';
import {
  detectSeasonNumber,
  matchSeries,
  normalizeTitle,
  type MatchableSeries,
} from '../lib/animeMatch';
import { ensureAnilistTvdbMap, tvdbIdForAnilist } from '../lib/anilistTvdbMap';

// ---------------------------------------------------------------------------
// /api/jellyfin — Jellyfin server configuration.
//
// Currently config only: the admin stores a server URL + API key on the /admin
// page (AppConfig keys `jellyfinUrl` / `jellyfinApiKey`) so the connection can
// be set up and verified. The API key NEVER reaches a browser — the same rule
// as the Plex token: reads return only `apiKeySet`.
//
// Why this exists: Plex has no endpoint that serves an embedded subtitle track
// (`/library/streams/{id}` → 501, and its HLS carries no subtitle renditions),
// which is why SaltyChart extracts subtitles by reading whole episode files.
// Jellyfin does expose subtitles as a first-class API, so having the
// connection configured lets that be measured against the real library.
// ---------------------------------------------------------------------------

const router = Router();
router.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const ADMIN_USER_ID = parseInt(process.env.ADMIN_USER_ID || '1', 10);
const _isDev = process.env.NODE_ENV === 'development' || !process.env.NODE_ENV;

const jellyfinLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  message: { error: 'Too many requests, please slow down.', code: 'RATE_LIMITED' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => _isDev,
});

// Playback is a playlist refresh plus a segment every few seconds, and seeking
// arrives in bursts — it would eat the 120/min budget within a minute.
const streamLimiter = rateLimit({
  windowMs: 60_000,
  max: 600,
  message: { error: 'Too many requests, please slow down.', code: 'RATE_LIMITED' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => _isDev,
});

function requireAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  if (req.userId !== ADMIN_USER_ID) {
    return res.status(403).json({ error: 'Admin access required', code: 'ADMIN_REQUIRED' });
  }
  return next();
}

export interface JellyfinConfig {
  url: string; // no trailing slash
  apiKey: string;
}

// undefined = not loaded yet; null = not configured
let _configCache: JellyfinConfig | null | undefined;

export async function getJellyfinConfig(): Promise<JellyfinConfig | null> {
  if (_configCache !== undefined) return _configCache;
  const rows = await prisma.appConfig.findMany({
    where: { key: { in: ['jellyfinUrl', 'jellyfinApiKey'] } },
  });
  const url = (rows.find((r) => r.key === 'jellyfinUrl')?.value ?? '').replace(/\/+$/, '');
  const apiKey = rows.find((r) => r.key === 'jellyfinApiKey')?.value ?? '';
  _configCache = url && apiKey ? { url, apiKey } : null;
  return _configCache;
}

/**
 * Jellyfin accepts the API key as an Authorization header; keeping it out of
 * the URL means it can't leak through logs or error messages the way a query
 * parameter does.
 */
export function jellyfinAxios(cfg: JellyfinConfig): AxiosInstance {
  return axios.create({
    baseURL: cfg.url,
    timeout: 8000,
    headers: {
      Authorization: `MediaBrowser Token="${cfg.apiKey}", Client="SaltyChart", Device="Web", DeviceId="saltychart", Version="1.0"`,
      Accept: 'application/json',
    },
  });
}

// Admin: read config — the URL only; the key is never sent back.
router.get('/config', jellyfinLimiter, requireAuth, requireAdmin, async (_req, res) => {
  const rows = await prisma.appConfig.findMany({
    where: { key: { in: ['jellyfinUrl', 'jellyfinApiKey'] } },
  });
  res.json({
    url: rows.find((r) => r.key === 'jellyfinUrl')?.value ?? '',
    apiKeySet: !!rows.find((r) => r.key === 'jellyfinApiKey')?.value,
  });
});

// Admin: save config. An empty/absent key keeps the stored one so the admin
// can edit the URL without re-pasting the key.
router.put('/config', jellyfinLimiter, requireAuth, requireAdmin, async (req, res) => {
  const { url, apiKey } = req.body ?? {};
  if (typeof url !== 'string' || (apiKey !== undefined && typeof apiKey !== 'string')) {
    return res
      .status(400)
      .json({ error: 'Expected { url: string, apiKey?: string }', code: 'BAD_REQUEST' });
  }
  const cleanUrl = url.trim().replace(/\/+$/, '');
  if (cleanUrl && !/^https?:\/\//i.test(cleanUrl)) {
    return res
      .status(400)
      .json({ error: 'URL must start with http:// or https://', code: 'BAD_REQUEST' });
  }
  await prisma.appConfig.upsert({
    where: { key: 'jellyfinUrl' },
    update: { value: cleanUrl },
    create: { key: 'jellyfinUrl', value: cleanUrl },
  });
  if (typeof apiKey === 'string' && apiKey.trim()) {
    await prisma.appConfig.upsert({
      where: { key: 'jellyfinApiKey' },
      update: { value: apiKey.trim() },
      create: { key: 'jellyfinApiKey', value: apiKey.trim() },
    });
  }
  _configCache = undefined;
  res.json({ ok: true });
});

// Admin: test a connection. Uses supplied values when given, falling back to
// stored ones — so the admin can test before saving. Always 200; failures are
// reported in-body for inline display.
router.post('/config/test', jellyfinLimiter, requireAuth, requireAdmin, async (req, res) => {
  const { url, apiKey } = req.body ?? {};
  const rows = await prisma.appConfig.findMany({
    where: { key: { in: ['jellyfinUrl', 'jellyfinApiKey'] } },
  });
  const stored = {
    url: rows.find((r) => r.key === 'jellyfinUrl')?.value ?? '',
    apiKey: rows.find((r) => r.key === 'jellyfinApiKey')?.value ?? '',
  };
  const testUrl = (typeof url === 'string' && url.trim() ? url.trim() : stored.url).replace(
    /\/+$/,
    ''
  );
  const testKey = typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : stored.apiKey;
  if (!testUrl || !testKey) {
    return res.json({ ok: false, error: 'Both a server URL and an API key are required.' });
  }

  try {
    const ax = jellyfinAxios({ url: testUrl, apiKey: testKey });
    // /System/Info needs authentication, so a 200 here proves the key works —
    // unlike /System/Info/Public, which any unauthenticated caller can read.
    const info = await ax.get('/System/Info');
    const serverName = info.data?.ServerName;
    if (!serverName) {
      return res.json({ ok: false, error: 'Reached the server but it did not look like Jellyfin.' });
    }
    const folders = await ax.get('/Library/VirtualFolders');
    const libraries = (folders.data ?? []).map((f: any) => ({
      title: String(f.Name ?? ''),
      type: String(f.CollectionType ?? ''),
    }));
    res.json({
      ok: true,
      serverName: String(serverName),
      version: String(info.data?.Version ?? ''),
      libraries,
    });
  } catch (err: any) {
    const status = err?.response?.status;
    const hint =
      status === 401
        ? 'Jellyfin rejected the API key (401). Create one under Dashboard → API Keys.'
        : err?.code === 'ECONNREFUSED'
        ? 'Connection refused — check the URL and port (Jellyfin defaults to 8096).'
        : err?.message ?? 'Unknown error';
    res.json({ ok: false, error: hint });
  }
});

// ---------------------------------------------------------------------------
// Library index + availability
// ---------------------------------------------------------------------------

interface JfSeries extends MatchableSeries {
  /** Jellyfin ItemId — `MatchableSeries.id` holds the same value. */
  itemId: string;
}

let _library: { series: JfSeries[]; expires: number } | null = null;
let _libraryInFlight: Promise<JfSeries[]> | null = null;
/** When a `fresh` re-check last forced a refetch (throttled below). */
let _lastLibraryRefresh = 0;

/**
 * Every series in the library, cached 1 h.
 *
 * `Fields` is mandatory: without it Jellyfin returns `ProviderIds: null` on
 * list endpoints, which reads exactly like "no ids exist" and silently
 * disables the id-confidence tier.
 */
async function getSeriesLibrary(ax: AxiosInstance, force = false): Promise<JfSeries[]> {
  if (!force && _library && _library.expires > Date.now()) return _library.series;
  // Coalesce: the Randomize page asks about every show at once, and without
  // this each request pulled the whole library separately — dozens of
  // simultaneous full-library queries that all timed out, which reported
  // every show as missing.
  if (_libraryInFlight) return _libraryInFlight;

  _libraryInFlight = (async () => {
    // A few thousand series is a big response; the default timeout is sized
    // for small metadata calls.
    const { data } = await ax.get('/Items', {
      timeout: 60_000,
      params: {
        includeItemTypes: 'Series',
        recursive: 'true',
        fields: 'ProviderIds,OriginalTitle',
        enableImages: 'false',
        enableTotalRecordCount: 'false',
      },
    });
    const series: JfSeries[] = [];
    for (const it of data?.Items ?? []) {
      if (!it?.Name || !it?.Id) continue;
      const norms = [normalizeTitle(String(it.Name))];
      if (it.OriginalTitle) {
        const on = normalizeTitle(String(it.OriginalTitle));
        if (on && !norms.includes(on)) norms.push(on);
      }
      const tvdb = it.ProviderIds?.Tvdb ?? it.ProviderIds?.tvdb ?? null;
      series.push({
        id: String(it.Id),
        itemId: String(it.Id),
        title: String(it.Name),
        norms,
        tvdbId: tvdb == null ? null : String(tvdb),
      });
    }
    _library = { series, expires: Date.now() + 60 * 60 * 1000 };
    return series;
  })();

  try {
    return await _libraryInFlight;
  } finally {
    _libraryInFlight = null;
  }
}

/**
 * First episode of the requested season. When the entry names a specific
 * season ("3rd Season") and the library doesn't have it, return null —
 * offering S1E1 for a season-3 entry would be wrong. Without a marker: first
 * episode overall, skipping season 0 (specials) when numbered seasons exist.
 */
async function getFirstEpisode(ax: AxiosInstance, seriesId: string, seasonNumber: number | null) {
  const { data } = await ax.get(`/Shows/${seriesId}/Episodes`, {
    timeout: 30_000,
    params: { fields: 'MediaSources', enableImages: 'false' },
  });
  const eps: any[] = data?.Items ?? [];
  if (!eps.length) return null;
  let pool: any[];
  if (seasonNumber != null) {
    pool = eps.filter((e) => e.ParentIndexNumber === seasonNumber);
    if (!pool.length) return null;
  } else {
    const numbered = eps.filter((e) => (e.ParentIndexNumber ?? 0) >= 1);
    pool = numbered.length ? numbered : eps;
  }
  pool.sort(
    (a, b) =>
      (a.ParentIndexNumber ?? 0) - (b.ParentIndexNumber ?? 0) ||
      (a.IndexNumber ?? 0) - (b.IndexNumber ?? 0)
  );
  const ep = pool[0];
  return {
    itemId: String(ep.Id),
    mediaSourceId: String(ep.MediaSources?.[0]?.Id ?? ep.Id),
    title: String(ep.Name ?? ''),
    seasonNumber: ep.ParentIndexNumber ?? null,
    episodeNumber: ep.IndexNumber ?? null,
  };
}

// Cheap probe for the frontend: is a media server configured, and is the
// caller the admin? (isAdmin rides along so the header's Admin link doesn't
// need to probe an admin-only endpoint and spam 403s for everyone else.)
router.get('/status', jellyfinLimiter, requireAuth, async (req: AuthRequest, res) => {
  const isAdmin = req.userId === ADMIN_USER_ID;
  try {
    res.json({ configured: !!(await getJellyfinConfig()), isAdmin });
  } catch {
    res.json({ configured: false, isAdmin });
  }
});

// Availability: is this AniList entry in the library, and what is its first
// episode? Cached per mediaId (1 h positives, 10 min negatives so newly-added
// shows appear without a restart). Always 200 — the server being down or
// unconfigured is `{ available: false, unknown: true }`, never an error.
const availabilityCache = new Map<number, { data: any; expires: number }>();

router.post('/availability', jellyfinLimiter, requireAuth, async (req, res) => {
  const { mediaId, titles, fresh } = req.body ?? {};
  if (
    !Number.isInteger(mediaId) ||
    !Array.isArray(titles) ||
    titles.length === 0 ||
    titles.length > 10 ||
    titles.some((t) => typeof t !== 'string' || !t.trim() || t.length > 300)
  ) {
    return res.status(400).json({
      error: 'Expected { mediaId: int, titles: string[1..10] }',
      code: 'BAD_REQUEST',
    });
  }

  // `fresh: true` (sent when a popup opens on a previously-negative result)
  // bypasses the negative cache so a just-downloaded show appears immediately
  // instead of after the 10-minute negative TTL.
  const cached = availabilityCache.get(mediaId);
  if (cached && cached.expires > Date.now() && !(fresh === true && !cached.data.available)) {
    return res.json(cached.data);
  }

  const cfg = await getJellyfinConfig();
  // `unknown` as well as `configured: false`: "we can't say" must never be
  // read as "the library doesn't have it", or a tab whose config probe is
  // stale-true would let Hide-Not-in-Library hide the entire list.
  if (!cfg) return res.json({ available: false, configured: false, unknown: true });

  try {
    const ax = jellyfinAxios(cfg);
    // AniList id → TVDB id, when the community map knows this entry. Absent
    // is normal (coverage tracks how long a season has aired) and simply
    // means the match falls back to titles.
    await ensureAnilistTvdbMap();
    const entry = { tvdbId: tvdbIdForAnilist(mediaId), titles };

    let library = await getSeriesLibrary(ax);
    let hit = matchSeries(entry, library);
    if (!hit && fresh === true && Date.now() - _lastLibraryRefresh > 30_000) {
      // A fresh re-check should notice a just-added show, but only one
      // refetch per 30s: every negative result asking for its own refetch
      // turned into a stampede that reported everything as missing.
      _lastLibraryRefresh = Date.now();
      library = await getSeriesLibrary(ax, true);
      hit = matchSeries(entry, library);
    }
    if (!hit) {
      const data = { available: false };
      availabilityCache.set(mediaId, { data, expires: Date.now() + 10 * 60 * 1000 });
      return res.json(data);
    }

    // Respect the entry's season: a "3rd Season" entry must resolve to S3E01,
    // and be honestly unavailable when the library lacks season 3.
    const seasonNumber = detectSeasonNumber(titles);
    const episode = await getFirstEpisode(ax, hit.series.id, seasonNumber);
    if (!episode) {
      const data = { available: false, libraryTitle: hit.series.title, matchedBy: hit.confidence };
      availabilityCache.set(mediaId, { data, expires: Date.now() + 10 * 60 * 1000 });
      return res.json(data);
    }
    const data = {
      available: true,
      seriesId: hit.series.id,
      itemId: episode.itemId,
      mediaSourceId: episode.mediaSourceId,
      episodeTitle: episode.title,
      seasonNumber: episode.seasonNumber,
      episodeNumber: episode.episodeNumber,
      // Matched library title — surfaced in the UI so a bad fuzzy match is
      // visible instead of mysteriously playing the wrong series.
      libraryTitle: hit.series.title,
      // 'id' = an AniList→TVDB→library id chain (exact). 'title' = fuzzy, and
      // fuzzy has produced a real false positive, so the UI marks it and
      // Hide-Not-in-Library refuses to act on it.
      matchedBy: hit.confidence,
    };
    availabilityCache.set(mediaId, { data, expires: Date.now() + 60 * 60 * 1000 });
    res.json(data);
  } catch (err: any) {
    // Deliberately NOT cached — a transient hiccup shouldn't stick. `unknown`
    // distinguishes "we couldn't ask" from "the library doesn't have it", so
    // the UI never claims a show is missing (or hides it) on a timeout.
    console.warn('[jellyfin] availability lookup failed:', err?.message ?? err);
    res.json({ available: false, unknown: true });
  }
});

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

/**
 * Everything the player needs to start, in one call: the transcode session
 * id, which media source to stream, and the subtitle tracks with the flags
 * the track picker sorts on.
 */
router.get('/playback/:itemId', jellyfinLimiter, requireAuth, async (req, res) => {
  const itemId = String(req.params.itemId);
  if (!/^[a-f0-9-]{8,}$/i.test(itemId)) {
    return res.status(400).json({ error: 'Bad item id', code: 'BAD_REQUEST' });
  }
  const cfg = await getJellyfinConfig();
  if (!cfg) return res.status(503).json({ error: 'Jellyfin not configured', code: 'UPSTREAM_ERROR' });
  try {
    const ax = jellyfinAxios(cfg);
    const { data } = await ax.post(`/Items/${itemId}/PlaybackInfo`, {}, {
      params: typeof req.query.mediaSourceId === 'string'
        ? { mediaSourceId: req.query.mediaSourceId }
        : undefined,
    });
    const src = data?.MediaSources?.[0];
    if (!src) return res.status(404).json({ error: 'No media source', code: 'UPSTREAM_ERROR' });
    const subtitles = (src.MediaStreams ?? [])
      .filter((s: any) => s?.Type === 'Subtitle' && Number.isInteger(s?.Index))
      .map((s: any) => ({
        index: s.Index,
        codec: String(s.Codec ?? ''),
        language: String(s.Language ?? ''),
        // Jellyfin exposes the file's own flags, which is what the track
        // picker needs: `title` distinguishes several tracks all called
        // "English", and forced/SDH must be de-prioritised.
        title: String(s.Title ?? s.DisplayTitle ?? ''),
        displayTitle: String(s.DisplayTitle ?? ''),
        isDefault: !!s.IsDefault,
        isForced: !!s.IsForced,
        isHearingImpaired: !!s.IsHearingImpaired,
        isExternal: !!s.IsExternal,
        isTextSubtitle: !!s.IsTextSubtitleStream,
      }));
    const attachments = (src.MediaAttachments ?? [])
      .filter((a: any) => Number.isInteger(a?.Index))
      .map((a: any) => ({
        index: a.Index,
        fileName: String(a.FileName ?? ''),
        mimeType: String(a.MimeType ?? ''),
      }));
    res.json({
      playSessionId: String(data.PlaySessionId ?? ''),
      mediaSourceId: String(src.Id),
      runTimeTicks: src.RunTimeTicks ?? null,
      subtitles,
      // Fonts referenced by ASS tracks; without them libass substitutes and
      // signs render in the wrong typeface.
      attachments,
    });
  } catch (err: any) {
    console.warn(`[jellyfin] playback info failed for ${itemId}:`, err?.message);
    res.status(502).json({ error: 'Jellyfin unreachable', code: 'UPSTREAM_ERROR' });
  }
});

/**
 * Validate the caller and rebuild the upstream URL for a proxied GET.
 *
 * A `<track src>`/`fetch` from the page can't always set headers, so the JWT
 * is accepted from the query too. Our JWT is never forwarded upstream, and
 * the Jellyfin API key only ever travels in a server-side header.
 */
async function prepareProxy(
  req: AuthRequest,
  res: Response,
  prefix: string
): Promise<{ upstream: URL; cfg: JellyfinConfig } | null> {
  let token: string | undefined;
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) token = auth.slice(7);
  else if (typeof req.query.token === 'string') token = req.query.token;
  if (!token) {
    res.status(401).json({ error: 'No token', code: 'UNAUTHORIZED' });
    return null;
  }
  try {
    jwt.verify(token, JWT_SECRET);
  } catch {
    res.status(401).json({ error: 'Invalid token', code: 'INVALID_TOKEN' });
    return null;
  }

  const cfg = await getJellyfinConfig();
  if (!cfg) {
    res.status(503).json({ error: 'Jellyfin not configured', code: 'UPSTREAM_ERROR' });
    return null;
  }

  const idx = req.originalUrl.indexOf(prefix);
  const rest = idx >= 0 ? req.originalUrl.slice(idx + prefix.length) : '';
  if (!rest.startsWith('/')) {
    res.status(400).json({ error: 'Bad stream path', code: 'BAD_REQUEST' });
    return null;
  }
  let upstream: URL;
  try {
    upstream = new URL(cfg.url + rest);
  } catch {
    res.status(400).json({ error: 'Bad stream path', code: 'BAD_REQUEST' });
    return null;
  }
  upstream.searchParams.delete('token'); // never forward our JWT
  return { upstream, cfg };
}

/** Anything that would hand a browser the Jellyfin API key. */
const KEY_IN_BODY = /(api_key|ApiKey|X-Emby-Token|MediaBrowser Token)/i;

/**
 * GET-only proxy to Jellyfin, injecting the API key server-side.
 *
 * Manifests are buffered rather than piped so they can be checked: Jellyfin
 * embeds the caller's own token into subtitle rendition URIs when asked for
 * HLS subtitles, which would publish the admin key to every viewer. We never
 * request those (subtitles are fetched as files instead), and this makes that
 * a guarantee rather than a convention.
 */
router.get('/stream/*', streamLimiter, async (req, res) => {
  const prep = await prepareProxy(req as AuthRequest, res, '/api/jellyfin/stream');
  if (!prep) return;
  const { upstream, cfg } = prep;

  const headers: Record<string, string> = {
    Authorization: `MediaBrowser Token="${cfg.apiKey}", Client="SaltyChart", Device="Web", DeviceId="saltychart", Version="1.0"`,
  };
  for (const h of ['range', 'accept', 'accept-language'] as const) {
    const v = req.headers[h];
    if (typeof v === 'string') headers[h] = v;
  }

  const client = upstream.protocol === 'https:' ? https : http;
  const upstreamReq = client.request(upstream, { method: 'GET', headers }, (upstreamRes) => {
    const passHeaders: Record<string, string | string[]> = {};
    for (const h of [
      'content-type',
      'content-length',
      'content-range',
      'accept-ranges',
      'cache-control',
    ] as const) {
      const v = upstreamRes.headers[h];
      if (v) passHeaders[h] = v;
    }
    const ctype = String(upstreamRes.headers['content-type'] ?? '');
    const isManifest = /mpegurl/i.test(ctype) || upstream.pathname.endsWith('.m3u8');

    if (!isManifest) {
      res.writeHead(upstreamRes.statusCode ?? 502, passHeaders);
      upstreamRes.pipe(res);
      return;
    }
    // Manifests are kilobytes — buffering one costs nothing and lets us
    // guarantee no credential leaves the server.
    const chunks: Buffer[] = [];
    upstreamRes.on('data', (c) => chunks.push(c));
    upstreamRes.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (KEY_IN_BODY.test(body)) {
        console.error('[jellyfin] refusing to serve a manifest containing a credential');
        return res.status(502).json({ error: 'Upstream manifest rejected', code: 'UPSTREAM_ERROR' });
      }
      delete passHeaders['content-length']; // recomputed by Express
      res.writeHead(upstreamRes.statusCode ?? 502, passHeaders);
      res.end(body);
    });
  });
  // Idle timeout, not a total-duration one — it resets as bytes arrive, so it
  // only fires when Jellyfin has gone quiet. It must therefore exceed the worst
  // case for *starting* a stream, which is the slow part: ffmpeg has to spin up
  // and produce the whole first segment before a single byte is sent.
  //
  // Measured with tools/bench_player.py against the real library: a first
  // segment takes 1.3s at best and 50.5s at worst (cold disk, array
  // contention). The previous 30s cut those slow starts off mid-flight — the
  // player then saw a failed segment on a stream that was merely slow, which
  // presents as a video that never starts or goes black. Every proxied run in
  // that benchmark stopped at exactly 30.01s, which is what a timeout looks
  // like rather than what work looks like.
  upstreamReq.setTimeout(120_000, () => upstreamReq.destroy(new Error('Jellyfin timeout')));
  upstreamReq.on('error', (err) => {
    if (!res.headersSent) {
      res.status(502).json({ error: 'Jellyfin unreachable', code: 'UPSTREAM_ERROR' });
    } else {
      res.destroy();
    }
    void err;
  });
  // Player closed / user seeked away: kill the upstream transfer too.
  req.on('close', () => upstreamReq.destroy());
  upstreamReq.end();
});

/**
 * A subtitle track, converted by Jellyfin on its own box.
 *
 * `.ass` is a pass-through of the original when the source is ASS — styling,
 * positioning and karaoke intact, and measured at 0.06s. This is the whole
 * reason for the switch: Plex has no endpoint for an embedded track at all,
 * so SaltyChart used to stream the entire ~900MB episode through ffmpeg to
 * get the same bytes.
 */
router.get('/subtitles', streamLimiter, async (req, res) => {
  const itemId = String(req.query.itemId ?? '');
  const mediaSourceId = String(req.query.mediaSourceId ?? '');
  const index = Number(req.query.index);
  const format = String(req.query.format ?? 'ass').toLowerCase();
  if (
    !/^[a-f0-9-]{8,}$/i.test(itemId) ||
    !/^[a-f0-9-]{8,}$/i.test(mediaSourceId) ||
    !Number.isInteger(index) ||
    index < 0 ||
    !['ass', 'vtt', 'srt'].includes(format)
  ) {
    return res.status(400).json({ error: 'Bad subtitle request', code: 'BAD_REQUEST' });
  }
  (req as any).url = `/subtitles/Videos/${itemId}/${mediaSourceId}/Subtitles/${index}/0/Stream.${format}`;
  return subtitleProxy(req as AuthRequest, res, format);
});

/** Embedded font, so libass renders signs in the typeface the release intended. */
router.get('/attachments', streamLimiter, async (req, res) => {
  const itemId = String(req.query.itemId ?? '');
  const mediaSourceId = String(req.query.mediaSourceId ?? '');
  const index = Number(req.query.index);
  if (
    !/^[a-f0-9-]{8,}$/i.test(itemId) ||
    !/^[a-f0-9-]{8,}$/i.test(mediaSourceId) ||
    !Number.isInteger(index) ||
    index < 0
  ) {
    return res.status(400).json({ error: 'Bad attachment request', code: 'BAD_REQUEST' });
  }
  (req as any).url = `/attachments/Videos/${itemId}/${mediaSourceId}/Attachments/${index}`;
  return subtitleProxy(req as AuthRequest, res, 'font');
});

/**
 * Shared fetch for the two small-file endpoints above. Not routed through the
 * `/stream/*` proxy because the path is built here from validated parts
 * rather than taken from the caller.
 */
/**
 * Jellyfin writes region definitions *after* the blank line that closes the
 * WebVTT header:
 *
 *     WEBVTT
 *                        <- blank line ends the header
 *     Region: id:subtitle …
 *
 * Per the spec they belong in the header, and the browser's parser follows the
 * spec: it reads `Region:` as a cue identifier, then throws on the missing
 * timestamp line. Measured on a real episode, that costs a console
 * ParsingError and one dropped cue (360 of 361); lifting the definitions into
 * the header gives 361 and no error.
 *
 * It does not make regions work — vtt.js splits the header line on ':' and
 * ignores it unless there are exactly two parts, so Jellyfin's
 * `id:subtitle width:80% …` is unparseable to it wherever it sits. That costs
 * nothing here: Jellyfin repeats the placement on every cue (`line:90%`), and
 * cue settings are what actually position the text.
 */
function liftVttRegions(data: ArrayBuffer | Buffer): string {
  const text = Buffer.from(data as any).toString('utf8');
  const m = text.match(/^(﻿?WEBVTT[^\n]*\n)\n((?:(?:Region|STYLE|NOTE):[^\n]*\n)+)/);
  if (!m) return text;
  return m[1] + m[2] + text.slice(m[0].length);
}

async function subtitleProxy(req: AuthRequest, res: Response, kind: string) {
  let token: string | undefined;
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) token = auth.slice(7);
  else if (typeof req.query.token === 'string') token = req.query.token;
  if (!token) return res.status(401).json({ error: 'No token', code: 'UNAUTHORIZED' });
  try {
    jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid token', code: 'INVALID_TOKEN' });
  }
  const cfg = await getJellyfinConfig();
  if (!cfg) return res.status(503).json({ error: 'Jellyfin not configured', code: 'UPSTREAM_ERROR' });

  const path = String(req.url).replace(/^\/(subtitles|attachments)/, '');
  try {
    const ax = jellyfinAxios(cfg);
    const { data, headers } = await ax.get(path, {
      responseType: 'arraybuffer',
      timeout: 60_000,
      // These can legitimately be large (a karaoke-heavy ASS track is ~10MB).
      maxContentLength: 64 * 1024 * 1024,
    });
    const ctype =
      kind === 'ass'
        ? 'text/plain; charset=utf-8'
        : kind === 'vtt'
        ? 'text/vtt; charset=utf-8'
        : String(headers['content-type'] ?? 'application/octet-stream');
    const body = kind === 'vtt' ? Buffer.from(liftVttRegions(data)) : Buffer.from(data);
    // Subtitles and fonts are immutable for a given item+index — a file only
    // changes if the release is replaced, which changes the item id too. Let
    // the browser keep them so a rewatch, or reopening the same episode,
    // costs nothing.
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.type(ctype).send(body);
  } catch (err: any) {
    console.warn(`[jellyfin] ${kind} fetch failed (${path}):`, err?.message);
    res.status(502).json({ error: `Could not fetch ${kind}`, code: 'UPSTREAM_ERROR' });
  }
}

/**
 * Tell Jellyfin the viewer is done so it can tear the transcode down.
 *
 * Not strictly required — segment requests are their own keep-alive and an
 * idle session times out — but leaving transcodes running on a box that also
 * serves everyone else's playback is rude.
 */
router.post('/playback/stop', jellyfinLimiter, requireAuth, async (req, res) => {
  const playSessionId = String(req.body?.playSessionId ?? '');
  if (!playSessionId) {
    return res.status(400).json({ error: 'Expected { playSessionId }', code: 'BAD_REQUEST' });
  }
  const cfg = await getJellyfinConfig();
  if (!cfg) return res.status(503).json({ error: 'Jellyfin not configured', code: 'UPSTREAM_ERROR' });
  try {
    const ax = jellyfinAxios(cfg);
    await ax.delete('/Videos/ActiveEncodings', {
      params: { deviceId: 'saltychart', playSessionId },
    });
    res.json({ ok: true });
  } catch (err: any) {
    console.warn('[jellyfin] could not stop encoding:', err?.message);
    res.json({ ok: false }); // best-effort; the session times out anyway
  }
});

export default router;
