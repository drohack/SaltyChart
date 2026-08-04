import prisma from '../db';

// ---------------------------------------------------------------------------
// AniList → TVDB / TMDB id map.
//
// Community-maintained by Fribb/anime-lists. We keep only the id pairs (~7.2k
// TVDB + ~8.1k TMDB, a few hundred KB as JSON) in AppConfig rows so the map
// survives restarts and a GitHub outage — an unreachable upstream must never
// break availability lookups, it just costs the confidence tier.
//
// Coverage, measured over 8 seasons (945 entries) rather than assumed:
//
//   TV       404 entries   94% have a TVDB id
//   ONA      184            40%
//   TV_SHORT 101            32%
//   MOVIE    117             3%   <- TVDB is a *TV* database
//   OVA      107             1%
//
// An earlier note here claimed ~55% for a season two months out. That was never
// measured and is wrong: even the currently-airing season is 81%. What is true
// is that non-TV coverage is poor and largely irreplaceable — 387 corpus entries
// have no id in any scheme, and matching cannot invent one. See `animeMatch.ts`.
// ---------------------------------------------------------------------------

const SOURCE_URL =
  'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json';
const MAP_KEY = 'anilistTvdbMap';
const TMDB_MAP_KEY = 'anilistTmdbMap';
const FETCHED_AT_KEY = 'anilistTvdbMapAt';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // weekly is plenty; entries only get added
const FETCH_TIMEOUT_MS = 60_000;

/** anilistId → tvdbId. Empty until loaded; never null, so callers need no guard. */
let _map: Record<string, string> = {};
/**
 * anilistId → `"tv:12345"` / `"movie:678"`.
 *
 * The kind is stored with the id because **TMDB namespaces them separately** —
 * movie 550 and TV 550 are unrelated works. The series library's `Tmdb` ids are
 * TV ids, so comparing a film's id against them could match by coincidence.
 * Keeping the kind makes that impossible rather than unlikely.
 */
let _tmdb: Record<string, string> = {};
let _loaded = false;
let _inFlight: Promise<void> | null = null;
/** Last upstream ETag, so the weekly check can be a 304 instead of 7.5 MB. */
let _etag: string | null = null;

export interface TmdbRef {
  id: string;
  kind: 'tv' | 'movie';
}

/**
 * Pull the list from GitHub and reduce it to id pairs.
 *
 * NOTE the field is `tvdb_id`, not `thetvdb_id` — the file carries both shapes
 * across its history and reading the wrong one silently yields an empty map.
 *
 * And `themoviedb_id` is **an object**, `{"tv": N}` or `{"movie": N}` (7084 and
 * 1356 rows respectively) — never a bare number. Parsing it as a scalar
 * stringifies to `"[object Object]"` and yields zero matches while looking like
 * it worked; that cost two wrong measurements before it was spotted.
 */
/** Sentinel: upstream says our copy is current, so there is nothing to parse. */
const UNCHANGED = Symbol('unchanged');

interface Pairs {
  tvdb: Record<string, string>;
  tmdb: Record<string, string>;
}

async function fetchPairs(etag?: string | null): Promise<Pairs | typeof UNCHANGED> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  const started = Date.now();
  try {
    // Conditional request: this file is 7.5 MB and changes only when entries are
    // added, so most weekly checks should cost a 304 and a few hundred bytes.
    const res = await fetch(SOURCE_URL, {
      signal: ac.signal,
      headers: etag ? { 'If-None-Match': etag } : {},
    });
    if (res.status === 304) {
      console.log(`[anime-ids] map unchanged upstream (304 in ${Date.now() - started}ms)`);
      return UNCHANGED;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    _etag = res.headers.get('etag');
    const rows = (await res.json()) as any[];
    console.log(`[anime-ids] map downloaded in ${Date.now() - started}ms`);
    const tvdb: Record<string, string> = {};
    const tmdb: Record<string, string> = {};
    for (const r of rows) {
      const a = r?.anilist_id;
      if (a == null) continue;
      if (r?.tvdb_id != null) tvdb[String(a)] = String(r.tvdb_id);
      const m = r?.themoviedb_id;
      if (m && typeof m === 'object') {
        // Values are occasionally arrays; take the first, which is the
        // canonical entry in every row observed.
        const kind: 'tv' | 'movie' = 'movie' in m ? 'movie' : 'tv';
        const raw = (m as any)[kind];
        const id = Array.isArray(raw) ? raw[0] : raw;
        if (id != null) tmdb[String(a)] = `${kind}:${id}`;
      }
    }
    return { tvdb, tmdb };
  } finally {
    clearTimeout(timer);
  }
}

async function readStored(): Promise<{ map: Record<string, string>; tmdb: Record<string, string>; fetchedAt: number }> {
  const rows = await prisma.appConfig.findMany({
    where: { key: { in: [MAP_KEY, TMDB_MAP_KEY, FETCHED_AT_KEY] } },
  });
  const raw = rows.find((r) => r.key === MAP_KEY)?.value;
  const rawTmdb = rows.find((r) => r.key === TMDB_MAP_KEY)?.value;
  const at = Number(rows.find((r) => r.key === FETCHED_AT_KEY)?.value ?? 0);
  const parse = (s?: string) => {
    if (!s) return {};
    try {
      return JSON.parse(s) as Record<string, string>;
    } catch {
      return {};
    }
  };
  if (!raw) return { map: {}, tmdb: {}, fetchedAt: 0 };
  // The TMDB row is newer than the TVDB one, so an existing deployment has the
  // first and not the second. That is a normal state, not a reason to refetch:
  // it simply means no film resolves until the next weekly refresh.
  return { map: parse(raw), tmdb: parse(rawTmdb), fetchedAt: at };
}

/** Mark the stored copy as verified-current without rewriting 7,179 pairs. */
async function touchFetchedAt(): Promise<void> {
  const value = String(Date.now());
  await prisma.appConfig.upsert({
    where: { key: FETCHED_AT_KEY },
    update: { value },
    create: { key: FETCHED_AT_KEY, value },
  });
}

async function store(pairs: Pairs): Promise<void> {
  const value = JSON.stringify(pairs.tvdb);
  await prisma.appConfig.upsert({
    where: { key: MAP_KEY },
    update: { value },
    create: { key: MAP_KEY, value },
  });
  const tmdbValue = JSON.stringify(pairs.tmdb);
  await prisma.appConfig.upsert({
    where: { key: TMDB_MAP_KEY },
    update: { value: tmdbValue },
    create: { key: TMDB_MAP_KEY, value: tmdbValue },
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
      const { map, tmdb, fetchedAt } = await readStored();
      if (Object.keys(map).length) {
        _map = map;
        _tmdb = tmdb;
        _loaded = true;
      }
      const stale = Date.now() - fetchedAt > MAX_AGE_MS;
      // An existing deployment has the TVDB row but no TMDB row yet; fetch once
      // to fill it rather than waiting out the week with films unresolvable.
      const missingTmdb = Object.keys(map).length > 0 && !Object.keys(tmdb).length;
      if (force || stale || missingTmdb || !Object.keys(map).length) {
        const fresh = await fetchPairs(_etag);
        if (fresh !== UNCHANGED && Object.keys(fresh.tvdb).length) {
          _map = fresh.tvdb;
          _tmdb = fresh.tmdb;
          _loaded = true;
          await store(fresh);
          console.log(
            `[anime-ids] id map refreshed: ${Object.keys(fresh.tvdb).length} TVDB, ` +
              `${Object.keys(fresh.tmdb).length} TMDB pairs`
          );
        } else if (fresh === UNCHANGED) {
          // Nothing new upstream; keep what we have and reset the clock so we
          // don't re-ask on every request for the rest of the week.
          _loaded = true;
          await touchFetchedAt();
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

/**
 * The TMDB id for an AniList entry, with its namespace.
 *
 * Callers must compare `kind` before using `id` — see the note on `_tmdb`.
 * Against the series library only `tv` ids are meaningful; a `movie` id there
 * could only ever match by coincidence.
 */
export function tmdbRefForAnilist(anilistId: number | string): TmdbRef | null {
  const raw = _tmdb[String(anilistId)];
  if (!raw) return null;
  const i = raw.indexOf(':');
  if (i < 0) return null;
  const kind = raw.slice(0, i);
  if (kind !== 'tv' && kind !== 'movie') return null;
  return { id: raw.slice(i + 1), kind };
}

/**
 * Is the id map usable yet?
 *
 * Callers need this because a match made *without* the map is provisional: the
 * id tier is skipped, so a series that would have matched exactly may match by
 * title or not at all. Caching such a result would pin a degraded answer for up
 * to an hour, which is a worse bug than the blocking fetch it replaced.
 */
export function anilistTvdbMapReady(): boolean {
  return Object.keys(_map).length > 0;
}

/** For diagnostics / the admin page. */
export function anilistTvdbMapSize(): number {
  return Object.keys(_map).length;
}

/** Test seam: populate the maps without a 7.5 MB download. */
/** What a cross-walk resolves to: the same identity named in both id spaces. */
export interface CrosswalkResult {
  tvdbId: string | null;
  tmdbId: string | null;
  tmdbKind: 'tv' | 'movie' | null;
}

/**
 * Join tvdb↔tmdb THROUGH the anilist key.
 *
 * Jellyfin's remote search returns TMDB ids only on this deployment (measured:
 * every stored resolver candidate), while corrections sometimes arrive as
 * pasted TVDB ids — this and the library's own metadata are the two free
 * translations between the spaces. Several anilist rows can share one TVDB id
 * (seasons of one series), so the scan continues until a row actually carries
 * the missing sibling rather than trusting whichever row sorts first. Linear
 * over ~7k entries — admin-endpoint traffic only, never the viewer path.
 */
export function crosswalkIds(input: {
  tvdbId?: string | null;
  tmdbId?: string | null;
  tmdbKind?: 'tv' | 'movie' | null;
}): CrosswalkResult | null {
  const wantTvdb = input.tvdbId ? String(input.tvdbId) : null;
  const wantTmdb = input.tmdbId ? String(input.tmdbId) : null;

  if (wantTvdb) {
    let known = false;
    for (const [anilistId, tvdb] of Object.entries(_map)) {
      if (tvdb !== wantTvdb) continue;
      known = true;
      const ref = tmdbRefForAnilist(anilistId);
      if (ref) return { tvdbId: wantTvdb, tmdbId: ref.id, tmdbKind: ref.kind };
    }
    return known ? { tvdbId: wantTvdb, tmdbId: null, tmdbKind: null } : null;
  }

  if (wantTmdb) {
    let hit: CrosswalkResult | null = null;
    for (const anilistId of Object.keys(_tmdb)) {
      const ref = tmdbRefForAnilist(anilistId);
      if (!ref || ref.id !== wantTmdb) continue;
      // TMDB numbers films and shows independently — never cross namespaces.
      if (input.tmdbKind && ref.kind !== input.tmdbKind) continue;
      const tvdbId = _map[anilistId] ?? null;
      hit = { tvdbId, tmdbId: wantTmdb, tmdbKind: ref.kind };
      if (tvdbId) return hit;
    }
    return hit;
  }

  return null;
}

export function __setMapsForTest(
  tvdb: Record<string, string>,
  tmdb: Record<string, string>
): void {
  _map = tvdb;
  _tmdb = tmdb;
  _loaded = true;
}
