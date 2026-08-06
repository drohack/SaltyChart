// ---------------------------------------------------------------------------
// TVDB via skyhook - Sonarr's own keyless metadata proxy.
//
// Why this exists: Jellyfin's remote search fronts TMDB only on this server,
// so a resolved series row carried a TVDB id only when the library or the
// community map could cross-walk it - which is exactly what failed for 125
// stored rows, the population a Sonarr request flow needs. skyhook answers
// with TVDB ids natively AND with per-episode air dates for seasons nobody
// holds yet (Frieren's S3 is listed before it airs), which is the evidence
// class the held-library air-date gate cannot produce for an unaired season.
// Measured before building: 37/125 gap rows gain a date-verified TVDB id,
// 18 more an exact-title one, and the rejected-sequel class resolves.
//
// A hit here is by definition a show Sonarr can resolve - same service.
//
// TWO RULES, same as every remote source in this codebase:
//   1. Never on a viewer's request path. Sweep and admin lookup only.
//   2. This is someone else's free service, run for Sonarr installs. Calls are
//      paced, bounded per sweep run, and every failure degrades to "no data" -
//      if skyhook dies, resolution falls back to the Jellyfin/TMDB path.
// ---------------------------------------------------------------------------
import axios from 'axios';
import { normalizeTitle } from './animeMatch';

export interface SkyhookSeries {
  tvdbId: string;
  title: string;
  /** Series premiere, `yyyy-mm-dd`, when TVDB knows it. */
  firstAired: string | null;
}

export interface SkyhookEpisode {
  seasonNumber: number;
  episodeNumber: number;
  airDate: string | null;
}

const BASE = 'https://skyhook.sonarr.tv/v1/tvdb';
const TIMEOUT_MS = 15_000;
const PACE_MS = 300;

type Fetcher = (url: string) => Promise<any>;

let _lastCall = 0;
const defaultFetch: Fetcher = async (url) => {
  // Self-pacing lives in the client so no caller can accidentally burst a
  // free public service.
  const wait = _lastCall + PACE_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  _lastCall = Date.now();
  const { data } = await axios.get(url, { timeout: TIMEOUT_MS });
  return data;
};

let _fetch: Fetcher = defaultFetch;
export function __setSkyhookFetchForTest(f: Fetcher | null): void {
  _fetch = f ?? defaultFetch;
}

/**
 * One show record: the episodes AND the TMDB id skyhook already hands us.
 *
 * The `tmdbId` was being downloaded and thrown away. It is the only *id-based*
 * cross-reference between the two providers available for free here, and
 * without it the same show found in TVDB and in TMDB stays two separate
 * candidates that look ambiguous but aren't. Merging them on matching titles
 * instead would be actively wrong - Echo's three candidates are all titled
 * exactly "Echo" and are three different films.
 */
export interface SkyhookShow {
  episodes: SkyhookEpisode[];
  /** TVDB's own TMDB cross-reference, when it has one. */
  tmdbId: string | null;
}

/** Per series, memoised - a sweep run asks about the same parent repeatedly. */
const _showCache = new Map<string, SkyhookShow>();
export function __clearSkyhookCachesForTest(): void {
  _showCache.clear();
}

function dateStr(v: unknown): string | null {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
}

export async function skyhookSearch(term: string): Promise<SkyhookSeries[]> {
  try {
    const data = await _fetch(`${BASE}/search/en/?term=${encodeURIComponent(term)}`);
    if (!Array.isArray(data)) return [];
    const out: SkyhookSeries[] = [];
    for (const r of data) {
      const id = r?.tvdbId;
      if (id == null) continue;
      out.push({
        tvdbId: String(id),
        title: String(r?.title ?? ''),
        firstAired: dateStr(r?.firstAired),
      });
    }
    return out;
  } catch {
    return [];
  }
}

export async function skyhookShow(tvdbId: string): Promise<SkyhookShow> {
  const hit = _showCache.get(tvdbId);
  if (hit) return hit;
  let show: SkyhookShow = { episodes: [], tmdbId: null };
  try {
    const data = await _fetch(`${BASE}/shows/en/${encodeURIComponent(tvdbId)}`);
    const raw = data?.episodes;
    const eps: SkyhookEpisode[] = Array.isArray(raw)
      ? raw
          .filter((e: any) => e && typeof e.seasonNumber === 'number' && typeof e.episodeNumber === 'number')
          .map((e: any) => ({
            seasonNumber: e.seasonNumber,
            episodeNumber: e.episodeNumber,
            airDate: dateStr(e.airDate),
          }))
      : [];
    show = { episodes: eps, tmdbId: data?.tmdbId != null ? String(data.tmdbId) : null };
  } catch {
    show = { episodes: [], tmdbId: null };
  }
  _showCache.set(tvdbId, show);
  return show;
}

/** Kept for callers that only want dates - one fetch either way. */
export async function skyhookEpisodes(tvdbId: string): Promise<SkyhookEpisode[]> {
  return (await skyhookShow(tvdbId)).episodes;
}

/** TVDB's own TMDB cross-reference - the evidence a candidate merge needs. */
export async function skyhookTmdbId(tvdbId: string): Promise<string | null> {
  return (await skyhookShow(tvdbId)).tmdbId;
}

/**
 * May this search result be date-checked at all?
 *
 * Normalized exact, or a prefix relation where the SHORTER side still carries
 * meaning. The floor originally existed because an earlier single-form version
 * of `baseTitles` collapsed "Re:Zero kara ..." to "Re", and a 2-char prefix
 * relates to everything ("Re:Born", in the measurement that shaped this).
 * `baseTitles` no longer produces that collapse - but the floor STAYS, because
 * genuinely short titles arrive regardless ("Q" and "mono" are full titles,
 * and "Mission" is a legitimate variant). Sharing a word is not a relation
 * either: "Lego Friends" vs "Natsume's Book of Friends" must fail here.
 */
const MIN_RELATION_CHARS = 5;
export function titleRelated(candidate: string | null | undefined, searched: string[]): boolean {
  const c = normalizeTitle(candidate ?? '');
  if (!c) return false;
  for (const s of searched) {
    const w = normalizeTitle(s ?? '');
    if (!w) continue;
    if (c === w) return true;
    const shorter = c.length <= w.length ? c : w;
    if (shorter.length < MIN_RELATION_CHARS) continue;
    if (c.startsWith(w) || w.startsWith(c)) return true;
  }
  return false;
}

/**
 * Distance from the entry premiere to the nearest SEASON PREMIERE (episode 1
 * of a season > 0), in ms. Episode-1-only is load-bearing: an AniList entry's
 * start date is a season start, and any weekly series has some mid-run episode
 * within days of any date - the first pass of the measurement "verified"
 * Natsume S7 against a Lego Friends episode that way. Season 0 is skipped for
 * the same reason `closestDatedEpisode` skips it: specials cluster around the
 * seasons they ship with.
 */
export function seasonPremiereDelta(episodes: SkyhookEpisode[], airDateMs: number | null): number | null {
  if (airDateMs == null) return null;
  let best: number | null = null;
  for (const e of episodes) {
    if (e.seasonNumber <= 0 || e.episodeNumber !== 1 || !e.airDate) continue;
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(e.airDate);
    if (!m) continue;
    const ms = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    if (!Number.isFinite(ms)) continue;
    const d = Math.abs(ms - airDateMs);
    if (best == null || d < best) best = d;
  }
  return best;
}

/**
 * Does TVDB list a season NEWER than its newest dated one, with no dates yet?
 * That is the Frieren-S3 shape: the season exists, its schedule doesn't - and
 * a held-library rejection of the parent is premature while it lasts. A dated
 * catalogue with holes behind the frontier (TVDB gaps happen) is NOT that.
 */
export function hasUndatedFutureSeason(episodes: SkyhookEpisode[]): boolean {
  let maxDated = 0;
  let maxSeason = 0;
  for (const e of episodes) {
    if (e.seasonNumber <= 0) continue;
    if (e.seasonNumber > maxSeason) maxSeason = e.seasonNumber;
    if (e.airDate && e.seasonNumber > maxDated) maxDated = e.seasonNumber;
  }
  return maxSeason > maxDated;
}
