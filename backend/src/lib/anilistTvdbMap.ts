import prisma from '../db';

// ---------------------------------------------------------------------------
// AniList → TVDB id map.
//
// Community-maintained by Fribb/anime-lists. We keep only the id pairs (~7.2k
// of them, ~150 KB as JSON) in an AppConfig row so the map survives restarts
// and a GitHub outage — an unreachable upstream must never break availability
// lookups, it just costs the confidence tier.
//
// Coverage is a function of season maturity, not of tooling: ~55% for a season
// two months out, ~94% once it has finished airing, because TVDB entries for
// new anime are created close to airing and the mapping files pick them up
// afterwards. So this can never be the only matcher — see `animeMatch.ts`.
// ---------------------------------------------------------------------------

const SOURCE_URL =
  'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json';
const MAP_KEY = 'anilistTvdbMap';
const FETCHED_AT_KEY = 'anilistTvdbMapAt';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // weekly is plenty; entries only get added
const FETCH_TIMEOUT_MS = 60_000;

/** anilistId → tvdbId. Empty until loaded; never null, so callers need no guard. */
let _map: Record<string, string> = {};
let _loaded = false;
let _inFlight: Promise<void> | null = null;

/**
 * Pull the list from GitHub and reduce it to id pairs.
 *
 * NOTE the field is `tvdb_id`, not `thetvdb_id` — the file carries both shapes
 * across its history and reading the wrong one silently yields an empty map.
 */
async function fetchPairs(): Promise<Record<string, string>> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(SOURCE_URL, { signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = (await res.json()) as any[];
    const pairs: Record<string, string> = {};
    for (const r of rows) {
      const a = r?.anilist_id;
      const t = r?.tvdb_id;
      if (a != null && t != null) pairs[String(a)] = String(t);
    }
    return pairs;
  } finally {
    clearTimeout(timer);
  }
}

async function readStored(): Promise<{ map: Record<string, string>; fetchedAt: number }> {
  const rows = await prisma.appConfig.findMany({
    where: { key: { in: [MAP_KEY, FETCHED_AT_KEY] } },
  });
  const raw = rows.find((r) => r.key === MAP_KEY)?.value;
  const at = Number(rows.find((r) => r.key === FETCHED_AT_KEY)?.value ?? 0);
  if (!raw) return { map: {}, fetchedAt: 0 };
  try {
    return { map: JSON.parse(raw), fetchedAt: at };
  } catch {
    return { map: {}, fetchedAt: 0 };
  }
}

async function store(map: Record<string, string>): Promise<void> {
  const value = JSON.stringify(map);
  await prisma.appConfig.upsert({
    where: { key: MAP_KEY },
    update: { value },
    create: { key: MAP_KEY, value },
  });
  await prisma.appConfig.upsert({
    where: { key: FETCHED_AT_KEY },
    update: { value: String(Date.now()) },
    create: { key: FETCHED_AT_KEY, value: String(Date.now()) },
  });
}

/**
 * Make sure the in-memory map is populated, refreshing from upstream when the
 * stored copy is older than a week. Never throws: on any failure we keep
 * whatever we already have (possibly nothing) and matching falls back to
 * titles alone.
 */
export async function ensureAnilistTvdbMap(force = false): Promise<void> {
  if (_loaded && !force) return;
  if (_inFlight) return _inFlight;

  _inFlight = (async () => {
    try {
      const { map, fetchedAt } = await readStored();
      if (Object.keys(map).length) {
        _map = map;
        _loaded = true;
      }
      const stale = Date.now() - fetchedAt > MAX_AGE_MS;
      if (force || stale || !Object.keys(map).length) {
        const fresh = await fetchPairs();
        if (Object.keys(fresh).length) {
          _map = fresh;
          _loaded = true;
          await store(fresh);
          console.log(`[anime-ids] AniList→TVDB map refreshed: ${Object.keys(fresh).length} pairs`);
        }
      }
    } catch (err: any) {
      // Degraded, not broken: without the map every match is title-only.
      console.warn('[anime-ids] could not refresh AniList→TVDB map:', err?.message ?? err);
      _loaded = true; // don't hammer a failing upstream on every request
    } finally {
      _inFlight = null;
    }
  })();
  return _inFlight;
}

/** The TVDB id for an AniList entry, or null when unmapped. */
export function tvdbIdForAnilist(anilistId: number | string): string | null {
  return _map[String(anilistId)] ?? null;
}

/** For diagnostics / the admin page. */
export function anilistTvdbMapSize(): number {
  return Object.keys(_map).length;
}
