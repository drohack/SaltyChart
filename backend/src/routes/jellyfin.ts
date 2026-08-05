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
  classifyMatch,
  detectSeasonNumber,
  matchSeries,
  normalizeTitle,
  type MatchableSeries,
} from '../lib/animeMatch';
import { ensureAnilistTvdbMap, crosswalkIds } from '../lib/anilistTvdbMap';
import { getFilmIndex } from '../lib/jellyfinFilmIndex';
import {
  sweepStatus,
  sweepRunning,
  runRemoteIdentitySweep,
  retryStateFor,
  parseLookupTerm,
  searchBothKinds,
  lookupByProviderId,
  type RemoteCandidate,
} from '../lib/remoteIdentity';
import { skyhookSearch } from '../lib/skyhookIdentity';
import {
  closestDatedEpisode,
  AIR_DATE_TOLERANCE_MS,
  anilistDateToMs,
} from '../lib/episodeMatch';
import {
  resolveIdentity,
  rawIdentityOverride,
  identityReady,
  setIdentityOverride,
  mergeIdentityPatch,
  clearIdentityOverride,
  listIdentityOverrides,
  onIdentityChanged,
} from '../lib/seriesIdentity';
import {
  DEVICE_ID,
  deviceProfile,
  jellyfinApi,
  jellyfinAuthHeader,
  jellyfinAxios,
  jellyfinErrorInfo,
  type JellyfinConfig,
} from '../lib/jellyfinApi';
import type { Api } from '@jellyfin/sdk/lib/api';
import { getItemsApi } from '@jellyfin/sdk/lib/utils/api/items-api';
import { getHlsSegmentApi } from '@jellyfin/sdk/lib/utils/api/hls-segment-api';
import { getMediaInfoApi } from '@jellyfin/sdk/lib/utils/api/media-info-api';
import { getLibraryStructureApi } from '@jellyfin/sdk/lib/utils/api/library-structure-api';
import { getSystemApi } from '@jellyfin/sdk/lib/utils/api/system-api';
import { getTvShowsApi } from '@jellyfin/sdk/lib/utils/api/tv-shows-api';
import { getUserApi } from '@jellyfin/sdk/lib/utils/api/user-api';
import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import { BaseItemKind } from '@jellyfin/sdk/lib/generated-client/models/base-item-kind';
import { ItemFields } from '@jellyfin/sdk/lib/generated-client/models/item-fields';
import { MediaStreamType } from '@jellyfin/sdk/lib/generated-client/models/media-stream-type';

// ---------------------------------------------------------------------------
// /api/jellyfin — the whole Jellyfin integration: admin config + connection
// test, library availability (single + batch), the identity override/lookup
// endpoints behind /admin/matching, playback session setup, the HLS stream
// proxy, and subtitle/attachment fetches.
//
// The API key NEVER reaches a browser: config reads return only `apiKeySet`,
// availability responses carry only ids and display strings, and the stream
// proxy injects the key server-side (manifests are refused if one leaks in).
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

// The client itself (axios instance, auth header, device id, the SDK `Api`)
// lives in ../lib/jellyfinApi so the header has exactly one definition — the
// raw proxy below sends it too, and the two must not be able to drift.
export { jellyfinAxios, type JellyfinConfig };

// Admin: read config — the URL only; the key is never sent back.
router.get('/config', jellyfinLimiter, requireAuth, requireAdmin, async (_req, res) => {
  const rows = await prisma.appConfig.findMany({
    where: { key: { in: ['jellyfinUrl', 'jellyfinApiKey', 'jellyfinUserId'] } },
  });
  res.json({
    url: rows.find((r) => r.key === 'jellyfinUrl')?.value ?? '',
    apiKeySet: !!rows.find((r) => r.key === 'jellyfinApiKey')?.value,
    userId: rows.find((r) => r.key === 'jellyfinUserId')?.value ?? '',
  });
});

/**
 * Admin: the accounts on the Jellyfin server, for the playback-account picker.
 *
 * Only ids and names — an account list is not something a viewer needs, and the
 * response says nothing about credentials.
 */
router.get('/users', jellyfinLimiter, requireAuth, requireAdmin, async (_req, res) => {
  const cfg = await getJellyfinConfig();
  if (!cfg) return res.json({ users: [] });
  try {
    const { data } = await getUserApi(await jellyfinApi(cfg)).getUsers();
    // `UserDto.Id` is optional in the schema even though the server always
    // sends one, so the coerce-and-filter stays.
    const users = data.map((u) => ({
      id: String(u.Id ?? ''),
      name: String(u.Name ?? ''),
      isAdministrator: !!u.Policy?.IsAdministrator,
    }));
    res.json({ users: users.filter((u) => u.id) });
  } catch {
    // The picker is a convenience; a server that can't be reached is already
    // reported by the Test button.
    res.json({ users: [] });
  }
});

// ── Identity overrides (admin) ───────────────────────────────────────────────
// Our AniList → TVDB/TMDB corrections. See `lib/seriesIdentity.ts` for why this
// is an overlay over the community map rather than a copy of it.

router.get('/identity', jellyfinLimiter, requireAuth, requireAdmin, async (_req, res) => {
  res.json({ overrides: await listIdentityOverrides() });
});

/**
 * What do we currently believe about these entries, and where did it come from?
 *
 * The admin page pairs this with `/availability/batch` — that endpoint says
 * whether a show resolved and how (`matchedBy`, `titleTier`), this one says
 * which id produced it and whether a human has confirmed it.
 */
router.post('/identity/resolve', jellyfinLimiter, requireAuth, requireAdmin, async (req, res) => {
  const ids = req.body?.mediaIds;
  if (!Array.isArray(ids) || ids.length > 200) {
    return res.status(400).json({ error: 'mediaIds must be an array of at most 200', code: 'BAD_REQUEST' });
  }
  // Optional mediaId -> premiere year, sent by the page (it holds startDate
  // anyway for the availability batch). Only consulted for the per-row retry
  // state — the tier arithmetic needs the entry's year, which nothing stored
  // on a miss row records.
  const years: Record<string, unknown> =
    req.body?.years && typeof req.body.years === 'object' ? req.body.years : {};
  // Titles feed the match tier below; without them the title tier can't be
  // evaluated, so the tier is reported as null rather than guessed at.
  const titlesFor: Record<string, unknown> =
    req.body?.titles && typeof req.body.titles === 'object' ? req.body.titles : {};
  // updatedAt for recorded misses among these ids. The in-memory override rows
  // carry no timestamps, and <=200 ids is one indexed SQLite read on an
  // admin-only page. Degrades to empty: retry states then read as 'eligible',
  // which under-promises (the sweep will skip what's cooling down) rather
  // than inventing a cooldown.
  const askedAt = new Map<number, number>();
  try {
    const rows = await prisma.seriesIdentity.findMany({
      where: { anilistId: { in: ids.map(Number).filter(Number.isFinite) }, source: 'remote' },
      select: { anilistId: true, updatedAt: true },
    });
    for (const r of rows) askedAt.set(r.anilistId, r.updatedAt.getTime());
  } catch {
    /* see above — absence of a timestamp is honest-by-default */
  }
  // Candidates stored before the sweep kept years have `year: null` forever —
  // but when we HOLD the candidate, its year is sitting in the library caches.
  // Enrich at read time (display only, storage untouched); the maps are the
  // cached in-memory ones, so this costs lookups, not fetches. Copies, never
  // mutations: `rawIdentityOverride` returns the live in-memory row.
  let yearFor: (c: { tvdbId?: string | null; tmdbId?: string | null; tmdbKind?: string | null }) => number | null =
    () => null;
  // How each entry resolves against the library, by the SAME classifier the
  // sweep tallies with — so the admin panel's per-season row and its
  // all-seasons row are one question asked at two scopes instead of two
  // computations that can disagree. Pure and in-memory; the viewer's
  // availability path is untouched.
  let tierFor: (id: number) => string | null = () => null;
  try {
    const cfg = await getJellyfinConfig();
    if (cfg) {
      const api = await jellyfinApi(cfg);
      const [series, films] = await Promise.all([getSeriesLibrary(api), getFilmIndex(api)]);
      const heldFilmTmdbIds = new Set(Object.keys(films));
      tierFor = (id) => {
        const t = titlesFor[String(id)];
        if (!Array.isArray(t) || !t.length) return null; // no titles sent — say nothing
        const i = resolveIdentity(id);
        return classifyMatch(
          {
            tvdbId: i.tvdbId, tmdbId: i.tmdbId, tmdbKind: i.tmdbKind,
            titles: t.filter((x): x is string => typeof x === 'string'),
            idIsAuthoritative: i.source !== 'remote' || i.confirmed,
            rejected: i.rejected,
          },
          series,
          heldFilmTmdbIds
        );
      };
      const byTvdb = new Map<string, number>();
      const byTmdb = new Map<string, number>();
      for (const s of series) {
        if (s.year == null) continue;
        if (s.tvdbId) byTvdb.set(String(s.tvdbId), s.year);
        if (s.tmdbId) byTmdb.set(String(s.tmdbId), s.year);
      }
      yearFor = (c) =>
        c.tmdbKind === 'movie'
          ? (c.tmdbId ? films[String(c.tmdbId)]?.year ?? null : null)
          : (c.tvdbId ? byTvdb.get(String(c.tvdbId)) : undefined) ??
            (c.tmdbId ? byTmdb.get(String(c.tmdbId)) : undefined) ??
            null;
    }
  } catch {
    /* enrichment is optional — years just stay absent */
  }
  const out: Record<number, any> = {};
  for (const raw of ids) {
    const id = Number(raw);
    if (!Number.isFinite(id)) continue;
    // The raw row first, so *pending* suggestions are visible here. Matching
    // hides them on purpose; this page exists to show them.
    const ident = rawIdentityOverride(id) ?? resolveIdentity(id);
    out[id] = {
      ...ident,
      // The identity's own display year: stored (the sweep dates rows at
      // write time now), else the held library item's — the match control is
      // pre-populated from this row and must not read dateless while its
      // dropdown options are dated.
      year: ident.year ?? yearFor(ident),
      candidates: ident?.candidates?.length
        ? ident.candidates.map((c) => (c.year != null ? c : { ...c, year: yearFor(c) }))
        : ident?.candidates ?? null,
      tier: tierFor(id),
      // A row with no ids and no human decision is what the sweep still owes
      // an answer for — say where it stands (eligible / cooldown / retired).
      // Settled rows get null, not 'eligible': there is nothing to retry.
      retry:
        !ident?.tvdbId && !ident?.tmdbId && !ident?.confirmed && !ident?.rejected
          ? retryStateFor(askedAt.get(id) ?? null, Number(years[String(id)]) || null)
          : null,
    };
  }
  // The sweep summary rides along so /admin/matching can say when the daily
  // resolver last ran and what it did — a background system that "silently
  // stops improving" is this codebase's most-repeated failure class, and until
  // now its only trace was a backend console line nobody watches.
  res.json({ identities: out, ready: identityReady(), sweep: await sweepStatus() });
});

/**
 * Start an identity sweep, shared by the boot/daily timers (index.ts) and the
 * manual endpoint below. `scheduled` keeps the per-run cap and the retry
 * cooldowns; `drain` drops both, so one admin click asks about everything we
 * still owe an answer for (pacing still applies — drain removes the
 * truncation, not the politeness; retired entries stay out, see planSweep).
 *
 * The sweep itself is fired WITHOUT await: a drain over a cold-start backlog
 * runs for many minutes, far past any HTTP timeout. Its body is one
 * try/catch/finally, so the dangling promise never rejects; and `_running` is
 * set synchronously before its first await, so `sweepRunning()` read
 * immediately afterwards is truthful — it distinguishes "started" from "the
 * identity map isn't loaded yet" (the sweep's own silent-refusal case).
 */
export async function triggerSweep(
  mode: 'scheduled' | 'drain'
): Promise<'started' | 'already-running' | 'not-configured' | 'not-ready'> {
  const cfg = await getJellyfinConfig();
  if (!cfg) return 'not-configured';
  if (sweepRunning()) return 'already-running';
  const api = await jellyfinApi(cfg);
  const library = await getSeriesLibrary(api);
  // The film index feeds the sweep's match tally — a film is only ever resolved
  // by id, so without it every held film would be counted "not in library".
  // Cached and persisted, so this is a memory read on all but the first call.
  const films = await getFilmIndex(api).catch(() => ({} as Record<string, unknown>));
  const heldFilmTmdbIds = new Set(Object.keys(films));
  if (sweepRunning()) return 'already-running'; // the daily timer won the race
  void runRemoteIdentitySweep(api, library, {
    heldFilmTmdbIds,
    ...(mode === 'drain' ? { max: Infinity, ignoreCooldown: true } : {}),
  });
  return sweepRunning() ? 'started' : 'not-ready';
}

// Manual trigger for the sweep the timers otherwise own — a cold start used to
// mean restarting the container once per capped run (eight bounces, one
// evening). Returns immediately; progress lands in the persisted sweep status
// that /identity/resolve already carries.
router.post('/identity/sweep', jellyfinLimiter, requireAuth, requireAdmin, async (_req, res) => {
  try {
    const result = await triggerSweep('drain');
    if (result === 'not-configured') {
      return res.status(503).json({ error: 'Jellyfin is not configured', code: 'NOT_CONFIGURED' });
    }
    if (result === 'not-ready') {
      return res
        .status(503)
        .json({ error: 'Identity data is still loading — try again shortly', code: 'IDENTITY_NOT_READY' });
    }
    // 202 either way: a sweep is running now. `started` says whether this
    // request is the one that kicked it off.
    return res.status(202).json({ started: result === 'started', running: true });
  } catch (err) {
    console.warn('[identity] manual sweep trigger failed:', jellyfinErrorInfo(err));
    return res.status(502).json({ error: 'Could not reach the media server', code: 'UPSTREAM_ERROR' });
  }
});

router.put('/identity', jellyfinLimiter, requireAuth, requireAdmin, async (req, res) => {
  const { anilistId, tvdbId, tmdbId, tmdbKind, confirmed, rejected, pending, matchedTitle, note, source, year } =
    req.body ?? {};
  const id = Number(anilistId);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: 'anilistId is required', code: 'BAD_REQUEST' });
  }
  if (tmdbKind != null && tmdbKind !== 'tv' && tmdbKind !== 'movie') {
    return res.status(400).json({ error: "tmdbKind must be 'tv' or 'movie'", code: 'BAD_REQUEST' });
  }
  if (source !== undefined && source !== 'manual' && source !== 'remote') {
    return res.status(400).json({ error: "source must be 'manual' or 'remote'", code: 'BAD_REQUEST' });
  }
  try {
    // Merged onto the stored row: a field the client didn't send keeps its
    // stored value, so Confirm doesn't wipe the resolver's provenance (source,
    // note, candidates) — an explicit value, including null, still changes it.
    const identity = await setIdentityOverride(mergeIdentityPatch(rawIdentityOverride(id), {
      anilistId: id,
      tvdbId: tvdbId ? String(tvdbId) : null,
      tmdbId: tmdbId ? String(tmdbId) : null,
      tmdbKind: tmdbKind ?? null,
      confirmed: confirmed === true,
      rejected: rejected === true,
      // Confirming a suggestion clears `pending`, which is what takes it off
      // the review list. Defaults to false so a plain admin edit is always live.
      pending: pending === true,
      ...(matchedTitle !== undefined ? { matchedTitle: matchedTitle ? String(matchedTitle) : null } : {}),
      ...(note !== undefined ? { note: note ? String(note) : null } : {}),
      ...(source !== undefined ? { source: source as 'manual' | 'remote' } : {}),
      ...(Number.isFinite(Number(year)) && year !== null ? { year: Number(year) } : {}),
    }));
    // Cache invalidation (in-memory AND the persisted blob) happens in the
    // onIdentityChanged listener, so the sweep's writes are covered by the
    // same path. Nothing to do here.
    res.json({ ok: true, identity });
  } catch (err: any) {
    console.warn('[identity] save failed:', err?.message ?? err);
    res.status(500).json({ error: 'Could not save the override', code: 'SERVER_ERROR' });
  }
});

/**
 * Sonarr-style lookup for /admin/matching: a name searches Jellyfin's remote
 * providers; `tvdb:12345` / `tmdb:12345` resolves a pasted id. Every result
 * carries both ids where they can be known (library metadata first, community
 * map cross-walk second — this server's remote search returns TMDB ids only)
 * and an `library` tag naming what we hold under those ids, so the admin sees
 * what they are agreeing to BEFORE Confirm writes it as permanent fact.
 * Admin-only and never on a viewer's path; the library/film caches it reads
 * are the existing stale-while-revalidate ones.
 */
router.get('/identity/lookup', jellyfinLimiter, requireAuth, requireAdmin, async (req, res) => {
  const termRaw = String(req.query.term ?? '');
  if (!termRaw.trim() || termRaw.length > 200) {
    return res.status(400).json({ error: 'term is required (name, tvdb:<id>, or tmdb:<id>)', code: 'BAD_REQUEST' });
  }
  const yearQ = Number(req.query.year);
  const year = Number.isFinite(yearQ) ? yearQ : null;
  try {
    const cfg = await getJellyfinConfig();
    if (!cfg) return res.json({ mode: 'name', results: [] });
    const api = await jellyfinApi(cfg);
    const [series, films] = await Promise.all([getSeriesLibrary(api), getFilmIndex(api)]);
    const byTvdb = new Map<string, MatchableSeries>();
    const byTmdb = new Map<string, MatchableSeries>();
    for (const s of series) {
      if (s.tvdbId) byTvdb.set(String(s.tvdbId), s);
      if (s.tmdbId) byTmdb.set(String(s.tmdbId), s);
    }

    /** Complete the ids and name what the library holds under them. */
    const resolveLocal = (c: {
      tvdbId?: string | null;
      tmdbId?: string | null;
      tmdbKind?: 'tv' | 'movie' | null;
    }) => {
      let tvdbId = c.tvdbId ?? null;
      let tmdbId = c.tmdbId ?? null;
      let tmdbKind = c.tmdbKind ?? null;
      let library: { title: string } | null = null;
      /** The held item's own year — fills results the provider left undated. */
      let libYear: number | null = null;

      const s =
        (tvdbId ? byTvdb.get(String(tvdbId)) : undefined) ??
        (tmdbId && tmdbKind !== 'movie' ? byTmdb.get(String(tmdbId)) : undefined);
      if (s) {
        library = { title: s.title };
        libYear = s.year ?? null;
        // The library's own metadata carries both ids — the first free
        // tvdb<->tmdb translation.
        tvdbId = tvdbId ?? s.tvdbId ?? null;
        if (!tmdbId && s.tmdbId) tmdbId = String(s.tmdbId);
        if (tmdbId && !tmdbKind) tmdbKind = 'tv';
      }
      // A raw `tmdb:` paste has no kind — a film-index hit is itself the
      // evidence the number means a film. Only a known-'tv' id skips this.
      if (!library && tmdbId && tmdbKind !== 'tv') {
        const f = films[String(tmdbId)];
        if (f) {
          library = { title: f.title };
          libYear = f.year ?? null;
          tmdbKind = 'movie';
        }
      }
      if (!tvdbId || !tmdbId) {
        // The community map is the second translation: anilist→tvdb joined to
        // anilist→tmdb through the anilist key.
        const x = crosswalkIds({ tvdbId, tmdbId, tmdbKind });
        if (x) {
          tvdbId = tvdbId ?? x.tvdbId;
          tmdbId = tmdbId ?? x.tmdbId;
          tmdbKind = tmdbKind ?? x.tmdbKind;
          // The kind may only now be known — give the film index its shot.
          if (!library && tmdbId && tmdbKind === 'movie') {
            const f = films[String(tmdbId)];
            if (f) {
              library = { title: f.title };
              libYear = f.year ?? null;
            }
          }
        }
      }
      return { library, libYear, tvdbId, tmdbId, tmdbKind };
    };

    const toResult = (c: RemoteCandidate) => {
      const local = resolveLocal(c);
      return {
        title: c.matchedTitle || local.library?.title || null,
        year: c.year ?? local.libYear,
        tvdbId: local.tvdbId,
        tmdbId: local.tmdbId,
        tmdbKind: local.tmdbKind,
        image: c.image,
        library: local.library,
      };
    };

    // Which review row this lookup serves, when the caller says. A learned
    // year must not evaporate on refresh: if that row is stored undated and a
    // result matches the row's OWN ids, persist the year through the merge —
    // ids and flags are read from the authoritative row, so nothing else can
    // be touched, and a failure here never fails the lookup.
    const anilistIdQ = Number(req.query.anilistId);
    const rowId = Number.isFinite(anilistIdQ) ? anilistIdQ : null;
    const persistLearnedYear = async (
      results: Array<{ tvdbId: string | null; tmdbId: string | null; tmdbKind: string | null; year: number | null }>
    ) => {
      if (rowId == null) return;
      const ex = rawIdentityOverride(rowId);
      if (!ex || ex.year != null || (!ex.tvdbId && !ex.tmdbId)) return;
      const m = results.find(
        (o) =>
          (ex.tvdbId && o.tvdbId === ex.tvdbId) ||
          (ex.tmdbId && o.tmdbId === ex.tmdbId && (o.tmdbKind ?? 'tv') === (ex.tmdbKind ?? 'tv'))
      );
      if (m?.year == null) return;
      try {
        await setIdentityOverride(mergeIdentityPatch(ex, {
          anilistId: rowId,
          tvdbId: ex.tvdbId,
          tmdbId: ex.tmdbId,
          tmdbKind: ex.tmdbKind,
          year: m.year,
          confirmed: ex.confirmed,
          rejected: ex.rejected,
          pending: ex.pending,
        }));
      } catch {
        /* display data — never fail the lookup over it */
      }
    };

    const term = parseLookupTerm(termRaw);
    if (term.kind === 'name') {
      // Series-first: TVDB ids arrive natively from skyhook (Sonarr's own
      // metadata service) instead of hoping the cross-walk can fill them —
      // this Jellyfin's remote search returns TMDB only. Degrades to the
      // TMDB-only list if skyhook is unreachable.
      const sky: RemoteCandidate[] = (await skyhookSearch(term.name)).slice(0, 5).map((s) => ({
        tvdbId: s.tvdbId,
        tmdbId: null,
        tmdbKind: null,
        matchedTitle: s.title,
        exact: false,
        year: s.firstAired ? Number(s.firstAired.slice(0, 4)) : null,
        image: null,
        premiereDate: s.firstAired,
      }));
      const cands = await searchBothKinds(api, term.name, year);
      // Merge, deduped by completed identity — a skyhook row and a TMDB row
      // for the same series collapse into one, keeping the richer fields.
      const results: ReturnType<typeof toResult>[] = [];
      const seen = new Map<string, ReturnType<typeof toResult>>();
      for (const r of [...sky, ...cands].map(toResult)) {
        const key = r.tvdbId ? `tvdb:${r.tvdbId}` : `tmdb:${r.tmdbKind ?? ''}:${r.tmdbId ?? ''}`;
        const prev = seen.get(key);
        if (!prev) {
          seen.set(key, r);
          results.push(r);
          continue;
        }
        prev.image = prev.image ?? r.image;
        prev.year = prev.year ?? r.year;
        prev.tmdbId = prev.tmdbId ?? r.tmdbId;
        prev.tmdbKind = prev.tmdbKind ?? r.tmdbKind;
        prev.title = prev.title ?? r.title;
        prev.library = prev.library ?? r.library;
      }
      await persistLearnedYear(results);
      return res.json({ mode: 'name', results: results.slice(0, 12) });
    }

    // id mode: one result, resolved locally first; a TMDB id nothing local
    // names gets the identify-by-id attempt so the admin still sees a title.
    const local = resolveLocal(term.kind === 'tvdb' ? { tvdbId: term.id } : { tmdbId: term.id });
    let title: string | null = local.library?.title ?? null;
    let resultYear: number | null = local.libYear;
    let image: string | null = null;
    const tmdbToName = term.kind === 'tmdb' ? term.id : local.tmdbId;
    if (!title && tmdbToName) {
      const named = await lookupByProviderId(api, tmdbToName, local.tmdbKind);
      if (named) {
        title = named.matchedTitle || null;
        resultYear = resultYear ?? named.year;
        image = named.image;
        if (!local.tmdbKind) local.tmdbKind = named.tmdbKind;
        if (!local.tvdbId && named.tvdbId) local.tvdbId = named.tvdbId;
      }
    }
    const idResults = [{
      title,
      year: resultYear,
      tvdbId: local.tvdbId ?? (term.kind === 'tvdb' ? term.id : null),
      tmdbId: local.tmdbId ?? (term.kind === 'tmdb' ? term.id : null),
      tmdbKind: local.tmdbKind,
      image,
      library: local.library,
    }];
    await persistLearnedYear(idResults);
    return res.json({ mode: 'id', results: idResults });
  } catch (err: any) {
    console.warn('[identity] lookup failed:', jellyfinErrorInfo(err));
    res.status(502).json({ error: 'Lookup failed', code: 'UPSTREAM_ERROR' });
  }
});

router.delete('/identity/:anilistId', jellyfinLimiter, requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.anilistId);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: 'anilistId is required', code: 'BAD_REQUEST' });
  }
  try {
    await clearIdentityOverride(id);
    res.json({ ok: true });
  } catch (err: any) {
    console.warn('[identity] delete failed:', err?.message ?? err);
    res.status(500).json({ error: 'Could not remove the override', code: 'SERVER_ERROR' });
  }
});

// Admin: save config. An empty/absent key keeps the stored one so the admin
// can edit the URL without re-pasting the key.
router.put('/config', jellyfinLimiter, requireAuth, requireAdmin, async (req, res) => {
  const { url, apiKey, userId } = req.body ?? {};
  if (
    typeof url !== 'string' ||
    (apiKey !== undefined && typeof apiKey !== 'string') ||
    (userId !== undefined && typeof userId !== 'string')
  ) {
    return res.status(400).json({
      error: 'Expected { url: string, apiKey?: string, userId?: string }',
      code: 'BAD_REQUEST',
    });
  }
  const cleanUrl = url.trim().replace(/\/+$/, '');
  if (cleanUrl && !/^https?:\/\//i.test(cleanUrl)) {
    return res
      .status(400)
      .json({ error: 'URL must start with http:// or https://', code: 'BAD_REQUEST' });
  }
  // Like the key, an empty URL keeps the stored one. The admin form starts
  // blank when its config GET failed, and this write used to be unconditional —
  // so Save in that state replaced a working URL with whatever the form fell
  // back to, silently breaking availability and playback for everyone.
  if (cleanUrl) {
    await prisma.appConfig.upsert({
      where: { key: 'jellyfinUrl' },
      update: { value: cleanUrl },
      create: { key: 'jellyfinUrl', value: cleanUrl },
    });
  }
  if (typeof apiKey === 'string' && apiKey.trim()) {
    await prisma.appConfig.upsert({
      where: { key: 'jellyfinApiKey' },
      update: { value: apiKey.trim() },
      create: { key: 'jellyfinApiKey', value: apiKey.trim() },
    });
  }
  // Unlike the key, an empty user id is a meaningful choice: it means "fall
  // back to an administrator", so it is written rather than ignored.
  if (typeof userId === 'string') {
    await prisma.appConfig.upsert({
      where: { key: 'jellyfinUserId' },
      update: { value: userId.trim() },
      create: { key: 'jellyfinUserId', value: userId.trim() },
    });
    cachedUserId = null;
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
    const api = await jellyfinApi({ url: testUrl, apiKey: testKey });
    // /System/Info needs authentication, so a 200 here proves the key works —
    // unlike /System/Info/Public, which any unauthenticated caller can read.
    const info = await getSystemApi(api).getSystemInfo();
    const serverName = info.data?.ServerName;
    if (!serverName) {
      return res.json({ ok: false, error: 'Reached the server but it did not look like Jellyfin.' });
    }
    const folders = await getLibraryStructureApi(api).getVirtualFolders();
    const libraries = (folders.data ?? []).map((f) => ({
      title: String(f.Name ?? ''),
      type: String(f.CollectionType ?? ''),
    }));
    // Which account playback will actually run as. Worth reporting: a wrong or
    // deleted id doesn't fail loudly — PlaybackInfo just returns no
    // TranscodingUrl, which looks like the profile was rejected.
    let playbackAccount = '';
    try {
      const resolved = await jellyfinUserId({ url: testUrl, apiKey: testKey });
      const { data } = await getUserApi(api).getUsers();
      const match = data.find((u) => String(u.Id ?? '') === resolved);
      playbackAccount = match
        ? `${match.Name}${match.Policy?.IsAdministrator ? ' (administrator)' : ''}`
        : resolved
          ? 'unknown account — the configured id is not on this server'
          : '';
    } catch {
      /* reported as blank rather than failing the whole test */
    }
    res.json({
      ok: true,
      serverName: String(serverName),
      version: String(info.data?.Version ?? ''),
      libraries,
      playbackAccount,
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
/** The DB-backed copy, so a restart doesn't refetch the whole library (2271). */
let _libraryPersisted: { series: JfSeries[]; total: number; at: number } | null = null;

/**
 * Keeping a `Map` cache across restarts.
 *
 * The library cache was made restart-safe first, and these two are the same bug
 * in its siblings: they hold answers to real Jellyfin calls, they live only in
 * memory, and restarts are frequent — every dev reload, every deploy, ~26 times
 * an hour during a mutation audit. A cold `availabilityCache` means the next
 * wheel load re-derives ~50 shows, each an episodes lookup.
 *
 * The `Map` stays the hot path and its semantics are untouched. All that is
 * added is: seed it at boot, and write it back on change. Writes are debounced
 * because a wheel load populates ~50 entries in a burst and that must be one
 * write, not fifty.
 */
const PERSIST_DEBOUNCE_MS = 5_000;
const persistTimers = new Map<string, NodeJS.Timeout>();

function persistMapSoon(key: string, snapshot: () => unknown): void {
  const existing = persistTimers.get(key);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    persistTimers.delete(key);
    const value = JSON.stringify(snapshot());
    prisma.appConfig
      .upsert({ where: { key }, update: { value }, create: { key, value } })
      .catch((err) => console.warn(`[jellyfin] could not persist ${key}`, jellyfinErrorInfo(err)));
  }, PERSIST_DEBOUNCE_MS);
  // Don't hold the process open for a cache write.
  if (typeof t.unref === 'function') t.unref();
  persistTimers.set(key, t);
}

async function loadPersistedEntries<K, V>(key: string): Promise<Array<[K, V]>> {
  try {
    const row = await prisma.appConfig.findUnique({ where: { key } });
    if (!row?.value) return [];
    const parsed = JSON.parse(row.value);
    return Array.isArray(parsed) ? (parsed as Array<[K, V]>) : [];
  } catch {
    return []; // a corrupt blob must mean "ask again", never an outage
  }
}

/**
 * A file's own width and bitrate, cached.
 *
 * These describe the media on disk, so they cannot change while the item id
 * stays the same — replacing a release gives a new id. Bounded because a long
 * session of wheel spins would otherwise grow it without limit.
 */
const sourceDims = new Map<string, { dims: { width: number; bitrate: number }; at: number }>();
const SOURCE_DIMS_TTL_MS = 30 * 60 * 1000;
const SOURCE_DIMS_MAX = 200;
const SOURCE_DIMS_KEY = 'jellyfinSourceDims';

function rememberSourceDims(key: string, dims: { width: number; bitrate: number }): void {
  const now = Date.now();
  for (const [k, v] of sourceDims) {
    if (now - v.at > SOURCE_DIMS_TTL_MS) sourceDims.delete(k);
  }
  if (sourceDims.size >= SOURCE_DIMS_MAX) {
    sourceDims.delete(sourceDims.keys().next().value as string);
  }
  sourceDims.set(key, { dims, at: now });
  persistMapSoon(SOURCE_DIMS_KEY, () => [...sourceDims]);
}

const LIBRARY_KEY = 'jellyfinLibrary';
const LIBRARY_AT_KEY = 'jellyfinLibraryAt';
const LIBRARY_TTL_MS = 60 * 60 * 1000;
/** Incremental refreshes cannot see deletions; this is the backstop. */
const LIBRARY_FULL_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;
/** Clock skew / in-flight writes: re-ask for a few minutes either side. */
const LIBRARY_OVERLAP_MS = 5 * 60 * 1000;

const SERIES_FIELDS = [ItemFields.ProviderIds, ItemFields.OriginalTitle];

/**
 * `Fields` is mandatory: without it Jellyfin returns `ProviderIds: null` on
 * list endpoints, which reads exactly like "no ids exist" and silently
 * disables the id-confidence tier.
 */
function toJfSeries(items: BaseItemDto[]): JfSeries[] {
  const series: JfSeries[] = [];
  for (const it of items) {
    if (!it.Name || !it.Id) continue;
    const norms = [normalizeTitle(String(it.Name))];
    if (it.OriginalTitle) {
      const on = normalizeTitle(String(it.OriginalTitle));
      if (on && !norms.includes(on)) norms.push(on);
    }
    // Jellyfin has shipped both casings of this key across versions, and the
    // generated type is an index signature, so both stay.
    const tvdb = it.ProviderIds?.Tvdb ?? it.ProviderIds?.tvdb ?? null;
    // These are Series items, so their Tmdb id is a TMDB *TV* id. Measured on
    // the live library: 2252 of 2271 series carry one, near-identical coverage
    // to Tvdb's 2259 — it adds almost nothing on TV but is the only usable id
    // for films, where TVDB covers 4 of 117 corpus entries against TMDB's 43.
    const tmdb = it.ProviderIds?.Tmdb ?? it.ProviderIds?.tmdb ?? null;
    series.push({
      id: String(it.Id),
      itemId: String(it.Id),
      title: String(it.Name),
      norms,
      tvdbId: tvdb == null ? null : String(tvdb),
      tmdbId: tmdb == null ? null : String(tmdb),
      year: typeof it.ProductionYear === 'number' ? it.ProductionYear : null,
    });
  }
  return series;
}

/**
 * The library, persisted across restarts — the biggest sibling of the
 * restart-safety rule on `persistMapSoon` above. In-memory only, the whole
 * library (2271 series, with ProviderIds) was refetched per restart: the first
 * viewer after every deploy paid for it, and in development it was most of
 * what pegged the Jellyfin server.
 */
async function loadPersistedLibrary(): Promise<{ series: JfSeries[]; total: number; at: number } | null> {
  try {
    const rows = await prisma.appConfig.findMany({
      where: { key: { in: [LIBRARY_KEY, LIBRARY_AT_KEY] } },
    });
    const raw = rows.find((r) => r.key === LIBRARY_KEY)?.value;
    const at = Number(rows.find((r) => r.key === LIBRARY_AT_KEY)?.value ?? 0);
    if (!raw || !at) return null;
    const parsed = JSON.parse(raw) as { series: JfSeries[]; total: number };
    if (!Array.isArray(parsed?.series) || !parsed.series.length) return null;
    return { series: parsed.series, total: parsed.total ?? parsed.series.length, at };
  } catch {
    return null; // a corrupt row must not take the integration down
  }
}

async function savePersistedLibrary(series: JfSeries[], total: number, at: number): Promise<void> {
  const value = JSON.stringify({ series, total });
  try {
    await prisma.appConfig.upsert({
      where: { key: LIBRARY_KEY }, update: { value }, create: { key: LIBRARY_KEY, value },
    });
    await prisma.appConfig.upsert({
      where: { key: LIBRARY_AT_KEY },
      update: { value: String(at) },
      create: { key: LIBRARY_AT_KEY, value: String(at) },
    });
  } catch (err) {
    console.warn('[jellyfin] could not persist the library cache', jellyfinErrorInfo(err));
  }
}

// The film index lives in lib/jellyfinFilmIndex.ts — an id index, never a
// matchable corpus. Imported above; warmed at boot in index.ts.

/** Series count only — no items serialised, so it is cheap to ask often. */
async function countSeries(api: Api): Promise<number | null> {
  const { data } = await getItemsApi(api).getItems(
    {
      includeItemTypes: [BaseItemKind.Series],
      recursive: true,
      limit: 0,
      enableImages: false,
      enableTotalRecordCount: true,
    },
    { timeout: 30_000 }
  );
  return typeof data.TotalRecordCount === 'number' ? data.TotalRecordCount : null;
}

/**
 * Every series in the library, cached 1 h in memory and indefinitely in the DB.
 *
 * A refresh is incremental where it safely can be. Jellyfin does not return
 * `DateLastSaved` on items, so the watermark is our own fetch time rather than
 * a max over the results — hence the overlap window.
 */
export async function getSeriesLibrary(api: Api, force = false): Promise<JfSeries[]> {
  if (!force && _library && _library.expires > Date.now()) return _library.series;
  // Coalesce: the Randomize page asks about every show at once, and without
  // this each request pulled the whole library separately — dozens of
  // simultaneous full-library queries that all timed out, which reported
  // every show as missing.
  if (_libraryInFlight) return _libraryInFlight;

  // Stale-while-revalidate, the same rule `/api/anime` already applies to an
  // expired SeasonCache row. Expiry used to make the *next* request pay for the
  // refresh: open Randomize an hour after anyone last did, and the page waited
  // on a count probe plus a refetch before it could say whether a single show
  // was in the library — with nothing on screen to say why. The stale answer is
  // seconds-to-an-hour old and describes a library that changes when media is
  // added, so serving it while refreshing behind costs a viewer nothing.
  const stale = _libraryPersisted ?? (await loadPersistedLibrary());
  _libraryPersisted = stale;
  if (!force && stale?.series?.length) {
    void getSeriesLibraryFresh(api, false).catch(() => {});
    return stale.series;
  }
  return getSeriesLibraryFresh(api, force);
}

/** The blocking refresh. Only awaited when there is no usable copy to serve. */
async function getSeriesLibraryFresh(api: Api, force: boolean): Promise<JfSeries[]> {
  if (_libraryInFlight) return _libraryInFlight;

  _libraryInFlight = (async () => {
    const cached = _libraryPersisted ?? (await loadPersistedLibrary());
    _libraryPersisted = cached;

    // A warm process restart: the DB copy is still inside its TTL, so there is
    // nothing to ask Jellyfin at all.
    if (!force && cached && Date.now() - cached.at < LIBRARY_TTL_MS) {
      _library = { series: cached.series, expires: cached.at + LIBRARY_TTL_MS };
      return cached.series;
    }

    const now = Date.now();
    let series: JfSeries[] | null = null;
    let total: number | null = null;

    if (!force && cached && now - cached.at < LIBRARY_FULL_REFRESH_MS) {
      // Cheap probe first. A changed count means something was added or
      // removed, and removals are the one thing an incremental fetch cannot
      // show us — so that case falls through to a full refresh.
      try {
        const count = await countSeries(api);
        if (count != null && count === cached.total) {
          const { data } = await getItemsApi(api).getItems(
            {
              includeItemTypes: [BaseItemKind.Series],
              recursive: true,
              fields: SERIES_FIELDS,
              enableImages: false,
              enableTotalRecordCount: false,
              minDateLastSaved: new Date(cached.at - LIBRARY_OVERLAP_MS).toISOString(),
            },
            { timeout: 60_000 }
          );
          const changed = toJfSeries(data.Items ?? []);
          const merged = new Map(cached.series.map((s) => [s.id, s]));
          for (const s of changed) merged.set(s.id, s);
          series = [...merged.values()];
          total = count;
          if (changed.length) {
            console.log(`[jellyfin] library: ${changed.length} series changed since last sync`);
          }
        }
      } catch (err) {
        // NOT `err` — an axios error carries the auth header. See jellyfinErrorInfo.
        console.warn('[jellyfin] incremental library refresh failed, falling back to full',
                     jellyfinErrorInfo(err));
      }
    }

    if (!series) {
      const { data } = await getItemsApi(api).getItems(
        {
          includeItemTypes: [BaseItemKind.Series],
          recursive: true,
          fields: SERIES_FIELDS,
          enableImages: false,
          enableTotalRecordCount: true,
        },
        // A few thousand series is a big response; the instance default is sized
        // for small metadata calls.
        { timeout: 60_000 }
      );
      series = toJfSeries(data.Items ?? []);
      total = typeof data.TotalRecordCount === 'number' ? data.TotalRecordCount : series.length;
    }

    _library = { series, expires: now + LIBRARY_TTL_MS };
    _libraryPersisted = { series, total: total ?? series.length, at: now };
    await savePersistedLibrary(series, total ?? series.length, now);
    return series;
  })();

  try {
    return await _libraryInFlight;
  } finally {
    _libraryInFlight = null;
  }
}

/**
 * Which episode does this AniList entry start at?
 *
 * **Air date is the primary signal, not the title.** Titles are a bad join key:
 * `detectSeasonNumber` only understands "Nth Season" / "Season N" / 第N期, so
 * `Part 2`, roman numerals (`II`), trailing digits (`Edgerunners 2`) and named
 * arcs all fell through to "first episode overall" — and the worst case isn't a
 * missing match, it's a confident wrong one. *BLEACH: Thousand-Year Blood War -
 * The Calamity* resolved to `S1E1 · The Day I Became a Shinigami`, an episode
 * from 2004, because TVDB models all of TYBW as later seasons of the original
 * Bleach and the entry's title carries no season marker at all.
 *
 * An air date has none of those problems: it is language-independent, needs no
 * marker, and is the same fact on both sides. Against that same entry it picks
 * `S17E41` — 0 days off — and note it lands *mid-season*, on the cour boundary,
 * which a season number cannot even express.
 *
 * The title tiers remain as the fallback, because the air date can be absent
 * (no `startDate`), useless (a `year`-only partial), or unmatched (the library
 * simply doesn't have that season — in which case nothing lands inside the
 * tolerance and a season-marked entry correctly reports unavailable).
 */
async function getFirstEpisode(
  api: Api,
  seriesId: string,
  seasonNumber: number | null,
  airDateMs: number | null = null
) {
  // Deliberately WITHOUT MediaSources. Asking for it here makes Jellyfin
  // enumerate the media sources of *every* episode — real disk work — to obtain
  // exactly one id, and the Randomize page runs this for every show on the
  // wheel. A 50-show list did that 50 times over on every cold load, which is
  // most of what pegged the server. Everything the choice below needs
  // (ParentIndexNumber, IndexNumber, Name, Id) is a default field.
  const { data } = await getTvShowsApi(api).getEpisodes(
    { seriesId, enableImages: false },
    { timeout: 30_000 }
  );
  const eps = data.Items ?? [];
  if (!eps.length) return null;

  // ── Tier 1: air date ────────────────────────────────────────────────────
  // `PremiereDate` is a default field on this endpoint (verified against the
  // live server), so this costs no extra request.
  if (airDateMs != null) {
    const closest = closestDatedEpisode(eps, airDateMs);
    const best = closest?.episode ?? null;
    const bestDelta = closest?.deltaMs ?? Infinity;
    if (best && bestDelta <= AIR_DATE_TOLERANCE_MS) {
      return finishEpisode(api, best);
    }
    // We had a usable air date, the series has dated episodes, and *none* of
    // them is anywhere near it. That is positive evidence the library holds a
    // different part of this franchise, not this entry — so say so, rather than
    // falling through to "first episode overall" and confidently offering an
    // episode from 20 years earlier. This is the other half of the BLEACH case:
    // the tier above fixes it when the library HAS the season, and this fixes it
    // when the library doesn't.
    //
    // Guarded on `best` so a library whose episodes carry no PremiereDate at all
    // (nothing to compare) still falls through instead of vanishing.
    if (best && seasonNumber == null) return null;
  }

  // ── Tier 2: season marker in the title, else first episode overall ──────
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
  return finishEpisode(api, pool[0]);
}

/** Resolve the one chosen episode's media source id. */
async function finishEpisode(api: Api, ep: any) {
  // Now — and only now — ask for the one episode's media sources. Measured on
  // this library, 8 of 8 sampled episodes report a source id equal to their
  // item id, so this call almost always confirms what the fallback would have
  // guessed. It stays because "almost" is doing real work: an item with merged
  // versions has distinct source ids, and picking the wrong one breaks
  // playback. One file probe per matched show, where asking the episode list
  // for MediaSources was one per episode.
  let mediaSourceId = String(ep.Id);
  try {
    const { data: one } = await getItemsApi(api).getItems(
      { ids: [String(ep.Id)], fields: [ItemFields.MediaSources] },
      { timeout: 30_000 }
    );
    const src = one.Items?.[0]?.MediaSources?.[0]?.Id;
    if (src) mediaSourceId = String(src);
  } catch {
    /* fall back to the item id, as the previous code did on an empty list */
  }
  return {
    itemId: String(ep.Id),
    mediaSourceId,
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
    const configured = !!(await getJellyfinConfig());
    // A false here silently removes every Watch button and disables
    // Hide-Not-in-Library for that browser session, and left no trace at all.
    if (!configured) console.warn('[jellyfin] /status answered configured:false — library UI will be hidden');
    res.json({ configured, isAdmin });
  } catch (err: any) {
    console.warn('[jellyfin] /status failed, answering configured:false:', err?.message ?? err);
    res.json({ configured: false, isAdmin });
  }
});

// Availability: is this AniList entry in the library, and what is its first
// episode? Cached per mediaId (1 h positives, 10 min negatives so newly-added
// shows appear without a restart). Always 200 — the server being down or
// unconfigured is `{ available: false, unknown: true }`, never an error.
/** `v` is MATCH_ALGO_VERSION — entries from an older matcher are dropped on load. */
const availabilityCache = new Map<number, { data: any; expires: number; v?: number }>();
const AVAILABILITY_KEY = 'jellyfinAvailability';
const AVAILABILITY_MAX = 500; // a couple of seasons' worth; bounded like sourceDims

/**
 * Bump when the matching logic changes, to drop answers the *old* logic
 * produced.
 *
 * This cache is persisted and entries live up to an hour, so without a version
 * a matcher fix doesn't take effect for existing entries until they expire —
 * a deploy that corrects a wrong episode would keep serving the wrong episode
 * across the restart, which is the one moment someone is looking for the fix.
 *
 * 2: episode chosen by air date, with a miss treated as evidence the library
 *    doesn't hold this entry (was: first episode of the title-parsed season).
 * 3: a known id is authoritative in both directions — an id the library lacks
 *    ends the lookup instead of falling back to titles. Every cached "available"
 *    produced by the old rule has to go: 12 of them were the wrong series.
 */
const MATCH_ALGO_VERSION = 3;

/**
 * Record one availability answer, in memory and (debounced) on disk.
 *
 * Entries carry an absolute `expires`, so they age correctly across a restart
 * with no extra bookkeeping — a 10-minute negative written before a deploy is
 * still a 10-minute negative after it.
 */
function rememberAvailability(mediaId: number, data: any, ttlMs: number): void {
  // A match made before the id map has loaded skipped the id tier, so it is
  // provisional — it may be title-tier where it should be exact, or missing
  // where it should match. Caching it would pin that degraded answer for up to
  // an hour, trading the blocking fetch this replaced for something worse.
  // Requests during that window still get an answer; it just isn't recorded.
  //
  // This now also covers the override table, and the reason is sharper than it
  // was: with the negative-evidence rule, "no id" doesn't merely downgrade a
  // match, it decides whether a title match is *allowed at all*. Caching an
  // answer computed before the ids were readable would pin a verdict reached
  // under different rules.
  if (!identityReady()) return;
  // `unknown` means "couldn't ask", not "not in the library". Caching it at all
  // would make one slow moment stick; persisting it would make that survive a
  // restart. The call sites already avoid this — the guard is here so a future
  // one can't reintroduce it silently.
  if (data?.unknown) return;

  if (availabilityCache.size >= AVAILABILITY_MAX) {
    availabilityCache.delete(availabilityCache.keys().next().value as number);
  }
  availabilityCache.set(mediaId, { data, expires: Date.now() + ttlMs, v: MATCH_ALGO_VERSION });
  persistMapSoon(AVAILABILITY_KEY, availabilitySnapshot);
}

/** What the persisted availability blob holds: live, non-unknown entries only. */
function availabilitySnapshot() {
  const now = Date.now();
  return [...availabilityCache].filter(([, v]) => v.expires > now && !v.data?.unknown);
}

// The point of writing an identity override is to change the verdict. Leaving
// the cached one in place would mean the correction appears to do nothing for
// up to an hour — which reads exactly like the feature is broken. The persist
// matters as much as the delete: without it the on-disk blob still holds the
// old answer, and a restart inside the debounce window restores it, silently
// reverting the correction. Registered here (not in the route handlers) so the
// daily sweep's writes invalidate too.
onIdentityChanged((id) => {
  availabilityCache.delete(id);
  persistMapSoon(AVAILABILITY_KEY, availabilitySnapshot);
});

/**
 * Seed the two in-memory caches from their persisted copies.
 *
 * Fire-and-forget: a request arriving before this resolves simply misses and
 * fetches, which is exactly what used to happen on every restart. Expired
 * entries are dropped on the way in rather than being trusted and re-checked.
 */
void (async () => {
  const now = Date.now();
  try {
    let dropped = 0;
    for (const [k, v] of await loadPersistedEntries<number, { data: any; expires: number; v?: number }>(AVAILABILITY_KEY)) {
      // Absent `v` means "written before versioning" — an older matcher either way.
      if (v?.v !== MATCH_ALGO_VERSION) { dropped++; continue; }
      if (v?.expires > now && !v.data?.unknown) availabilityCache.set(Number(k), v);
    }
    if (dropped) {
      console.log(`[jellyfin] dropped ${dropped} availability entries from an older matcher`);
    }
    for (const [k, v] of await loadPersistedEntries<string, { dims: any; at: number }>(SOURCE_DIMS_KEY)) {
      if (v?.at && now - v.at < SOURCE_DIMS_TTL_MS) sourceDims.set(String(k), v);
    }
    if (availabilityCache.size || sourceDims.size) {
      console.log(`[jellyfin] restored ${availabilityCache.size} availability + ${sourceDims.size} source-dims entries`);
    }
  } catch {
    // Caches are optional by definition; a failed restore just means a cold start.
  }
})();

/** Shape check for one `{ mediaId, titles }` pair. */
function invalidEntry(mediaId: unknown, titles: unknown): boolean {
  return (
    !Number.isInteger(mediaId) ||
    !Array.isArray(titles) ||
    titles.length === 0 ||
    titles.length > 10 ||
    titles.some((t) => typeof t !== 'string' || !t.trim() || t.length > 300)
  );
}

/**
 * Resolve one entry, cache included. Shared by the single and batch routes so
 * the matching rules have exactly one definition — a second copy is how the two
 * would come to disagree about what counts as available.
 *
 * Never throws: a failure becomes `{ available: false, unknown: true }`, which
 * means "couldn't ask" rather than "not in the library" and is deliberately not
 * cached. In a batch that keeps one bad entry from contaminating the rest.
 */
async function resolveAvailability(
  api: Api,
  mediaId: number,
  titles: string[],
  fresh = false,
  startDate?: { year?: number | null; month?: number | null; day?: number | null } | null
): Promise<any> {
  // `fresh: true` means "re-resolve this; don't hand me a cached answer".
  //
  // The pop-up sends it when a show reads as unavailable, so a just-downloaded
  // series appears without waiting out the 10-minute negative TTL. It used to
  // bypass *only* negatives, which matched that one caller but made the flag
  // mean something narrower than its name — and left no way to force a real
  // resolution at all. That mattered once the cache started surviving restarts:
  // `test_jellyfin` proves the AniList->TVDB id tier is alive by checking that
  // some series matched by `id`, and with every answer served from cache it was
  // reading a recording rather than exercising the matcher. A mutation that
  // disabled the tier outright went unnoticed.
  //
  // Widening it costs nothing in production: the only caller sends it for
  // negatives, which behaved this way already.
  const cached = availabilityCache.get(mediaId);
  if (cached && cached.expires > Date.now() && !fresh) {
    return cached.data;
  }

  try {
    // AniList id → TVDB id, when the community map knows this entry. Absent
    // is normal (coverage tracks how long a season has aired) and simply
    // means the match falls back to titles.
    // Deliberately NOT awaited. This used to be `await ensureAnilistTvdbMap()`,
    // which on a fresh process with a stale map joins the boot refresh and
    // blocks the viewer's request on a 7.5 MB GitHub download (60s timeout),
    // re-arming on every deploy. The map only ever gains entries and a missing
    // one degrades this match to title-tier — which the module itself calls
    // "degraded, not broken" — so a request reads whatever is loaded and never
    // waits on a third party.
    void ensureAnilistTvdbMap();
    // Our override table first, then the community map — see `seriesIdentity.ts`.
    // An id found here is authoritative in BOTH directions: if the library
    // doesn't carry it, `matchSeries` returns null rather than guessing from
    // titles. That single rule removed the entire remaining false-positive
    // class (12 of 945 corpus entries, every one a new work matched onto its
    // franchise parent) at zero cost to correct matches.
    const identity = resolveIdentity(mediaId);
    // An admin has said outright that this entry is not in the library. That has
    // to short-circuit *before* matching, because a rejection carries no ids and
    // would otherwise fall straight through to the title tier — which is exactly
    // the match being rejected. Without this the Reject button on
    // /admin/matching writes its row, drops the entry from the review list, and
    // leaves the wrong Watch button on screen.
    if (identity.rejected) {
      const data = { available: false, matchedBy: 'override' };
      rememberAvailability(mediaId, data, 60 * 60 * 1000);
      return data;
    }
    // A film is resolved against films, never against the series list. If we
    // know an entry is a film and we do not hold it, that IS the answer —
    // falling through to title-matching a list of TV shows is a category error,
    // and it is where "The Last Blossom" -> *House* came from. Measured: cutting
    // it removes 26 wrong matches and costs 1 real one.
    if (identity.tmdbKind === 'movie' && identity.tmdbId) {
      const films = await getFilmIndex(api);
      const film = films[identity.tmdbId];
      if (!film) {
        const data = { available: false, matchedBy: 'id' };
        rememberAvailability(mediaId, data, 10 * 60 * 1000);
        return data;
      }
      const item = await finishEpisode(api, { Id: film.itemId, Name: film.title });
      const data = {
        available: true,
        seriesId: film.itemId,
        itemId: item.itemId,
        mediaSourceId: item.mediaSourceId,
        // A film has no season or episode; the item itself is what plays.
        episodeTitle: film.title,
        seasonNumber: null,
        episodeNumber: null,
        libraryTitle: film.title,
        matchedBy: 'id',
        unverified: identity.source === 'remote' && !identity.confirmed,
      };
      rememberAvailability(mediaId, data, 60 * 60 * 1000);
      return data;
    }

    const entry = {
      tvdbId: identity.tvdbId,
      // Only a TV-namespaced id can mean anything against a Series list; TMDB
      // numbers movies and shows independently, so passing a film's id here
      // could only ever match by coincidence.
      tmdbId: identity.tmdbKind === 'tv' ? identity.tmdbId : null,
      titles,
      // A resolver guess is positive-only: it may add a Watch button, never take
      // one away. Only the community map and human-confirmed rows may end the
      // lookup on a miss.
      idIsAuthoritative: identity.source !== 'remote' || identity.confirmed,
    };

    let library = await getSeriesLibrary(api);
    let hit = matchSeries(entry, library);
    if (!hit && fresh && Date.now() - _lastLibraryRefresh > 30_000) {
      // A fresh re-check should notice a just-added show, but only one
      // refetch per 30s: every negative result asking for its own refetch
      // turned into a stampede that reported everything as missing.
      _lastLibraryRefresh = Date.now();
      library = await getSeriesLibrary(api, true);
      hit = matchSeries(entry, library);
    }
    if (!hit) {
      const data = { available: false };
      rememberAvailability(mediaId, data, 10 * 60 * 1000);
      return data;
    }

    // Which episode this entry starts at. The air date decides when we have one
    // and the library holds a matching broadcast; the season marker is the
    // fallback, and still makes a "3rd Season" entry honestly unavailable when
    // the library lacks season 3.
    const seasonNumber = detectSeasonNumber(titles);
    const episode = await getFirstEpisode(
      api, hit.series.id, seasonNumber, anilistDateToMs(startDate)
    );
    if (!episode) {
      const data = { available: false, libraryTitle: hit.series.title, matchedBy: hit.confidence };
      rememberAvailability(mediaId, data, 10 * 60 * 1000);
      return data;
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
      // Which fuzzy tier hit: 0 exact, 1 prefix. (A contains-anywhere tier
      // existed and was removed — measured wrong 9 times out of 9.) Worth
      // reporting because "fuzzy" lumps together two very different things: an
      // exact normalised title ("Mebius Dust" == "Mebius Dust") measured 99%
      // precise against the id tier, while prefix measured 60%. Both used to
      // raise the same "unconfirmed match" warning, which made it noise on the
      // common case and easy to ignore on the dangerous one.
      titleTier: hit.tier,
      // An id match is normally exact — but a `remote` id is one the resolver
      // *guessed* from a TMDB search, so it deserves the same warning a partial
      // title match gets. Without this the UI would present a guess as fact,
      // which is the opposite of what the confidence markers exist for. A row a
      // human confirmed on /admin/matching is fact again.
      unverified: hit.confidence === 'id' && identity.source === 'remote' && !identity.confirmed,
    };
    rememberAvailability(mediaId, data, 60 * 60 * 1000);
    return data;
  } catch (err: any) {
    // Deliberately NOT cached — a transient hiccup shouldn't stick. `unknown`
    // distinguishes "we couldn't ask" from "the library doesn't have it", so
    // the UI never claims a show is missing (or hides it) on a timeout.
    console.warn(`[jellyfin] availability lookup failed for ${mediaId}:`, err?.message ?? err);
    return { available: false, unknown: true };
  }
}

router.post('/availability', jellyfinLimiter, requireAuth, async (req, res) => {
  const { mediaId, titles, fresh, startDate } = req.body ?? {};
  if (invalidEntry(mediaId, titles)) {
    return res.status(400).json({
      error: 'Expected { mediaId: int, titles: string[1..10] }',
      code: 'BAD_REQUEST',
    });
  }

  const cfg = await getJellyfinConfig();
  // `unknown` as well as `configured: false`: "we can't say" must never be
  // read as "the library doesn't have it", or a tab whose config probe is
  // stale-true would let Hide-Not-in-Library hide the entire list.
  if (!cfg) return res.json({ available: false, configured: false, unknown: true });

  res.json(await resolveAvailability(
    await jellyfinApi(cfg), mediaId, titles, fresh === true, startDate
  ));
});

/**
 * The same question for a whole page of shows, in one request.
 *
 * Randomize asks about every wheel item, and asking one at a time meant ~50 HTTP
 * requests per page load — 40% of this router's own 120/min budget, repeated on
 * every full page load because the browser-side cache doesn't outlive one. On a
 * cold backend those 50 also became 50 Jellyfin episode lookups.
 *
 * The single-entry route above stays: the pop-up's `fresh: true` re-check really
 * is one show at a time, and its 30 s refetch throttle assumes that.
 */
const AVAILABILITY_BATCH_MAX = 100; // mirrors /api/translate/check-batch

router.post('/availability/batch', jellyfinLimiter, requireAuth, async (req, res) => {
  const { items } = req.body ?? {};
  if (!Array.isArray(items) || items.length === 0 || items.length > AVAILABILITY_BATCH_MAX) {
    return res.status(400).json({
      error: `Expected { items: [{ mediaId, titles }] } with 1..${AVAILABILITY_BATCH_MAX} entries`,
      code: 'BAD_REQUEST',
    });
  }
  if (items.some((it: any) => invalidEntry(it?.mediaId, it?.titles))) {
    return res.status(400).json({
      error: 'Each item must be { mediaId: int, titles: string[1..10] }',
      code: 'BAD_REQUEST',
    });
  }

  const cfg = await getJellyfinConfig();
  if (!cfg) {
    // Same rule per entry as the single route: unconfigured is "can't say".
    const out: Record<number, any> = {};
    for (const it of items) out[it.mediaId] = { available: false, configured: false, unknown: true };
    return res.json(out);
  }

  const api = await jellyfinApi(cfg);
  const out: Record<number, any> = {};
  // A warm cache makes every entry a Map lookup, so this pool only matters on a
  // cold one — where the point is to walk the library at a steady rate rather
  // than open 50 simultaneous episode queries against it.
  const CONCURRENCY = 5;
  let next = 0;
  const startedAt = Date.now();
  const worker = async () => {
    while (next < items.length) {
      const it = items[next++];
      out[it.mediaId] = await resolveAvailability(api, it.mediaId, it.titles, false, it.startDate);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));

  // One line that separates every way this can go. Without it, "no Watch
  // buttons on the page" was indistinguishable from "everything resolved and
  // nothing was missing" — from the logs as well as on screen — which is why a
  // real report cost four wrong theories and no answer. `unknown` is the one to
  // watch: it means the lookup failed, not that the show is absent.
  const vals = Object.values(out) as any[];
  const unknown = vals.filter((v) => v?.unknown).length;
  const available = vals.filter((v) => v?.available).length;
  const line =
    `[jellyfin] availability batch: ${items.length} asked, ${available} available, ` +
    `${vals.length - available - unknown} absent, ${unknown} unknown, ${Date.now() - startedAt}ms`;
  if (unknown) console.warn(`${line}  <- ${unknown} lookup(s) FAILED, not "not in library"`);
  else console.log(line);
  res.json(out);
});

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

/**
 * Quality tiers the player offers. `auto` is resolved per item from the
 * source's own bitrate, because Jellyfin will not encode above it anyway.
 */
const QUALITY: Record<string, { width: number; bitrate: number } | null> = {
  auto: null,
  '1080p': { width: 1920, bitrate: 8_000_000 },
  '720p': { width: 1280, bitrate: 4_000_000 },
  '480p': { width: 854, bitrate: 1_500_000 },
};


/**
 * The Jellyfin account playback runs as.
 *
 * **PlaybackInfo silently ignores a DeviceProfile without a user id** — it
 * returns a perfectly valid response with no `TranscodingUrl`, which reads
 * exactly like "the profile was rejected". An API key authenticates the request
 * but does not identify a viewer, and Jellyfin needs a viewer to apply policy
 * against.
 *
 * Configure a **dedicated SaltyChart account** (`jellyfinUserId` in AppConfig,
 * set from /admin). It needs library access and no bitrate or parental-rating
 * limit; it does not need to be an administrator. A dedicated account keeps
 * playback off a real person's account and means tightening someone's policy
 * later can't silently degrade playback for everyone.
 *
 * Nothing is written to that account's watch history either way: Jellyfin only
 * records progress when a client reports it via `/Sessions/Playing`, and this
 * proxy never does — verified against episodes played repeatedly during
 * testing, which stayed at `playCount=0, lastPlayed=never`.
 *
 * Falls back to an administrator when unset, so the integration keeps working
 * before anyone visits /admin.
 */
let cachedUserId: { id: string; at: number } | null = null;

async function jellyfinUserId(cfg: JellyfinConfig): Promise<string | null> {
  const row = await prisma.appConfig.findUnique({ where: { key: 'jellyfinUserId' } });
  const configured = (row?.value ?? '').trim();
  if (configured) return configured;
  if (cachedUserId && Date.now() - cachedUserId.at < 3_600_000) return cachedUserId.id;
  try {
    const { data } = await getUserApi(await jellyfinApi(cfg)).getUsers();
    const admin = data.find((u) => u.Policy?.IsAdministrator) ?? data[0];
    if (!admin?.Id) return null;
    cachedUserId = { id: String(admin.Id), at: Date.now() };
    return cachedUserId.id;
  } catch {
    return null;
  }
}

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
  const quality = String(req.query.quality ?? 'auto');
  if (!(quality in QUALITY)) {
    return res.status(400).json({ error: 'Unknown quality', code: 'BAD_REQUEST' });
  }
  const subtitleIndex = Number(req.query.subtitleIndex);
  const cfg = await getJellyfinConfig();
  if (!cfg) return res.status(503).json({ error: 'Jellyfin not configured', code: 'UPSTREAM_ERROR' });
  try {
    const api = await jellyfinApi(cfg);
    // The source's own dimensions, for `auto`. Two things make this cheaper
    // than it was:
    //
    //   * an explicit tier (1080p/720p/480p) doesn't need them at all — the
    //     numbers come from QUALITY — yet this used to probe anyway and throw
    //     the answer away, once per quality switch;
    //   * they cannot change for a given file, so the answer is cached rather
    //     than re-asked. Opening one pop-up makes two /playback calls (one to
    //     learn the tracks, one for the chosen track), which was four upstream
    //     PlaybackInfo requests where two will do.
    const dimsKey = `${itemId}:${req.query.mediaSourceId ?? ''}`;
    let dims = sourceDims.get(dimsKey)?.dims;
    if (!dims && QUALITY[quality] == null) {
      const probe = await getMediaInfoApi(api).getPostedPlaybackInfo({
        itemId,
        ...(typeof req.query.mediaSourceId === 'string'
          ? { mediaSourceId: req.query.mediaSourceId }
          : {}),
      });
      const probeSrc = probe.data.MediaSources?.[0];
      const probeVideo = (probeSrc?.MediaStreams ?? []).find(
        (s) => s.Type === MediaStreamType.Video
      );
      dims = {
        width: Number(probeVideo?.Width) || 0,
        bitrate: Number(probeVideo?.BitRate) || Number(probeSrc?.Bitrate) || 0,
      };
      rememberSourceDims(dimsKey, dims);
    }
    const tier = QUALITY[quality] ?? {
      width: dims?.width || 1920,
      bitrate: dims?.bitrate || 8_000_000,
    };

    const userId = await jellyfinUserId(cfg);
    // The profile goes in the body; everything else stays a query parameter.
    // `userId` in particular must NOT move into the DTO — PlaybackInfo without
    // it returns a valid response with no TranscodingUrl at all, which reads
    // exactly like the profile was rejected.
    const { data } = await getMediaInfoApi(api).getPostedPlaybackInfo({
      itemId,
      ...(typeof req.query.mediaSourceId === 'string'
        ? { mediaSourceId: req.query.mediaSourceId }
        : {}),
      // -1 is Jellyfin's "no subtitles", and it has to be sent: omitting
      // the parameter makes Jellyfin choose a default track, which with
      // burn-in puts subtitles on screen for a viewer who turned them off.
      ...(Number.isInteger(subtitleIndex) && subtitleIndex >= -1
        ? { subtitleStreamIndex: subtitleIndex }
        : {}),
      ...(userId ? { userId } : {}),
      maxStreamingBitrate: tier.bitrate,
      autoOpenLiveStream: true,
      playbackInfoDto: { DeviceProfile: deviceProfile(tier.width, tier.bitrate) },
    });
    const src = data.MediaSources?.[0];
    if (!src) return res.status(404).json({ error: 'No media source', code: 'UPSTREAM_ERROR' });
    const subtitles = (src.MediaStreams ?? [])
      .filter((s) => s.Type === MediaStreamType.Subtitle && Number.isInteger(s.Index))
      .map((s) => ({
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
      .filter((a) => Number.isInteger(a.Index))
      .map((a) => ({
        index: a.Index,
        fileName: String(a.FileName ?? ''),
        mimeType: String(a.MimeType ?? ''),
      }));
    // Jellyfin names the URL it wants us to play, given the profile we sent.
    // Building one by hand is what produced 416x234 and a day of guessing at
    // query parameters; this is the server's own answer. It is relative
    // ("/videos/…"), so the frontend prefixes the proxy mount.
    //
    // **It embeds the API key.** Jellyfin writes `ApiKey=<the key>` into the
    // URL, and handing that to a browser would publish the credential to every
    // viewer — the exact thing the manifest guard below exists to prevent, and
    // which it caught when this was first wired up. Strip it here; the proxy
    // injects the key server-side on every hop anyway.
    const rawUrl: string | null = src.TranscodingUrl ?? null;
    let transcodingUrl: string | null = null;
    if (rawUrl) {
      const [path, query = ''] = rawUrl.split('?');
      const params = new URLSearchParams(query);
      for (const k of [...params.keys()]) {
        if (/^(api_?key|x-emby-token)$/i.test(k)) params.delete(k);
      }
      transcodingUrl = `${path}?${params.toString()}`;
    }
    if (!transcodingUrl) {
      // Only happens if Jellyfin thinks direct play applies — it cannot here,
      // since DirectPlayProfiles is empty and browsers can't demux MKV.
      console.warn(`[jellyfin] no TranscodingUrl for ${itemId} (quality=${quality})`);
    }

    res.json({
      playSessionId: String(data.PlaySessionId ?? ''),
      mediaSourceId: String(src.Id),
      runTimeTicks: src.RunTimeTicks ?? null,
      subtitles,
      attachments,
      transcodingUrl,
      quality,
      // So "Auto" in the quality menu can show what it actually resolved to.
      sourceWidth: dims?.width || null,
      sourceBitrate: dims?.bitrate || null,
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
 * send `subtitleMethod=Hls` (subtitles are burned into the video), and this
 * check makes that a guarantee rather than a convention.
 */
router.get('/stream/*', streamLimiter, async (req, res) => {
  const prep = await prepareProxy(req as AuthRequest, res, '/api/jellyfin/stream');
  if (!prep) return;
  const { upstream, cfg } = prep;

  const headers: Record<string, string> = {
    Authorization: jellyfinAuthHeader(cfg.apiKey),
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
 * A subtitle track, converted by Jellyfin on its own box. `.ass` is a
 * pass-through of the original (styling, positioning, karaoke intact).
 *
 * NOT on the playback path any more — Jellyfin burns subtitles into the video
 * — but kept and tested: it is the only way to inspect what a release ships.
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

/**
 * An embedded font. Off the playback path (Jellyfin burns subtitles in using
 * the episode's own fonts); kept because it is the only way to see what a
 * release ships, and test_player asserts nothing requests it during playback.
 */
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

/**
 * Shared fetch for the two small-file endpoints above. Not routed through the
 * `/stream/*` proxy because the path is built here from validated parts
 * rather than taken from the caller.
 */
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
    // Must be the same device id the stream was started under, or Jellyfin
    // matches nothing and the encode quietly survives.
    await getHlsSegmentApi(await jellyfinApi(cfg)).stopEncodingProcess({
      deviceId: DEVICE_ID,
      playSessionId,
    });
    res.json({ ok: true });
  } catch (err: any) {
    console.warn('[jellyfin] could not stop encoding:', err?.message);
    res.json({ ok: false }); // best-effort; the session times out anyway
  }
});

export default router;
