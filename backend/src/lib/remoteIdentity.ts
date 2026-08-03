import type { Api } from '@jellyfin/sdk';
import { getTvShowsApi } from '@jellyfin/sdk/lib/utils/api/tv-shows-api';
import { getItemLookupApi } from '@jellyfin/sdk/lib/utils/api/item-lookup-api';
import prisma from '../db';
import { normalizeTitle, MatchableSeries } from './animeMatch';
import { closestDatedEpisode, AIR_DATE_TOLERANCE_MS, anilistDateToMs } from './episodeMatch';
import {
  needsRemoteLookup,
  setIdentityOverride,
  identityReady,
} from './seriesIdentity';

// ---------------------------------------------------------------------------
// Creating the links nobody else has.
//
// The community map (Fribb) answers 94% of TV and **0%** of everything else in
// the gap. Measured over 8 seasons: of 292 SFW entries it has no id for, the
// upstream anime databases (manami/AniDB/MAL/Kitsu) know 284 of them — but not
// one carries a TVDB or TMDB id. The entries exist; the *link* to the databases
// Sonarr, Radarr and Jellyfin can act on has simply never been made.
//
// So we make it. Jellyfin is already configured to talk to TMDB for metadata,
// and exposes that as a remote search — no new API key, no new dependency.
// Measured fill: 130 of 292 (45%), and 54 of 74 unresolved films (73%).
//
// TWO RULES:
//
//   1. Never on the request path. This is a live third-party call per title, the
//      same mistake as the 7.5 MB map fetch that used to sit between a viewer
//      and the Watch button.
//   2. A guessed id is POSITIVE-ONLY. TMDB's search is fuzzy on its side and
//      reproduces our own worst failure independently — it answers "One Piece
//      Log: Fish-Man Island Saga" with *One Piece*. So `matchSeries` is told not
//      to let a `remote` id end a lookup: it may add a Watch button, never take
//      one away. Many of the entries this touches resolve by *title* today, and
//      an unverified guess must not delete a working match.
//
// Acceptance is decided by `verdictFor`, on air date rather than on title
// confidence. That is not a preference — measured against the real library,
// correct results land 0-3 days from the AniList premiere and wrong ones 329 to
// 11,083 days away, with nothing in between. Title similarity does not separate
// them: "Bananya Around the World" -> Bananya is right, and looks identical in
// shape to "ONE PIECE FAN LETTER" -> One Piece, which is wrong.
// ---------------------------------------------------------------------------

export interface RemoteCandidate {
  tvdbId: string | null;
  tmdbId: string | null;
  tmdbKind: 'tv' | 'movie' | null;
  matchedTitle: string;
  /** True when the returned title normalises equal to one we asked about. */
  exact: boolean;
  /** The result's own release year — the only verifiable signal for a film. */
  year: number | null;
}

export interface RemoteQuery {
  anilistId: number;
  titles: string[];
  /** AniList format — a hint for which search to try first, never a constraint. */
  format?: string | null;
  year?: number | null;
  /** AniList premiere as epoch ms — the signal the whole gate turns on. */
  airDateMs?: number | null;
}

/**
 * What to do with a candidate.
 *
 * `accept` goes live immediately (still marked unconfirmed in the UI, and still
 * positive-only). `queue` is stored for review but is equally usable. `reject`
 * throws the id away and records only that we looked.
 */
export type Verdict = 'accept' | 'queue' | 'reject';

/**
 * The acceptance ladder — pure, so it is unit-testable against the real pairs.
 *
 * Measured against the live library, `daysOff` separates right from wrong by
 * three orders of magnitude and nothing else does:
 *
 *   Thunderbolt Fantasy Sword Seekers 4 -> Thunderbolt Fantasy   S4E1     0
 *   Bananya Around the World            -> Bananya               S3E1     1
 *   Frieren ...no Mahou Part 3          -> Frieren               S2E1     3
 *   ONE PIECE FAN LETTER                -> One Piece             S21E194  329
 *   Star Wars: Visions Volume 3         -> Star Wars Rebels      S4E14    2795
 *   5-Oku-nen Button Part 2             -> Babylon 5             S5E22    9441
 *
 * Note the last two: those come from searching the *base* title, which is worth
 * +59 resolutions and also manufactures nonsense. That is exactly why a
 * base-title result may never be accepted on its title alone.
 */
export function verdictFor(input: {
  exact: boolean;
  /** Did we find this id in the library, so the air date could be checked? */
  inLibrary: boolean;
  /** Distance from the AniList premiere, when it was measurable. */
  deltaMs: number | null;
  /** Result's own release year vs the entry's — the only check available for a film. */
  yearDelta: number | null;
}): Verdict {
  // A: the title is the same work by any reading.
  if (input.exact) return 'accept';
  // B/C: we hold it, so the air date is decidable — and it decides.
  if (input.inLibrary && input.deltaMs != null) {
    return input.deltaMs <= AIR_DATE_TOLERANCE_MS ? 'accept' : 'reject';
  }
  // D: a film has no episodes to date; its release year is the nearest thing.
  if (input.yearDelta != null && input.yearDelta <= 1) return 'accept';
  // E: nothing verifiable. Keep it — positive-only means it can still only help
  // — but surface it for review.
  return 'queue';
}

/**
 * NOTE: there was an `isRelation` guard here, rejecting any result whose title
 * equalled a work AniList calls related (PARENT/PREQUEL/...). **It was wrong and
 * was removed**, and the reason is worth keeping.
 *
 * It was built from four eyeballed samples. Measured properly against the real
 * library, mapping a sequel to its *parent series* is CORRECT — TVDB and TMDB
 * both put seasons inside one series entry — and the air-date tier then picks
 * the episode. The guard rejected "Bananya Around the World" -> Bananya, which
 * lands on S3E1, one day from its premiere. The genuinely wrong cases it caught
 * (both One Piece) are caught anyway by air date, at 329 and 343 days.
 *
 * Relation type does not separate right from wrong here. Air date does, by three
 * orders of magnitude. Do not reintroduce a title/relation heuristic without
 * re-measuring.
 */

function idsFrom(providerIds: Record<string, string> | undefined | null, kind: 'tv' | 'movie') {
  const p = providerIds ?? {};
  const tvdb = p.Tvdb ?? p.tvdb ?? null;
  const tmdb = p.Tmdb ?? p.tmdb ?? null;
  return {
    tvdbId: tvdb == null ? null : String(tvdb),
    tmdbId: tmdb == null ? null : String(tmdb),
    tmdbKind: tmdb == null ? null : kind,
  };
}

async function searchOne(
  api: Api,
  kind: 'tv' | 'movie',
  name: string,
  year: number | null | undefined,
  wanted: string[]
): Promise<RemoteCandidate[]> {
  const lookup = getItemLookupApi(api);
  const searchInfo = { Name: name, ...(year ? { Year: year } : {}) };
  let results: any[] = [];
  try {
    const { data } =
      kind === 'movie'
        ? await lookup.getMovieRemoteSearchResults(
            { movieInfoRemoteSearchQuery: { SearchInfo: searchInfo, IncludeDisabledProviders: true } },
            { timeout: 30_000 }
          )
        : await lookup.getSeriesRemoteSearchResults(
            { seriesInfoRemoteSearchQuery: { SearchInfo: searchInfo, IncludeDisabledProviders: true } },
            { timeout: 30_000 }
          );
    results = data ?? [];
  } catch {
    return [];
  }

  const wantedNorms = wanted.map(normalizeTitle).filter(Boolean);
  const out: RemoteCandidate[] = [];
  // Only the first few: TMDB orders by relevance and the tail is noise. All of
  // them are kept rather than just the winner — a search can return twenty
  // ("Sylvanian Families"), and a reviewer who is going to look anyway should
  // see the alternatives instead of a yes/no on whichever came first.
  for (const r of results.slice(0, 5)) {
    const ids = idsFrom(r?.ProviderIds, kind);
    if (!ids.tvdbId && !ids.tmdbId) continue;
    const rawName = String(r?.Name ?? '');
    const got = normalizeTitle(rawName);
    out.push({
      ...ids,
      matchedTitle: rawName,
      exact: !!got && wantedNorms.includes(got),
      year: typeof r?.ProductionYear === 'number' ? r.ProductionYear : null,
    });
  }
  return out;
}

/**
 * Resolve one entry against Jellyfin's metadata providers.
 *
 * **Both search kinds are tried**, because AniList's `format` does not predict
 * how TMDB files a work: a SPECIAL may be a theatrical short, an OVA may be a
 * film, and a MOVIE may exist only inside a series entry. The format picks which
 * to ask *first*, nothing more — and the second call is skipped when the first
 * already returned an exact title match, so the common case stays one request.
 */
export interface RemoteResult {
  /** The candidate we would act on. */
  chosen: RemoteCandidate;
  /**
   * Everything the search returned, best-first, deduplicated by id.
   *
   * Kept so `/admin/matching` can offer a picker. A single result is the common
   * case (median 1) but a franchise name can return twenty, and those are
   * exactly the entries a human most needs to disambiguate.
   */
  candidates: RemoteCandidate[];
}

export async function resolveRemoteIdentity(
  api: Api,
  q: RemoteQuery
): Promise<RemoteResult | null> {
  const first: 'tv' | 'movie' = q.format === 'MOVIE' ? 'movie' : 'tv';
  const second: 'tv' | 'movie' = first === 'movie' ? 'tv' : 'movie';
  const titles = q.titles.filter(Boolean).slice(0, 3);
  if (!titles.length) return null;

  // Full titles first, then the stripped base. Measured: the base pass is worth
  // +59 of 292 — TMDB files "BanG Dream! It's MyGO!!!!!: Haru no Hidamari,
  // Mayoi Neko" under "BanG Dream! It's MyGO!!!!!" and returns nothing for the
  // full string. It is also how "5-Oku-nen Button Part 2" reaches *Babylon 5*,
  // which is why `verdictFor` never accepts a non-exact result on title alone.
  const bases = titles.map(baseTitle).filter((b) => b && !titles.includes(b));
  const passes = [titles, [...new Set(bases)]];

  const seen = new Set<string>();
  const all: RemoteCandidate[] = [];
  const add = (cs: RemoteCandidate[]) => {
    for (const c of cs) {
      const k = `${c.tmdbKind ?? ''}:${c.tmdbId ?? ''}:${c.tvdbId ?? ''}`;
      if (seen.has(k)) continue;
      seen.add(k);
      all.push(c);
    }
  };

  for (const names of passes) {
    for (const kind of [first, second] as const) {
      for (const t of names) {
        add(await searchOne(api, kind, t, q.year, titles));
        const exact = all.find((c) => c.exact);
        // An exact title is decisive, so stop paying for more searches — but
        // return everything gathered so far, so the picker still has options.
        if (exact) return { chosen: exact, candidates: all };
      }
    }
    if (all.length) break;
  }
  if (!all.length) return null;
  return { chosen: all[0], candidates: all };
}

/**
 * Drop a trailing subtitle or season marker.
 *
 * TMDB catalogues a sequel as a *season* of one series, so it holds "Punirunes",
 * not "Punirunes Puni 2". Searching the full AniList title returns zero results
 * for those; the base returns the parent, which the air-date tier then confirms
 * or rejects.
 */
export function baseTitle(t: string): string {
  return t
    .replace(/\s*[:\-–—]\s*.*$/, '')
    .replace(/\s+(season\s*\d+|\d+(st|nd|rd|th)\s+season|part\s*\d+|cour\s*\d+|\d+)$/i, '')
    .trim();
}

// ---------------------------------------------------------------------------
// The sweep.
//
// Runs on a timer, exactly like the Fribb refresh, for the same reason: an id is
// a permanent fact, so discovering one should not wait for someone to press a
// button. It reads entries from `SeasonCache` rather than asking AniList — the
// data is already on disk, and AniList's ~30/min limit is shared with every
// viewer.
// ---------------------------------------------------------------------------

/** Bounded per run so a first sweep can't sit on Jellyfin for an hour. */
const MAX_PER_RUN = 40;
/** Small gap between searches; each one is a live TMDB call made on our behalf. */
const PACE_MS = 150;

/**
 * How soon to re-ask about an entry we found nothing for.
 *
 * Tiered by how close the entry is to airing, because that is when its TMDB
 * entry actually appears: a show two months out often has no record at all and
 * gains one within days, while a 2024 title that is still missing has been
 * missing for a year. A flat fortnight was wrong in both directions — too slow
 * for the seasons people are looking at, and needless churn on old ones.
 */
const DAY = 24 * 60 * 60 * 1000;
function retryAfterFor(startYear: number | null | undefined): number {
  if (!startYear) return 14 * DAY;
  const thisYear = new Date().getFullYear();
  // Previous, current and next season all fall inside a ±1 year window.
  if (Math.abs(startYear - thisYear) <= 1) return 2 * DAY;
  return 30 * DAY;
}

let _running = false;

interface CachedShow {
  id: number;
  format?: string | null;
  isAdult?: boolean;
  title?: { english?: string | null; romaji?: string | null; native?: string | null };
  startDate?: { year?: number | null } | null;
  relations?: { edges?: { node?: { title?: Record<string, string | null> } }[] } | null;
}

/**
 * Try to give an id to every cached entry that hasn't got one.
 *
 * Never throws: this is background work, and a failure must leave matching
 * exactly as it was.
 */
export async function runRemoteIdentitySweep(
  api: Api | null,
  library: MatchableSeries[]
): Promise<void> {
  if (!api || _running) return;
  // Without the map loaded, "no id" means "we haven't read the map yet" rather
  // than "this entry is unmapped" — sweeping then would create rows for entries
  // Fribb already covers.
  if (!identityReady()) return;
  _running = true;
  const started = Date.now();
  let looked = 0;
  let accepted = 0;
  let queued = 0;
  let rejected = 0;
  try {
    const rows = await prisma.seasonCache.findMany();
    const seen = new Set<number>();
    const todo: RemoteQuery[] = [];
    for (const row of rows) {
      let shows: CachedShow[];
      try {
        shows = JSON.parse(row.data);
      } catch {
        continue;
      }
      if (!Array.isArray(shows)) continue;
      for (const s of shows) {
        if (!s?.id || seen.has(s.id)) continue;
        seen.add(s.id);
        // Adult titles are not indexed by TVDB or TMDB at all — 92 of 106 aren't
        // even in the upstream anime databases — so asking about them is pure
        // waste. They are also not what this app is for.
        if (s.isAdult) continue;
        // NOT "has any identity row" — that retired an entry permanently the
        // first time a search came back empty, and made the retry schedule
        // below unreachable. See needsRemoteLookup.
        if (!needsRemoteLookup(s.id)) continue;
        // Native included: TMDB stores an `original_title`, and it is the one
        // form that doesn't depend on which English localisation a cataloguer
        // chose.
        const titles = [s.title?.english, s.title?.romaji, s.title?.native]
          .filter(Boolean) as string[];
        if (!titles.length) continue;
        todo.push({
          anilistId: s.id,
          titles,
          format: s.format ?? null,
          year: s.startDate?.year ?? null,
          airDateMs: anilistDateToMs(s.startDate ?? null),
        });
      }
    }

    // Skip anything we asked about recently and got nothing for — but on a
    // schedule that reflects how fast the answer can change (see retryAfterFor).
    const asked = await prisma.seriesIdentity.findMany({
      where: { source: 'remote' },
      select: { anilistId: true, updatedAt: true },
    });
    const askedAt = new Map(asked.map((r) => [r.anilistId, r.updatedAt.getTime()]));
    const skip = new Set(
      todo
        .filter((q) => {
          const at = askedAt.get(q.anilistId);
          return at != null && Date.now() - at < retryAfterFor(q.year);
        })
        .map((q) => q.anilistId)
    );
    const batch = todo.filter((t) => !skip.has(t.anilistId)).slice(0, MAX_PER_RUN);
    if (!batch.length) return;

    const byTvdb = new Map<string, MatchableSeries>();
    const byTmdb = new Map<string, MatchableSeries>();
    for (const s of library) {
      if (s.tvdbId) byTvdb.set(String(s.tvdbId), s);
      if (s.tmdbId) byTmdb.set(String(s.tmdbId), s);
    }

    for (const q of batch) {
      looked++;
      const found = await resolveRemoteIdentity(api, q);
      const hit = found?.chosen ?? null;
      if (found && hit) {
        // Decide on air date, not on how the titles read. Only possible when we
        // actually hold the candidate — otherwise there are no episodes to date.
        const inLib =
          (hit.tvdbId ? byTvdb.get(hit.tvdbId) : undefined) ??
          (hit.tmdbId && hit.tmdbKind === 'tv' ? byTmdb.get(hit.tmdbId) : undefined);
        let deltaMs: number | null = null;
        if (inLib && q.airDateMs != null) {
          try {
            const { data } = await getTvShowsApi(api).getEpisodes(
              { seriesId: inLib.id, enableImages: false },
              { timeout: 30_000 }
            );
            deltaMs = closestDatedEpisode(data.Items ?? [], q.airDateMs)?.deltaMs ?? null;
          } catch {
            deltaMs = null;
          }
        }
        const yearDelta =
          hit.year != null && q.year != null ? Math.abs(hit.year - q.year) : null;
        const verdict = verdictFor({ exact: hit.exact, inLibrary: !!inLib, deltaMs, yearDelta });
        if (verdict === 'reject') {
          // We hold this series and its episodes are nowhere near the entry's
          // premiere, so the candidate is a different work. Record only that we
          // looked, so the next sweep spends its budget elsewhere.
          rejected++;
          await setIdentityOverride({
            anilistId: q.anilistId, tvdbId: null, tmdbId: null, tmdbKind: null,
            pending: true, source: 'remote', matchedTitle: null,
            note: `remote: rejected ${hit.matchedTitle} (${Math.round((deltaMs ?? 0) / 86400000)}d off)`,
          });
          await new Promise((r) => setTimeout(r, PACE_MS));
          continue;
        }
        await setIdentityOverride({
          anilistId: q.anilistId,
          tvdbId: hit.tvdbId,
          tmdbId: hit.tmdbId,
          tmdbKind: hit.tmdbKind,
          // `pending` no longer withholds the id — positive-only does the
          // protecting. It only marks what still wants a human eye.
          pending: verdict === 'queue',
          matchedTitle: hit.matchedTitle,
          candidates: found.candidates,
          source: 'remote',
          // Say which rung of the ladder accepted it. `?? 0` here would print
          // "air date 0d" for a film that never had an air-date check at all —
          // a note that reads as strong evidence for a decision made on
          // something weaker.
          note: verdict !== 'accept'
            ? 'remote: unverified'
            : hit.exact
              ? 'remote: exact title'
              : deltaMs != null
                ? `remote: air date ${Math.round(deltaMs / 86400000)}d`
                : `remote: release year ±${yearDelta}`,
        });
        verdict === 'accept' ? accepted++ : queued++;
        await new Promise((r) => setTimeout(r, PACE_MS));
        continue;
      }
      if (!hit) {
        // Record the miss so the next sweep spends its budget elsewhere.
        await setIdentityOverride({
          anilistId: q.anilistId, tvdbId: null, tmdbId: null, tmdbKind: null,
          pending: true, source: 'remote', note: 'remote: no match', matchedTitle: null,
        });
      }
      await new Promise((r) => setTimeout(r, PACE_MS));
    }
    console.log(
      `[identity] remote sweep: ${looked} looked up, ${accepted} accepted, ` +
        `${queued} queued, ${rejected} rejected on air date, ` +
        `${todo.length - batch.length} left for next run ` +
        `(${((Date.now() - started) / 1000).toFixed(1)}s)`
    );
  } catch (err: any) {
    console.warn('[identity] remote sweep failed:', err?.message ?? err);
  } finally {
    _running = false;
  }
}
