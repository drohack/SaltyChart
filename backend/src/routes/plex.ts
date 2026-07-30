import { Router, Response, NextFunction } from 'express';
import express from 'express';
import axios, { AxiosInstance } from 'axios';
import http from 'http';
import https from 'https';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import prisma from '../db';
import { requireAuth, AuthRequest } from '../middleware/auth';

// ---------------------------------------------------------------------------
// /api/plex — Plex Media Server integration.
//
// * Admin configures the server URL + token on the /admin page; both are
//   stored in the AppConfig table. The token NEVER reaches a browser: the
//   availability endpoint returns only ratingKeys/deep-links, and the stream
//   proxy injects the token server-side.
// * Mounted BEFORE compression() in index.ts — the stream proxy pipes HLS
//   segments and compression() would buffer them. That early mount also means
//   the global generalLimiter/express.json() don't apply here, so this router
//   carries its own limiter instances and JSON parser.
// ---------------------------------------------------------------------------

const router = Router();
router.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const ADMIN_USER_ID = parseInt(process.env.ADMIN_USER_ID || '1', 10);

const _isDev = process.env.NODE_ENV === 'development' || !process.env.NODE_ENV;

// Same budget as the global generalLimiter (which doesn't cover this early
// mount) for the JSON endpoints…
const plexApiLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  message: { error: 'Too many requests, please slow down.', code: 'RATE_LIMITED' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => _isDev,
});

// …and a much larger one for the stream proxy: HLS playback is a playlist
// refresh + a segment every few seconds, and seeking bursts — it would eat a
// 120/min budget mid-episode.
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

// ---------------------------------------------------------------------------
// Config (AppConfig rows plexUrl / plexToken), cached in memory
// ---------------------------------------------------------------------------

interface PlexConfig {
  url: string; // no trailing slash
  token: string;
}

// undefined = not loaded yet; null = not configured
let _configCache: PlexConfig | null | undefined;

async function getPlexConfig(): Promise<PlexConfig | null> {
  if (_configCache !== undefined) return _configCache;
  const rows = await prisma.appConfig.findMany({
    where: { key: { in: ['plexUrl', 'plexToken'] } },
  });
  const url = (rows.find((r) => r.key === 'plexUrl')?.value ?? '').replace(/\/+$/, '');
  const token = rows.find((r) => r.key === 'plexToken')?.value ?? '';
  _configCache = url && token ? { url, token } : null;
  return _configCache;
}

function invalidatePlexCaches() {
  _configCache = undefined;
  _showLibrary = null;
  availabilityCache.clear();
}

function plexAxios(cfg: PlexConfig): AxiosInstance {
  return axios.create({
    baseURL: cfg.url,
    timeout: 5000,
    // The token travels only in this server-side header — never in a URL,
    // a response body, or a log line.
    headers: { 'X-Plex-Token': cfg.token, Accept: 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// Library lookup + title matching
// ---------------------------------------------------------------------------

interface PlexShow {
  title: string;
  ratingKey: string;
  /** Normalized forms of `title` and (when present) Plex's `originalTitle`
   *  — the latter is usually the native-script title, which is what AniList
   *  provides when a sequel has no English title yet. */
  norms: string[];
}

let _showLibrary: { shows: PlexShow[]; expires: number } | null = null;
let _showLibraryInFlight: Promise<PlexShow[]> | null = null;
/** When a `fresh` re-check last forced a library refetch (throttled below). */
let _lastLibraryRefresh = 0;

/**
 * Lowercase, strip diacritics, drop punctuation/whitespace — but KEEP
 * letters/digits of every script. Stripping to [a-z0-9] reduced an
 * all-Japanese title like 「転生貴族、鑑定スキルで成り上がる 第3期」 to
 * just "3", which then garbage-matched short English titles.
 */
function normalizeTitle(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '');
}

/**
 * All show titles across every `type: show` library section, cached 1 h.
 * A few hundred rows fetched once beats a per-candidate ?title= substring
 * query per availability request, and keeps fuzzy ranking in our hands.
 */
async function getShowLibrary(ax: AxiosInstance, force = false): Promise<PlexShow[]> {
  if (!force && _showLibrary && _showLibrary.expires > Date.now()) return _showLibrary.shows;
  // Coalesce: the Randomize page asks about every show at once, and without
  // this each request pulled the whole library separately — dozens of
  // simultaneous full-library queries that all timed out, which reported
  // every show as missing from Plex.
  if (_showLibraryInFlight) return _showLibraryInFlight;

  _showLibraryInFlight = (async () => {
    // Listing a few hundred shows is a big response; the default 5s timeout
    // is for small metadata calls, not this.
    const LIST_TIMEOUT = 60_000;
    const { data } = await ax.get('/library/sections', { timeout: LIST_TIMEOUT });
    const sections: any[] = data?.MediaContainer?.Directory ?? [];
    const shows: PlexShow[] = [];
    for (const section of sections) {
      if (section.type !== 'show') continue;
      const { data: all } = await ax.get(`/library/sections/${section.key}/all?type=2`, {
        timeout: LIST_TIMEOUT,
      });
      for (const m of all?.MediaContainer?.Metadata ?? []) {
        if (!m?.title || m.ratingKey == null) continue;
        const norms = [normalizeTitle(String(m.title))];
        if (m.originalTitle) {
          const on = normalizeTitle(String(m.originalTitle));
          if (on && !norms.includes(on)) norms.push(on);
        }
        const filtered = norms.filter(Boolean);
        if (filtered.length) {
          shows.push({ title: String(m.title), ratingKey: String(m.ratingKey), norms: filtered });
        }
      }
    }
    _showLibrary = { shows, expires: Date.now() + 60 * 60 * 1000 };
    return shows;
  })().finally(() => {
    _showLibraryInFlight = null;
  });

  return _showLibraryInFlight;
}

/**
 * Expand title candidates with season-suffix-stripped variants so sequels
 * match their base show in Plex ("… 3rd Season" → "…"), which is where the
 * first episode lives anyway.
 */
function expandCandidates(candidates: string[]): string[] {
  const out = new Set<string>();
  for (const cand of candidates) {
    out.add(cand);
    const stripped = cand
      .replace(/\s*[:\-–]?\s*(\d+(st|nd|rd|th)\s+season|season\s+\d+|part\s+\d+|cour\s+\d+)\s*$/i, '')
      .replace(/\s*第\s*\d+\s*(期|クール|シーズン)\s*$/u, '')
      .trim();
    if (stripped && stripped !== cand) out.add(stripped);
  }
  return [...out];
}

/**
 * Tiered fuzzy match across all title candidates: exact > prefix (either
 * direction, e.g. "Frieren" vs "Frieren: Beyond Journey's End") > contains.
 * Within a tier the shortest Plex title wins (least extra noise).
 *
 * Length floors matter: an all-Japanese title normalizes to almost nothing
 * (e.g. 「転生貴族、鑑定スキルで成り上がる 第3期」 → "3"), and a 1-char
 * prefix candidate happily matched "30 Rock". Candidates shorter than 4
 * normalized chars only count for exact matches.
 */
function matchShow(candidates: string[], shows: PlexShow[]): PlexShow | null {
  let best: { tier: number; show: PlexShow } | null = null;
  for (const cand of expandCandidates(candidates)) {
    const nc = normalizeTitle(cand);
    if (!nc) continue;
    for (const s of shows) {
      let tier: number | null = null;
      for (const sn of s.norms) {
        const shorter = Math.min(sn.length, nc.length);
        const ratio = shorter / Math.max(sn.length, nc.length);
        let t: number | null = null;
        if (sn === nc) t = 0;
        // Prefix: ratio guard kills e.g. plex "Aria" (4) matching candidate
        // "ariathescarletammo" (18); 0.25 still admits "frieren" (7) vs
        // "frierenbeyondjourneysend" (24).
        else if (shorter >= 4 && ratio >= 0.25 && (sn.startsWith(nc) || nc.startsWith(sn))) t = 1;
        // Contains-anywhere is the loosest tier — a short title appears as a
        // substring of unrelated long ones ("aria" inside "…nariagaru…"), so
        // it needs the strictest guards.
        else if (shorter >= 6 && ratio >= 0.4 && (sn.includes(nc) || nc.includes(sn))) t = 2;
        if (t !== null && (tier === null || t < tier)) tier = t;
      }
      if (tier === null) continue;
      if (!best || tier < best.tier || (tier === best.tier && s.title.length < best.show.title.length)) {
        best = { tier, show: s };
      }
    }
  }
  return best?.show ?? null;
}

/**
 * Which season does the AniList entry refer to? Parsed from title markers
 * ("2nd Season", "Season 2", 「第2期」). Null = no marker (season 1 / only
 * season / movie).
 */
function detectSeasonNumber(titles: string[]): number | null {
  for (const t of titles) {
    const m =
      t.match(/(\d+)(?:st|nd|rd|th)\s+season/i) ||
      t.match(/season\s+(\d+)/i) ||
      t.match(/第\s*(\d+)\s*期/u);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n >= 1 && n <= 50) return n;
    }
  }
  return null;
}

/**
 * First episode of the requested season. When the entry names a specific
 * season ("3rd Season") and Plex doesn't have that season, return null —
 * offering S1E1 for a season-3 entry would be wrong. Without a season
 * marker: first episode overall, skipping season 0 (specials) when numbered
 * seasons exist.
 */
async function getFirstEpisode(ax: AxiosInstance, showRatingKey: string, seasonNumber: number | null) {
  const { data } = await ax.get(`/library/metadata/${showRatingKey}/allLeaves`);
  const eps: any[] = data?.MediaContainer?.Metadata ?? [];
  if (!eps.length) return null;
  let pool: any[];
  if (seasonNumber != null) {
    pool = eps.filter((e) => e.parentIndex === seasonNumber);
    if (!pool.length) return null;
  } else {
    const numbered = eps.filter((e) => (e.parentIndex ?? 0) >= 1);
    pool = numbered.length ? numbered : eps;
  }
  pool.sort(
    (a, b) => (a.parentIndex ?? 0) - (b.parentIndex ?? 0) || (a.index ?? 0) - (b.index ?? 0)
  );
  return {
    ratingKey: String(pool[0].ratingKey),
    title: String(pool[0].title ?? ''),
    seasonNumber: pool[0].parentIndex ?? null,
    episodeNumber: pool[0].index ?? null,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Cheap probe for the frontend: is Plex configured, and is the caller the
// admin? (isAdmin rides along so the header's Admin link doesn't need to
// probe an admin-only endpoint and spam 403 console errors for everyone else.)
router.get('/status', plexApiLimiter, requireAuth, async (req: AuthRequest, res) => {
  const isAdmin = req.userId === ADMIN_USER_ID;
  try {
    res.json({ configured: !!(await getPlexConfig()), isAdmin });
  } catch {
    res.json({ configured: false, isAdmin });
  }
});

// Admin: read config — the URL only; the token is never sent back.
router.get('/config', plexApiLimiter, requireAuth, requireAdmin, async (_req, res) => {
  const rows = await prisma.appConfig.findMany({
    where: { key: { in: ['plexUrl', 'plexToken'] } },
  });
  res.json({
    url: rows.find((r) => r.key === 'plexUrl')?.value ?? '',
    tokenSet: !!rows.find((r) => r.key === 'plexToken')?.value,
  });
});

// Admin: save config. An empty/absent token keeps the stored one so the
// admin can edit the URL without re-pasting the token.
router.put('/config', plexApiLimiter, requireAuth, requireAdmin, async (req, res) => {
  const { url, token } = req.body ?? {};
  if (typeof url !== 'string' || (token !== undefined && typeof token !== 'string')) {
    return res.status(400).json({ error: 'Expected { url: string, token?: string }', code: 'BAD_REQUEST' });
  }
  const cleanUrl = url.trim().replace(/\/+$/, '');
  if (cleanUrl && !/^https?:\/\//i.test(cleanUrl)) {
    return res.status(400).json({ error: 'URL must start with http:// or https://', code: 'BAD_REQUEST' });
  }
  await prisma.appConfig.upsert({
    where: { key: 'plexUrl' },
    update: { value: cleanUrl },
    create: { key: 'plexUrl', value: cleanUrl },
  });
  if (typeof token === 'string' && token.trim()) {
    await prisma.appConfig.upsert({
      where: { key: 'plexToken' },
      update: { value: token.trim() },
      create: { key: 'plexToken', value: token.trim() },
    });
  }
  invalidatePlexCaches();
  res.json({ ok: true });
});

// Admin: test a connection. Uses the supplied values when given, falling
// back to stored ones — so the admin can test before saving. Always 200;
// failures are reported in-body for inline display.
router.post('/config/test', plexApiLimiter, requireAuth, requireAdmin, async (req, res) => {
  const { url, token } = req.body ?? {};
  const stored = await (async () => {
    const rows = await prisma.appConfig.findMany({
      where: { key: { in: ['plexUrl', 'plexToken'] } },
    });
    return {
      url: rows.find((r) => r.key === 'plexUrl')?.value ?? '',
      token: rows.find((r) => r.key === 'plexToken')?.value ?? '',
    };
  })();
  const testUrl = (typeof url === 'string' && url.trim() ? url.trim() : stored.url).replace(/\/+$/, '');
  const testToken = typeof token === 'string' && token.trim() ? token.trim() : stored.token;
  if (!testUrl || !testToken) {
    return res.json({ ok: false, error: 'Both a server URL and a token are required.' });
  }

  try {
    const ax = plexAxios({ url: testUrl, token: testToken });
    const identity = await ax.get('/');
    const mc = identity.data?.MediaContainer;
    if (!mc?.machineIdentifier) {
      return res.json({ ok: false, error: 'Reached the server but the response did not look like Plex.' });
    }
    const sections = await ax.get('/library/sections');
    const libraries = (sections.data?.MediaContainer?.Directory ?? []).map((d: any) => ({
      title: String(d.title ?? ''),
      type: String(d.type ?? ''),
    }));
    res.json({
      ok: true,
      serverName: String(mc.friendlyName ?? ''),
      machineIdentifier: String(mc.machineIdentifier),
      libraries,
    });
  } catch (err: any) {
    const status = err?.response?.status;
    const msg =
      status === 401
        ? 'Plex rejected the token (401).'
        : status
        ? `Plex responded with HTTP ${status}.`
        : `Could not reach the server (${err?.code ?? 'network error'}).`;
    res.json({ ok: false, error: msg });
  }
});

// Availability: does this AniList entry exist in the Plex library, and what
// is its first episode? Cached per mediaId (1 h positives, 10 min negatives
// so newly-added shows appear without a restart). Always 200 — Plex being
// down or unconfigured is just { available: false }.
const availabilityCache = new Map<number, { data: any; expires: number }>();

router.post('/availability', plexApiLimiter, requireAuth, async (req, res) => {
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
  // bypasses the negative cache so a just-downloaded show appears
  // immediately instead of after the 10-minute negative TTL.
  const cached = availabilityCache.get(mediaId);
  if (cached && cached.expires > Date.now() && !(fresh === true && !cached.data.available)) {
    return res.json(cached.data);
  }

  const cfg = await getPlexConfig();
  // `unknown` as well as `configured: false`: "we can't say" must never be
  // read as "the library doesn't have it", or a tab whose plexConfigured is
  // stale-true would let Hide-Not-on-Plex hide the entire list.
  if (!cfg) return res.json({ available: false, configured: false, unknown: true });

  try {
    const ax = plexAxios(cfg);
    let shows = await getShowLibrary(ax);
    let show = matchShow(titles, shows);
    if (!show && fresh === true && Date.now() - _lastLibraryRefresh > 30_000) {
      // A fresh re-check should notice a just-added show, but only one
      // refetch per 30s: every negative result asking for its own refetch
      // turned into a stampede that reported everything as missing.
      _lastLibraryRefresh = Date.now();
      shows = await getShowLibrary(ax, true);
      show = matchShow(titles, shows);
    }
    if (!show) {
      const data = { available: false };
      availabilityCache.set(mediaId, { data, expires: Date.now() + 10 * 60 * 1000 });
      return res.json(data);
    }
    // Respect the entry's season: a "3rd Season" entry must resolve to
    // S3E01, and be honestly unavailable when Plex doesn't have season 3.
    const seasonNumber = detectSeasonNumber(titles);
    const episode = await getFirstEpisode(ax, show.ratingKey, seasonNumber);
    if (!episode) {
      const data = { available: false, plexTitle: show.title };
      availabilityCache.set(mediaId, { data, expires: Date.now() + 10 * 60 * 1000 });
      return res.json(data);
    }
    const data = {
      available: true,
      showRatingKey: show.ratingKey,
      episodeRatingKey: episode.ratingKey,
      episodeTitle: episode.title,
      seasonNumber: episode.seasonNumber,
      episodeNumber: episode.episodeNumber,
      // Matched Plex show title — surfaced in the UI so a bad fuzzy match is
      // visible instead of mysteriously playing the wrong series.
      plexTitle: show.title,
    };
    availabilityCache.set(mediaId, { data, expires: Date.now() + 60 * 60 * 1000 });
    res.json(data);
  } catch (err: any) {
    // Deliberately NOT cached — a transient Plex hiccup shouldn't stick.
    // `unknown` distinguishes "we couldn't ask" from "Plex doesn't have it",
    // so the UI never claims a show is missing (or hides it) on a timeout.
    console.warn('[plex] availability lookup failed:', err?.message ?? err);
    res.json({ available: false, unknown: true });
  }
});

// ---------------------------------------------------------------------------
// Streaming proxy: forwards everything under /stream/* to the Plex server,
// injecting the token server-side. GET-only. Used for the HLS universal
// transcode (start.m3u8 → session playlists → segments — Plex references
// them with relative URIs, so every follow-up request resolves back under
// this same prefix) plus the session ping/stop keep-alive calls.
// ---------------------------------------------------------------------------

/**
 * Shared prep for the /stream/* proxy handlers: verify OUR JWT (Authorization
 * header, or ?token= for Safari-native HLS which can't set headers), load the
 * Plex config, and rebuild the upstream URL from originalUrl (not req.query
 * round-trips: Plex paths contain a literal ':' segment and pre-encoded query
 * values that must survive byte-for-byte). Writes the error response and
 * returns null on any failure.
 */
async function prepareStreamProxy(req: AuthRequest, res: Response): Promise<{ upstream: URL; cfg: PlexConfig } | null> {
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

  const cfg = await getPlexConfig();
  if (!cfg) {
    res.status(503).json({ error: 'Plex not configured', code: 'UPSTREAM_ERROR' });
    return null;
  }

  const prefix = '/api/plex/stream';
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
  upstream.searchParams.delete('token'); // never forward our JWT to Plex
  return { upstream, cfg };
}

router.get('/stream/*', streamLimiter, async (req, res) => {
  const prep = await prepareStreamProxy(req, res);
  if (!prep) return;
  const { upstream, cfg } = prep;

  const headers: Record<string, string> = { 'X-Plex-Token': cfg.token };
  for (const h of ['range', 'accept', 'accept-language'] as const) {
    const v = req.headers[h];
    if (typeof v === 'string') headers[h] = v;
  }

  const client = upstream.protocol === 'https:' ? https : http;
  const upstreamReq = client.request(upstream, { method: 'GET', headers }, (upstreamRes) => {
    const passHeaders: Record<string, string | string[]> = {};
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control'] as const) {
      const v = upstreamRes.headers[h];
      if (v) passHeaders[h] = v;
    }
    res.writeHead(upstreamRes.statusCode ?? 502, passHeaders);
    upstreamRes.pipe(res);
  });
  // Inactivity timeout — generous because the transcoder can take several
  // seconds to produce the first playlist. Individual segment transfers keep
  // the socket busy, so this only fires on a genuinely stuck request.
  upstreamReq.setTimeout(30_000, () => upstreamReq.destroy(new Error('Plex timeout')));
  upstreamReq.on('error', (err) => {
    if (!res.headersSent) {
      res.status(502).json({ error: 'Plex unreachable', code: 'UPSTREAM_ERROR' });
    } else {
      res.destroy();
    }
    void err;
  });
  // Player closed / user seeked away: kill the upstream transfer too.
  req.on('close', () => upstreamReq.destroy());
  upstreamReq.end();
});

// ---------------------------------------------------------------------------
// Subtitles as WebVTT.
//
// Only needed because Plex's HLS output carries no subtitle renditions: the
// tracks sit inside the source file as ASS, and Plex will only *burn* them
// into the picture (ignoring which track you asked for — verified against
// PMS 1.43). Browsers render WebVTT, so ffmpeg converts. The player then
// treats these exactly like any other text track.
// ---------------------------------------------------------------------------

// L1 cache in front of the `PlexSubtitle` table. The DB is the real store:
// extracting reads the whole episode file, so results have to survive a
// restart or every deploy makes each episode pay that cost again.
const vttCache = new Map<string, string>();
// Keyed per part: concurrent requests for different languages all wait on
// the same extraction rather than each streaming the source file again.
const vttInFlight = new Map<string, Promise<void>>();

/** Memory, then DB. Returns null when this track has never been extracted. */
async function readCachedVtt(partId: number, streamIndex: number): Promise<string | null> {
  const key = `${partId}:${streamIndex}`;
  const hit = vttCache.get(key);
  if (hit) return hit;
  try {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT vtt FROM "PlexSubtitle" WHERE partId = ? AND streamIndex = ? LIMIT 1`,
      partId,
      streamIndex
    )) as { vtt: string }[];
    if (rows.length && rows[0].vtt) {
      if (vttCache.size > 400) vttCache.clear();
      vttCache.set(key, rows[0].vtt);
      return rows[0].vtt;
    }
  } catch (err: any) {
    console.warn('[plex] subtitle cache read failed:', err?.message);
  }
  return null;
}

/** Write through to both layers; a DB failure must not fail the request. */
async function saveVtt(partId: number, streamIndex: number, vtt: string): Promise<void> {
  if (vttCache.size > 400) vttCache.clear();
  vttCache.set(`${partId}:${streamIndex}`, vtt);
  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "PlexSubtitle" (partId, streamIndex, vtt) VALUES (?, ?, ?)
       ON CONFLICT(partId, streamIndex) DO UPDATE SET vtt = excluded.vtt`,
      partId,
      streamIndex,
      vtt
    );
  } catch (err: any) {
    console.warn('[plex] subtitle cache write failed:', err?.message);
  }
}

/** Which of these streams still need extracting? */
async function missingStreams(partId: number, indexes: number[]): Promise<number[]> {
  const missing: number[] = [];
  for (const idx of indexes) {
    if (!(await readCachedVtt(partId, idx))) missing.push(idx);
  }
  return missing;
}

/**
 * Strip any Plex token out of text before it is logged. ffmpeg echoes the
 * input URL — which carries the token — in its error output, and the whole
 * point of the proxy is that the token stays out of URLs, logs and responses.
 */
function redact(text: string): string {
  return String(text ?? '').replace(/(X-Plex-Token=)[^&\s"']+/gi, '$1[redacted]');
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let out = '';
    let err = '';
    const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
    proc.stdout.on('data', (d) => (out += d.toString('utf8')));
    proc.stderr.on('data', (d) => (err += d.toString('utf8').slice(0, 500)));
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(redact(err).slice(0, 200) || `${cmd} exited ${code}`));
      resolve(out);
    });
  });
}

/** Convert a subtitle file's text to WebVTT (ffmpeg over stdin — no disk, no video read). */
function srtToVtt(text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-f', 'webvtt', 'pipe:1']);
    let out = '';
    let err = '';
    const timer = setTimeout(() => proc.kill('SIGKILL'), 20_000);
    proc.stdout.on('data', (d) => (out += d.toString('utf8')));
    proc.stderr.on('data', (d) => (err += d.toString('utf8').slice(0, 300)));
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on('close', () => {
      clearTimeout(timer);
      if (!out.trim()) return reject(new Error(err.slice(0, 200) || 'empty conversion'));
      resolve(out);
    });
    proc.stdin.on('error', () => {});
    proc.stdin.end(text, 'utf8');
  });
}

// An extraction streams a whole episode file through ffmpeg, so a handful at
// once would starve the Plex transcodes sharing the same box. Requests beyond
// the cap wait rather than pile on (already deduplicated per part above, so
// this only bites when several *different* episodes are opened at once).
const MAX_EXTRACTIONS = 2;
let activeExtractions = 0;
const extractionQueue: Array<() => void> = [];

function acquireExtractionSlot(): Promise<void> {
  if (activeExtractions < MAX_EXTRACTIONS) {
    activeExtractions++;
    return Promise.resolve();
  }
  return new Promise((resolve) => extractionQueue.push(resolve));
}

function releaseExtractionSlot(): void {
  const next = extractionQueue.shift();
  if (next) next(); // hand the slot straight over
  else activeExtractions--;
}

/**
 * Extract the given subtitle streams of a part in ONE pass (one read of the
 * source file, which is the expensive part — extra outputs are almost free).
 *
 * The caller supplies the stream indexes because the player already has them
 * from Plex's metadata; deriving them here would mean shipping and depending
 * on a second binary (ffprobe) purely to re-read what we already know.
 */
function extractAllVtt(cfg: PlexConfig, partId: number, indexes: number[]): Promise<void> {
  const existing = vttInFlight.get(String(partId));
  if (existing) return existing;
  if (!indexes.length) return Promise.reject(new Error('no subtitle streams requested'));

  // `download=1` is load-bearing: without it Plex treats reading the part file
  // as a second *playback* of that item and reaps the transcode session the
  // player is currently streaming from — every segment after the first 404s
  // and the video buffers forever. Verified A/B against a live session:
  // plain file.mkv → next segment 404, download=1 → next segment 200.
  const fileUrl = `${cfg.url}/library/parts/${partId}/file.mkv?download=1&X-Plex-Token=${encodeURIComponent(cfg.token)}`;
  const promise = (async () => {
    await acquireExtractionSlot();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'saltysubs-'));
    try {
      const args = ['-hide_banner', '-loglevel', 'error', '-i', fileUrl];
      for (const idx of indexes) {
        args.push('-map', `0:${idx}`, '-f', 'webvtt', path.join(dir, `${idx}.vtt`));
      }
      await run('ffmpeg', args, 300_000);
      for (const idx of indexes) {
        try {
          const text = await fs.readFile(path.join(dir, `${idx}.vtt`), 'utf8');
          if (text.trim()) await saveVtt(partId, idx, text);
        } catch {}
      }
    } finally {
      releaseExtractionSlot();
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  })().finally(() => vttInFlight.delete(String(partId)));

  vttInFlight.set(String(partId), promise);
  return promise;
}

router.get('/subtitles', streamLimiter, async (req, res) => {
  // A <track src> can't send headers, so the JWT rides in the query.
  const token = typeof req.query.token === 'string'
    ? req.query.token
    : req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : undefined;
  if (!token) return res.status(401).json({ error: 'No token', code: 'UNAUTHORIZED' });
  try {
    jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid token', code: 'INVALID_TOKEN' });
  }

  const partId = Number(req.query.partId);
  const streamIndex = Number(req.query.streamIndex);
  if (!Number.isInteger(partId) || !Number.isInteger(streamIndex) || partId < 0 || streamIndex < 0) {
    return res.status(400).json({ error: 'Expected partId and streamIndex', code: 'BAD_REQUEST' });
  }

  const cfg = await getPlexConfig();
  if (!cfg) return res.status(503).json({ error: 'Plex not configured', code: 'UPSTREAM_ERROR' });

  const cached = await readCachedVtt(partId, streamIndex);
  if (cached) return res.type('text/vtt').send(cached);

  // Fast path: a sidecar subtitle file (Plex exposes a `key` for those) can
  // be fetched straight from Plex and converted in milliseconds. Only
  // subtitles embedded in the video need the full-file extraction below.
  const streamKey = typeof req.query.streamKey === 'string' ? req.query.streamKey : '';
  if (/^\/library\/streams\/\d+$/.test(streamKey)) {
    try {
      const ax = plexAxios(cfg);
      const { data } = await ax.get(streamKey, { responseType: 'text', transformResponse: (d) => d });
      const vtt = await srtToVtt(String(data));
      await saveVtt(partId, streamIndex, vtt);
      return res.type('text/vtt').send(vtt);
    } catch (err: any) {
      console.warn(`[plex] sidecar subtitle fetch failed (${streamKey}):`, err?.message);
      // fall through to extraction
    }
  }

  // The player passes every subtitle index for this part, so one pass covers
  // all languages; falling back to just the requested one keeps the endpoint
  // usable on its own (e.g. from curl).
  const allIndexes = String(req.query.indexes ?? '')
    .split(',')
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n >= 0 && n < 200)
    .slice(0, 60);
  if (!allIndexes.includes(streamIndex)) allIndexes.push(streamIndex);

  try {
    await extractAllVtt(cfg, partId, allIndexes);
    const vtt = await readCachedVtt(partId, streamIndex);
    if (!vtt) throw new Error(`stream ${streamIndex} produced no cues`);
    res.type('text/vtt').send(vtt);
  } catch (err: any) {
    console.warn(
      `[plex] subtitle extract failed (part ${partId} stream ${streamIndex}):`,
      redact(err?.message)
    );
    res.status(502).json({ error: 'Could not extract subtitles', code: 'UPSTREAM_ERROR' });
  }
});

/**
 * Start extracting an episode's subtitles before the viewer presses play.
 *
 * The show pop-up knows the episode as soon as the Plex availability lookup
 * resolves, and a viewer spends a few seconds reading it — enough to cover
 * the ~3.5s full-file read, so pressing Watch then plays immediately with
 * subtitles already in. Returns straight away; the work continues in the
 * background and is a no-op when the part is already cached.
 */
router.post('/warm-subtitles', plexApiLimiter, requireAuth, async (req, res) => {
  const episodeRatingKey = String(req.body?.episodeRatingKey ?? '');
  if (!/^\d+$/.test(episodeRatingKey)) {
    return res.status(400).json({ error: 'Bad episode id', code: 'BAD_REQUEST' });
  }
  const cfg = await getPlexConfig();
  if (!cfg) return res.status(503).json({ error: 'Plex not configured', code: 'UPSTREAM_ERROR' });

  res.json({ ok: true }); // never make the pop-up wait on this

  try {
    const ax = plexAxios(cfg);
    const { data } = await ax.get(`/library/metadata/${episodeRatingKey}`);
    const part = data?.MediaContainer?.Metadata?.[0]?.Media?.[0]?.Part?.[0];
    const partId = Number(part?.id);
    if (!Number.isInteger(partId)) return;
    const indexes: number[] = (part.Stream ?? [])
      .filter((s: any) => s?.streamType === 3 && Number.isInteger(s?.index))
      .map((s: any) => s.index)
      .slice(0, 60);
    if (!indexes.length) return;
    // Sidecar tracks are converted on demand in milliseconds — only the
    // embedded ones are worth pre-reading the file for.
    const needed = await missingStreams(partId, indexes);
    if (!needed.length) return;
    await extractAllVtt(cfg, partId, indexes);
  } catch (err: any) {
    console.warn(`[plex] subtitle warm-up failed for ${episodeRatingKey}:`, redact(err?.message));
  }
});

/**
 * Clear the subtitle selection on a media part.
 *
 * Plex's transcoder burns whatever subtitle is *selected on the part* into
 * the video, and ignores both `subtitles=none` and `subtitleStreamID=0` on
 * the stream URL (verified against PMS 1.43: the session still reported
 * subtitleDecision "burn"). Since the player renders its own WebVTT tracks,
 * a burned-in copy shows up as doubled subtitles — so the selection has to
 * be cleared before the transcode starts.
 */
router.post('/clear-burn/:partId', plexApiLimiter, requireAuth, async (req, res) => {
  const partId = Number(req.params.partId);
  if (!Number.isInteger(partId) || partId < 0) {
    return res.status(400).json({ error: 'Bad part id', code: 'BAD_REQUEST' });
  }
  const cfg = await getPlexConfig();
  if (!cfg) return res.status(503).json({ error: 'Plex not configured', code: 'UPSTREAM_ERROR' });
  try {
    const ax = plexAxios(cfg);
    await ax.put(`/library/parts/${partId}?allParts=1&subtitleStreamID=0`);
    res.json({ ok: true });
  } catch (err: any) {
    console.warn(`[plex] could not clear burned subtitles on part ${partId}:`, err?.message);
    res.status(502).json({ error: 'Plex unreachable', code: 'UPSTREAM_ERROR' });
  }
});

export default router;
