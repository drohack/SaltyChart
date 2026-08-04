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
  identityOverrideCount,
  rawIdentityOverride,
  mergeIdentityPatch,
} from './seriesIdentity';
import { anilistTvdbMapSize, crosswalkIds } from './anilistTvdbMap';
import {
  skyhookSearch,
  skyhookEpisodes,
  titleRelated,
  seasonPremiereDelta,
  hasUndatedFutureSeason,
} from './skyhookIdentity';

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
  /** TMDB poster URL when the provider sent one — display only, never matched on. */
  image: string | null;
  /**
   * The result's premiere at DAY precision (ISO `yyyy-mm-dd`). Jellyfin's
   * remote search always carried this; for months only the year was kept, and
   * the difference is the whole Echo bug: an exact-title film 1,012 days from
   * the entry's premiere was accepted while the day that refuted it sat unread
   * in the response. Absent (not null — absent) on rows stored before this
   * field existed, which is what the sweep's re-grade pass keys on.
   */
  premiereDate: string | null;
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
  /**
   * What TMDB says this candidate is. Required, not optional: the year rung is
   * only meaningful for films, and a forgotten field must be a compile error
   * rather than a silently widened acceptance.
   */
  kind: 'tv' | 'movie' | null;
  /**
   * |candidate PremiereDate − entry premiere|, when both are known. Required
   * for the same reason as `kind`. Measured over all 270 unconfirmed remote
   * rows: correct picks land ≤31d, wrong ones 62–21,929d — the same
   * three-orders-of-magnitude gap as the library air-date tier, available
   * without holding the show.
   */
  premiereDeltaMs: number | null;
  /**
   * |nearest TVDB SEASON premiere − entry premiere| for the candidate, from
   * skyhook's schedule (seasonPremiereDelta) — why it outranks the
   * held-library check is at rung B0 below.
   */
  tvdbSeasonDeltaMs: number | null;
  /**
   * The Frieren-S3 shape — see hasUndatedFutureSeason in skyhookIdentity.
   * A held-library rejection is premature while this is true.
   */
  tvdbHasUndatedFutureSeason: boolean;
}): { verdict: Verdict; rung: string | null } {
  // The rung rides along so the stored note can never drift from the ladder —
  // the note used to be re-derived at the write site, which would misreport
  // every fall-through this ladder added.
  const days = (ms: number) => Math.round(ms / 86400000);
  const p = input.premiereDeltaMs;
  // A: an exact title the premiere date VOUCHES for — verified, and named so.
  if (input.exact && p != null && p <= AIR_DATE_TOLERANCE_MS) {
    return { verdict: 'accept', rung: `premiere date ${days(p)}d` };
  }
  // A2: an exact title with no date on either side — today's rung A, unchanged.
  // An exact title the date REFUTES falls through: "Echo" (2023) at 1,012d was
  // accepted on text alone, and "cocoon" at 523d shows why the fall-through
  // ends in queue rather than reject — that one is the correct film, TMDB just
  // dates the theatrical release where AniList dates the broadcast.
  if (input.exact && p == null) return { verdict: 'accept', rung: 'exact title' };
  // B0: TVDB's schedule has a season premiering on the entry's date. Checked
  // BEFORE the held-library rung on purpose — for a season nobody has grabbed
  // yet, held episodes are stale by construction and would reject the show's
  // own parent (Ranma S3, Punirunes 2/3, Chibi Godzilla S3, all measured).
  if (input.tvdbSeasonDeltaMs != null && input.tvdbSeasonDeltaMs <= AIR_DATE_TOLERANCE_MS) {
    return { verdict: 'accept', rung: `tvdb season premiere ${days(input.tvdbSeasonDeltaMs)}d` };
  }
  // B/C: we hold it, so the entry's own episode is datable — and it decides.
  // Above the premiere rungs on purpose: a held sequel's SERIES premiere is
  // years off (Bananya), but its episode lands within a day. The one soften:
  // an undated future season (hasUndatedFutureSeason in skyhookIdentity)
  // queues for a human instead of rejecting (Frieren S3 at 553d) — One Piece
  // Fan Letter (329d) and Babylon 5 (9,441d) carry no such season and still
  // reject.
  if (input.inLibrary && input.deltaMs != null) {
    if (input.deltaMs <= AIR_DATE_TOLERANCE_MS) {
      return { verdict: 'accept', rung: `air date ${days(input.deltaMs)}d` };
    }
    return input.tvdbHasUndatedFutureSeason
      ? { verdict: 'queue', rung: null }
      : { verdict: 'reject', rung: null };
  }
  // D0/D1: the premiere date decides for anything we don't hold. Within
  // tolerance it accepts candidates title text never could — 14 of the 105
  // queued rows are the same work under a localized English title, 0d off.
  // Beyond it, queue: it also blocks the year rung below, whose ±1 window
  // admits up to ~730 days the day already refuted.
  if (p != null) {
    if (p <= AIR_DATE_TOLERANCE_MS) return { verdict: 'accept', rung: `premiere date ${days(p)}d` };
    return { verdict: 'queue', rung: null };
  }
  // D: a film has no episodes to date; its release year is the nearest thing.
  // Films ONLY — for a series the year is nearly free (TMDB's Year-filtered
  // search hands back same-year works), so it is no evidence at all there.
  // Reachable only when undated now.
  if (input.kind === 'movie' && input.yearDelta != null && input.yearDelta <= 1) {
    return { verdict: 'accept', rung: `release year ±${input.yearDelta}` };
  }
  // E: nothing verifiable. Keep it — positive-only means it can still only help
  // — but surface it for review.
  return { verdict: 'queue', rung: null };
}

/**
 * NOTE: there was an `isRelation` guard here, rejecting any result whose title
 * equalled a work AniList calls related (PARENT/PREQUEL/...). **It was wrong
 * and was removed.** It was built from four eyeballed samples; measured
 * properly, mapping a sequel to its *parent series* is CORRECT and the guard
 * rejected right answers while air date already caught the wrong ones — see
 * the ladder table above.
 *
 * Relation type does not separate right from wrong here. Air date does, by three
 * orders of magnitude. Do not reintroduce a title/relation heuristic without
 * re-measuring.
 */

/** ProductionYear when present; PremiereDate is the fallback that fills the rest. */
function yearOf(r: any): number | null {
  if (typeof r?.ProductionYear === 'number') return r.ProductionYear;
  const t = r?.PremiereDate ? Date.parse(r.PremiereDate) : NaN;
  return Number.isNaN(t) ? null : new Date(t).getUTCFullYear();
}

/**
 * The premiere at day precision. The date part is taken verbatim — Jellyfin
 * renders TMDB's release day as local-midnight-in-UTC (`2025-04-29T05:00:00Z`),
 * so parsing the timestamp and flooring it in the wrong zone can shift a day.
 */
export function premiereOf(r: any): string | null {
  const p = r?.PremiereDate;
  if (typeof p !== 'string') return null;
  return /^\d{4}-\d{2}-\d{2}/.test(p) ? p.slice(0, 10) : null;
}

/** |candidate premiere − entry premiere| in ms; null whenever either side is unknown. */
export function premiereDelta(premiereDate: string | null | undefined, airDateMs: number | null | undefined): number | null {
  if (!premiereDate || airDateMs == null) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(premiereDate);
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  return Number.isFinite(ms) ? Math.abs(ms - airDateMs) : null;
}

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
      year: yearOf(r),
      image: r?.ImageUrl ?? null,
      premiereDate: premiereOf(r),
    });
  }
  return out;
}

/**
 * Both search kinds on one name, merged and deduped — the admin lookup's name
 * mode. Series first for the same reason the sweep asks tv first: most of what
 * this app shows is television. Sequential on purpose (provider pacing).
 */
export async function searchBothKinds(
  api: Api,
  name: string,
  year?: number | null
): Promise<RemoteCandidate[]> {
  const tv = await searchOne(api, 'tv', name, year, [name]);
  const movie = await searchOne(api, 'movie', name, year, [name]);
  const seen = new Set<string>();
  const out: RemoteCandidate[] = [];
  for (const c of [...tv, ...movie]) {
    const key = c.tmdbId ? `${c.tmdbKind}:${c.tmdbId}` : `tvdb:${c.tvdbId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out.slice(0, 8);
}

/**
 * Name a provider id, the way Jellyfin's own Identify dialog does: a remote
 * search whose SearchInfo carries ProviderIds instead of a name. Degrades to
 * null on anything — a pasted id we can't name is still usable, just unnamed.
 * The result must echo the asked-for id back, or it's the provider free-
 * associating on an empty query and must not be trusted.
 */
export async function lookupByProviderId(
  api: Api,
  tmdbId: string,
  kind?: 'tv' | 'movie' | null
): Promise<RemoteCandidate | null> {
  const lookup = getItemLookupApi(api);
  const kinds: Array<'tv' | 'movie'> = kind ? [kind] : ['tv', 'movie'];
  for (const k of kinds) {
    try {
      const searchInfo = { ProviderIds: { Tmdb: String(tmdbId) } };
      const { data } =
        k === 'movie'
          ? await lookup.getMovieRemoteSearchResults(
              { movieInfoRemoteSearchQuery: { SearchInfo: searchInfo, IncludeDisabledProviders: true } },
              { timeout: 15_000 }
            )
          : await lookup.getSeriesRemoteSearchResults(
              { seriesInfoRemoteSearchQuery: { SearchInfo: searchInfo, IncludeDisabledProviders: true } },
              { timeout: 15_000 }
            );
      const r = (data ?? [])[0];
      if (!r) continue;
      const ids = idsFrom(r?.ProviderIds as Record<string, string> | null | undefined, k);
      if (ids.tmdbId !== String(tmdbId)) continue;
      return {
        ...ids,
        matchedTitle: String(r?.Name ?? ''),
        exact: false,
        year: yearOf(r),
        image: r?.ImageUrl ?? null,
        premiereDate: premiereOf(r),
      };
    } catch {
      /* degrade — the id stays usable, just unnamed */
    }
  }
  return null;
}

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
  /**
   * TVDB schedule evidence per tvdbId, gathered while searching so the sweep
   * doesn't refetch it to run the ladder.
   */
  tvdbEvidence?: Map<string, TvdbEvidence>;
}

export interface TvdbEvidence {
  seasonDeltaMs: number | null;
  undatedFutureSeason: boolean;
}

/**
 * TVDB-native candidates for a series entry, via skyhook — with schedule
 * evidence for the top matches. Series-first on purpose: TVDB ids are what
 * Sonarr acts on (the measurements are in skyhookIdentity.ts's header).
 * Bounded per row: one search per title variant, episodes for the top two
 * related candidates only.
 */
async function searchSkyhookCandidates(
  q: RemoteQuery
): Promise<{ cands: RemoteCandidate[]; evidence: Map<string, TvdbEvidence> }> {
  const titles = q.titles.filter(Boolean).slice(0, 3);
  const bases = [...new Set(titles.flatMap(baseTitles))].filter((b) => !titles.includes(b));
  const searched = [...titles, ...new Set(bases)];
  const wantedNorms = titles.map(normalizeTitle).filter(Boolean);
  const related: { tvdbId: string; title: string; firstAired: string | null }[] = [];
  const seen = new Set<string>();
  for (const term of [...new Set(searched)]) {
    for (const s of await skyhookSearch(term)) {
      if (seen.has(s.tvdbId)) continue;
      seen.add(s.tvdbId);
      // Only candidates the title vouches for may be date-checked at all —
      // see titleRelated for the two measured failure modes this blocks.
      if (!titleRelated(s.title, searched)) continue;
      related.push(s);
    }
    if (related.length >= 4) break;
  }
  const evidence = new Map<string, TvdbEvidence>();
  const cands: RemoteCandidate[] = [];
  for (const [i, s] of related.slice(0, 4).entries()) {
    if (i < 2) {
      const eps = await skyhookEpisodes(s.tvdbId);
      if (eps.length) {
        evidence.set(s.tvdbId, {
          seasonDeltaMs: seasonPremiereDelta(eps, q.airDateMs ?? null),
          undatedFutureSeason: hasUndatedFutureSeason(eps),
        });
      }
    }
    const got = normalizeTitle(s.title);
    cands.push({
      tvdbId: s.tvdbId,
      tmdbId: null,
      tmdbKind: null,
      matchedTitle: s.title,
      exact: !!got && wantedNorms.includes(got),
      year: s.firstAired ? Number(s.firstAired.slice(0, 4)) : null,
      image: null,
      premiereDate: s.firstAired,
    });
  }
  // A candidate whose season premiere lands within tolerance is the strongest
  // evidence in the list — front it so the fallback pick takes it (why
  // pickCandidate's ranks would miss it: see `settled` in resolveRemoteIdentity).
  const within = (c: RemoteCandidate) => {
    const ev = evidence.get(c.tvdbId ?? '');
    return ev?.seasonDeltaMs != null && ev.seasonDeltaMs <= AIR_DATE_TOLERANCE_MS ? 0 : 1;
  };
  cands.sort((a, b) => within(a) - within(b));
  return { cands, evidence };
}

/**
 * Resolve one entry against the remote metadata sources.
 *
 * Series go to skyhook/TVDB first (see searchSkyhookCandidates) — 1-3 searches
 * whose evidence can settle the entry outright. Only then does the
 * Jellyfin/TMDB fallback run, where **both search kinds are tried**, because
 * AniList's `format` does not predict how TMDB files a work: a SPECIAL may be
 * a theatrical short, an OVA may be a film, and a MOVIE may exist only inside
 * a series entry. The format picks which to ask *first*, nothing more — and
 * within that fallback the search stops early on an exact title match the
 * premiere date doesn't refute.
 */
export async function resolveRemoteIdentity(
  api: Api,
  q: RemoteQuery
): Promise<RemoteResult | null> {
  const first: 'tv' | 'movie' = q.format === 'MOVIE' ? 'movie' : 'tv';
  const second: 'tv' | 'movie' = first === 'movie' ? 'tv' : 'movie';
  const titles = q.titles.filter(Boolean).slice(0, 3);
  if (!titles.length) return null;

  // Full titles first, then the stripped variants (least-destructive first —
  // see baseTitles). Measured: the base pass is worth +59 of 292 — TMDB files
  // "BanG Dream! It's MyGO!!!!!: Haru no Hidamari, Mayoi Neko" under
  // "BanG Dream! It's MyGO!!!!!" and returns nothing for the full string. The
  // old greedy strip is also how "5-Oku-nen Button Part 2" reached *Babylon 5*
  // (it collapsed to "5"); that pathway is closed at the source now, but the
  // rule it taught stands: `verdictFor` never accepts a non-exact result on
  // title alone, because a search TERM this speculative earns no trust.
  const bases = [...new Set(titles.flatMap(baseTitles))].filter((b) => !titles.includes(b));
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

  // Series go to TVDB first: the id arrives natively instead of hoping a
  // cross-walk fills it, and skyhook's schedule can verify a season we don't
  // hold. When its evidence already settles the entry, the TMDB pass is
  // skipped entirely; otherwise both candidate lists merge for the picker.
  let tvdbEvidence: Map<string, TvdbEvidence> | undefined;
  if (q.format !== 'MOVIE') {
    const sky = await searchSkyhookCandidates(q);
    tvdbEvidence = sky.evidence;
    add(sky.cands);
    const settled = sky.cands.find((c) => {
      const ev = sky.evidence.get(c.tvdbId ?? '');
      if (ev?.seasonDeltaMs != null && ev.seasonDeltaMs <= AIR_DATE_TOLERANCE_MS) return true;
      const d = premiereDelta(c.premiereDate, q.airDateMs ?? null);
      return c.exact && d != null && d <= AIR_DATE_TOLERANCE_MS;
    });
    if (settled) {
      // `settled` itself, not pickCandidate: a sequel's verified parent is
      // never "exact" and its firstAired is years off, so no dated/exact rank
      // would choose it over other noise.
      return { chosen: settled, candidates: all, tvdbEvidence };
    }
  }

  for (const names of passes) {
    for (const kind of [first, second] as const) {
      for (const t of names) {
        add(await searchOne(api, kind, t, q.year, titles));
        // An exact title is decisive, so stop paying for more searches — but
        // return everything gathered so far, so the picker still has options.
        // An exact the premiere date REFUTES doesn't stop the search: it is
        // exactly the case where a later variant may surface the right work.
        const exact = all.find((c) => {
          if (!c.exact) return false;
          const d = premiereDelta(c.premiereDate, q.airDateMs ?? null);
          return d == null || d <= AIR_DATE_TOLERANCE_MS;
        });
        if (exact) return { chosen: pickCandidate(all, q.airDateMs ?? null)!, candidates: all, tvdbEvidence };
      }
    }
    if (all.length) break;
  }
  if (!all.length) return null;
  return { chosen: pickCandidate(all, q.airDateMs ?? null)!, candidates: all, tvdbEvidence };
}

/**
 * Which candidate to act on. Pure, because the ranking is where the Echo bug
 * lived: the old pick took the FIRST exact title in TMDB relevance order, so a
 * popular 2023 "Echo" beat the entry's own 2026 siblings while the dates
 * proving it wrong sat in the same list.
 *
 * Ranking: dated-within-tolerance exact (closest first — the DIVE IN! pair,
 * 16d over 167d) → dated-within-tolerance anything (closest first — "Beyond
 * Twilight" at 0d over a same-named 2007 work) → undated exact, tie-broken by
 * year distance when both sides know one → first candidate, exactly as before,
 * which the ladder then queues if a date refuted it.
 */
export function pickCandidate(all: RemoteCandidate[], airDateMs: number | null): RemoteCandidate | null {
  if (!all.length) return null;
  const delta = (c: RemoteCandidate) => premiereDelta(c.premiereDate, airDateMs);
  const within = (c: RemoteCandidate) => {
    const d = delta(c);
    return d != null && d <= AIR_DATE_TOLERANCE_MS;
  };
  const byDelta = (a: RemoteCandidate, b: RemoteCandidate) => delta(a)! - delta(b)!;
  const datedExact = all.filter((c) => c.exact && within(c)).sort(byDelta);
  if (datedExact.length) return datedExact[0];
  const datedAny = all.filter(within).sort(byDelta);
  if (datedAny.length) return datedAny[0];
  const undatedExact = all.filter((c) => c.exact && delta(c) == null);
  if (undatedExact.length) {
    const entryYear = airDateMs != null ? new Date(airDateMs).getUTCFullYear() : null;
    if (entryYear != null) {
      // Stable sort: candidates without a year keep provider order at the end.
      undatedExact.sort((a, b) => {
        const da = a.year != null ? Math.abs(a.year - entryYear) : Infinity;
        const db = b.year != null ? Math.abs(b.year - entryYear) : Infinity;
        return da - db;
      });
    }
    return undatedExact[0];
  }
  // Nothing a date vouches for: keep the exact title as the stored best-guess
  // (the ladder queues it anyway) rather than whatever TMDB ranked first —
  // the Echo re-grade stored "Echo Boomers" over the exact-titled "Echo".
  return all.find((c) => c.exact) ?? all[0];
}

/**
 * Fallback search terms for a title TMDB/TVDB may file differently, ordered
 * least-destructive first.
 *
 *   1. season markers stripped, subtitle KEPT — iteratively, because they
 *      stack ("Season 2 Part 2");
 *   2. the subtitle stripped from that.
 *
 * The order is the fix for a real false positive: the old single-form version
 * stripped at the first separator BEFORE looking at markers, so
 * "Mission: Yozakura Family Season 2 Part 2" collapsed straight to "Mission" —
 * which TMDB answered with *Mission: Impossible* — while the form that
 * actually resolves, "Mission: Yozakura Family", was never generated at all.
 *
 * Separators are deliberately narrow: a colon only counts with a space after
 * it ("Re:Zero kara …" must not collapse to "Re" — that search returned
 * "RE: European Stories"), and a dash only with whitespace before it
 * ("Ouji-sama", "U-17" and "5-Oku-nen" are words, not subtitles; the last of
 * those collapsing to "5" is the entire Babylon 5 story).
 *
 * Marker stripping keeps its measured behaviour: "Punirunes Puni 2" →
 * "Punirunes Puni", not "Punirunes" — the probe that first demonstrated the
 * base pass typed the shorter form by hand, and the pinned test exists so the
 * anecdote can't replace the behaviour.
 *
 * Returns only VARIANTS — a title with nothing to strip yields [], so callers
 * can tell there is no second pass worth paying for.
 */
const SEASON_MARKER =
  /\s+(season\s*\d+|\d+(st|nd|rd|th)\s+season|part\s*\d+|cour\s*\d+|\d+)$/i;
const SUBTITLE_SEPARATOR = /(:\s|\s+[-–—]).*$/;

export function baseTitles(t: string): string[] {
  const out: string[] = [];
  let m = t;
  while (SEASON_MARKER.test(m)) m = m.replace(SEASON_MARKER, '');
  m = m.trim();
  if (m && m !== t) out.push(m);
  const s = m.replace(SUBTITLE_SEPARATOR, '').trim();
  if (s && s !== m && s !== t) out.push(s);
  return out;
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

/** A lookup term the way Sonarr reads one: a name, or a prefixed provider id. */
export type LookupTerm =
  | { kind: 'name'; name: string }
  | { kind: 'tvdb' | 'tmdb'; id: string };

export function parseLookupTerm(term: string): LookupTerm {
  // The prefix is REQUIRED for an id — bare digits are real titles (the anime
  // "86"). Case-insensitive with optional spaces, matching Sonarr's syntax.
  const m = /^\s*(tvdb|tmdb)\s*:\s*(\d+)\s*$/i.exec(term);
  if (m) return { kind: m[1].toLowerCase() as 'tvdb' | 'tmdb', id: m[2] };
  return { kind: 'name', name: term.trim() };
}

/**
 * Complete an identity in both id spaces before it is stored.
 *
 * Jellyfin's remote search returns TMDB ids only on this server, and a
 * Sonarr/Radarr user expects series rows to carry TVDB ids — so a row must not
 * be written half-filled when anything already knows the pair. The library's
 * own metadata is the first translation (a held item carries both ids after
 * Jellyfin's deep fetch); the community map's cross-walk is the second.
 * Nothing is invented: unknown stays honestly null.
 */
export function completeIdentityIds(
  ids: { tvdbId: string | null; tmdbId: string | null; tmdbKind: 'tv' | 'movie' | null },
  library: { tvdbId?: string | null; tmdbId?: string | null } | null
): { tvdbId: string | null; tmdbId: string | null; tmdbKind: 'tv' | 'movie' | null } {
  let { tvdbId, tmdbId, tmdbKind } = ids;
  if (library) {
    tvdbId = tvdbId ?? library.tvdbId ?? null;
    if (!tmdbId && library.tmdbId) {
      tmdbId = String(library.tmdbId);
      tmdbKind = tmdbKind ?? 'tv';
    }
  }
  if (!tvdbId || !tmdbId) {
    const x = crosswalkIds({ tvdbId, tmdbId, tmdbKind });
    if (x) {
      tvdbId = tvdbId ?? x.tvdbId;
      tmdbId = tmdbId ?? x.tmdbId;
      tmdbKind = tmdbKind ?? x.tmdbKind;
    }
  }
  return { tvdbId, tmdbId, tmdbKind };
}

/** What the last sweep did, persisted so the admin page can show it ran. */
export interface SweepStatus {
  finishedAt: number;
  looked: number;
  accepted: number;
  queued: number;
  rejected: number;
  /** Entries still needing a lookup after this bounded run. */
  remaining: number;
  /** Override rows in memory, and the community map size, for scale. */
  overrides: number;
  mapSize: number;
}

export function parseSweepStatus(raw: string | null): SweepStatus | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    // A persisted cache row like every other AppConfig blob: corrupt means
    // "no status", never a crashed admin page.
    return v && typeof v === 'object' && typeof v.finishedAt === 'number'
      ? (v as SweepStatus)
      : null;
  } catch {
    return null;
  }
}

const SWEEP_STATUS_KEY = 'remoteSweepStatus';

/** The last run's summary, or null when no sweep has completed yet. */
export async function sweepStatus(): Promise<SweepStatus | null> {
  try {
    const row = await prisma.appConfig.findUnique({ where: { key: SWEEP_STATUS_KEY } });
    return parseSweepStatus(row?.value ?? null);
  } catch {
    return null;
  }
}

/** Recording the run must never fail the run. */
async function saveSweepStatus(s: SweepStatus): Promise<void> {
  try {
    const value = JSON.stringify(s);
    await prisma.appConfig.upsert({
      where: { key: SWEEP_STATUS_KEY },
      update: { value },
      create: { key: SWEEP_STATUS_KEY, value },
    });
  } catch (err: any) {
    console.warn('[identity] could not record the sweep status:', err?.message ?? err);
  }
}

/**
 * TVDB schedule evidence for the candidate being judged. The resolver's own
 * map answers when the candidate came from skyhook; otherwise it is fetched
 * lazily — and only for the reject-shaped held case, the one place the
 * schedule changes a verdict (see hasUndatedFutureSeason in skyhookIdentity).
 * Memoised inside skyhookEpisodes, degrades to nothing.
 */
async function tvdbEvidenceFor(
  fromResolver: Map<string, TvdbEvidence> | undefined,
  hit: RemoteCandidate,
  inLib: MatchableSeries | undefined | null,
  deltaMs: number | null,
  airDateMs: number | null
): Promise<TvdbEvidence> {
  const own = fromResolver?.get(hit.tvdbId ?? '');
  if (own) return own;
  const rejectShaped = inLib && deltaMs != null && deltaMs > AIR_DATE_TOLERANCE_MS;
  const tvdbId = hit.tvdbId ?? (inLib?.tvdbId ? String(inLib.tvdbId) : null);
  if (!rejectShaped || !tvdbId || airDateMs == null) {
    return { seasonDeltaMs: null, undatedFutureSeason: false };
  }
  const eps = await skyhookEpisodes(tvdbId);
  if (!eps.length) return { seasonDeltaMs: null, undatedFutureSeason: false };
  return {
    seasonDeltaMs: seasonPremiereDelta(eps, airDateMs),
    undatedFutureSeason: hasUndatedFutureSeason(eps),
  };
}

/** The entry's own episode distance, when we hold the candidate. */
async function episodeDeltaMs(
  api: Api,
  inLib: MatchableSeries | undefined | null,
  airDateMs: number | null | undefined
): Promise<number | null> {
  if (!inLib || airDateMs == null) return null;
  try {
    const { data } = await getTvShowsApi(api).getEpisodes(
      { seriesId: inLib.id, enableImages: false },
      { timeout: 30_000 }
    );
    return closestDatedEpisode(data.Items ?? [], airDateMs)?.deltaMs ?? null;
  } catch {
    return null;
  }
}

/**
 * Re-grade rows stored before candidates carried premiere dates.
 *
 * Every pre-feature accept was decided blind to the day-precision evidence the
 * search response already contained; this re-resolves those rows through the
 * current ladder — verifying the accepts the date vouches for, flagging the
 * ones it refutes (Echo), and promoting queued rows whose localized-title
 * match only a date could see. Selection key: a row is legacy exactly when its
 * stored candidates lack the `premiereDate` key, and every rewrite stamps the
 * key, so the pass is self-terminating rather than a permanent tax on the
 * provider.
 *
 * Conservative on purpose: confirmed, rejected and manual rows are never
 * touched, and a verdict of `reject` here writes `pending` (review) rather
 * than the reject-wipe — a stored accept must not be auto-deleted on evidence
 * a human hasn't seen.
 */
export async function regradeStoredRows(
  api: Api,
  library: MatchableSeries[],
  entryById: Map<number, RemoteQuery>,
  max: number
): Promise<{ regraded: number; promoted: number; flagged: number; stamped: number }> {
  const byTvdb = new Map<string, MatchableSeries>();
  const byTmdb = new Map<string, MatchableSeries>();
  for (const s of library) {
    if (s.tvdbId) byTvdb.set(String(s.tvdbId), s);
    if (s.tmdbId) byTmdb.set(String(s.tmdbId), s);
  }
  const stored = await prisma.seriesIdentity.findMany({
    where: { source: 'remote', confirmed: false, rejected: false, tmdbId: { not: null } },
    select: { anilistId: true },
    orderBy: { updatedAt: 'asc' },
  });
  let regraded = 0;
  let promoted = 0;
  let flagged = 0;
  let stamped = 0;
  for (const row of stored) {
    if (regraded >= max) break;
    const ex = rawIdentityOverride(row.anilistId);
    if (!ex || ex.source !== 'remote' || ex.confirmed || ex.rejected) continue;
    const cands = ex.candidates;
    if (!cands?.length || cands.every((c) => 'premiereDate' in c)) continue;
    const entry = entryById.get(row.anilistId);
    if (!entry) {
      // Aged out of the season cache — nothing to grade against. Stamp the key
      // so the row doesn't recycle through this pass forever, changing nothing.
      await setIdentityOverride(mergeIdentityPatch(ex, {
        anilistId: row.anilistId,
        tvdbId: ex.tvdbId, tmdbId: ex.tmdbId, tmdbKind: ex.tmdbKind,
        candidates: cands.map((c) => ({ ...c, premiereDate: c.premiereDate ?? null })),
        confirmed: ex.confirmed, rejected: ex.rejected, pending: ex.pending,
      }));
      stamped++;
      continue;
    }
    const found = await resolveRemoteIdentity(api, entry);
    regraded++;
    await new Promise((r) => setTimeout(r, PACE_MS));
    const hit = found?.chosen ?? null;
    if (!found || !hit) {
      // The search finds nothing today; keep what's stored, stamped.
      await setIdentityOverride(mergeIdentityPatch(ex, {
        anilistId: row.anilistId,
        tvdbId: ex.tvdbId, tmdbId: ex.tmdbId, tmdbKind: ex.tmdbKind,
        candidates: cands.map((c) => ({ ...c, premiereDate: c.premiereDate ?? null })),
        confirmed: ex.confirmed, rejected: ex.rejected, pending: ex.pending,
      }));
      stamped++;
      continue;
    }
    const inLib =
      (hit.tvdbId ? byTvdb.get(hit.tvdbId) : undefined) ??
      (hit.tmdbId && hit.tmdbKind === 'tv' ? byTmdb.get(hit.tmdbId) : undefined);
    const deltaMs = await episodeDeltaMs(api, inLib, entry.airDateMs);
    const tvdb = await tvdbEvidenceFor(found.tvdbEvidence, hit, inLib, deltaMs, entry.airDateMs ?? null);
    const yearDelta =
      hit.year != null && entry.year != null ? Math.abs(hit.year - entry.year) : null;
    const { verdict, rung } = verdictFor({
      exact: hit.exact, inLibrary: !!inLib, deltaMs, yearDelta, kind: hit.tmdbKind,
      premiereDeltaMs: premiereDelta(hit.premiereDate, entry.airDateMs ?? null),
      tvdbSeasonDeltaMs: tvdb.seasonDeltaMs,
      tvdbHasUndatedFutureSeason: tvdb.undatedFutureSeason,
    });
    const nowPending = verdict !== 'accept';
    if (ex.pending && !nowPending) promoted++;
    if (!ex.pending && nowPending) flagged++;
    const full = completeIdentityIds(hit, inLib ?? null);
    await setIdentityOverride(mergeIdentityPatch(ex, {
      anilistId: row.anilistId,
      tvdbId: full.tvdbId, tmdbId: full.tmdbId, tmdbKind: full.tmdbKind,
      matchedTitle: hit.matchedTitle,
      candidates: found.candidates,
      year: hit.year ?? ex.year,
      pending: nowPending,
      note: verdict === 'accept' && rung ? `remote: ${rung}` : 'remote: unverified',
      confirmed: ex.confirmed,
      rejected: ex.rejected,
    }));
  }
  return { regraded, promoted, flagged, stamped };
}

/**
 * Fill the TVDB half of rows the remote search could only give TMDB for —
 * the population a Sonarr request flow needs (the 125-row measurement lives
 * in skyhookIdentity.ts's header).
 *
 * Self-throttling without a marker: every attempt bumps `updatedAt`, and rows
 * younger than `retryAfterFor` are skipped — the same schedule the main sweep
 * uses, because the answer changes on the same clock (TVDB gains the record
 * as the show approaches airing).
 */
export async function fillTvdbGaps(
  entryById: Map<number, RemoteQuery>,
  max: number,
  /** Drain-only: ignore the retry schedule (a backlog drain IS the retry). */
  force = false
): Promise<{ tried: number; filled: number; verified: number }> {
  const gapRows = await prisma.seriesIdentity.findMany({
    where: { source: 'remote', confirmed: false, rejected: false, tmdbId: { not: null }, tvdbId: null },
    select: { anilistId: true, updatedAt: true },
    orderBy: { updatedAt: 'asc' },
  });
  let tried = 0;
  let filled = 0;
  let verified = 0;
  for (const row of gapRows) {
    if (tried >= max) break;
    const ex = rawIdentityOverride(row.anilistId);
    if (!ex || ex.source !== 'remote' || ex.confirmed || ex.rejected || ex.tvdbId || !ex.tmdbId) continue;
    const entry = entryById.get(row.anilistId);
    if (!entry) continue; // aged out of the season cache — nothing to search with
    if (!force && Date.now() - row.updatedAt.getTime() < retryAfterFor(entry.year)) continue;
    tried++;
    const sky = await searchSkyhookCandidates(entry);
    await new Promise((r) => setTimeout(r, PACE_MS));

    const within = (v: number | null) => v != null && v <= AIR_DATE_TOLERANCE_MS;
    const seasonHit = sky.cands.find((c) => within(sky.evidence.get(c.tvdbId ?? '')?.seasonDeltaMs ?? null));
    const firstHit = sky.cands.find((c) => within(premiereDelta(c.premiereDate, entry.airDateMs ?? null)));
    const exactHit = sky.cands.find((c) => c.exact);
    const hit = seasonHit ?? firstHit ?? exactHit ?? null;

    // Merged either way — the TVDB fill must not lose the stored picker list.
    const stored = ex.candidates ?? [];
    const have = new Set(stored.map((c) => c.tvdbId).filter(Boolean));
    const mergedCands = [...stored, ...sky.cands.filter((c) => c.tvdbId && !have.has(c.tvdbId))].slice(0, 8);

    if (!hit) {
      // Nothing trustworthy — rewrite unchanged (plus any new candidates) so
      // updatedAt bumps and the retry schedule owns the next attempt.
      await setIdentityOverride(mergeIdentityPatch(ex, {
        anilistId: row.anilistId,
        tvdbId: ex.tvdbId, tmdbId: ex.tmdbId, tmdbKind: ex.tmdbKind,
        candidates: mergedCands.length ? mergedCands : ex.candidates,
        confirmed: ex.confirmed, rejected: ex.rejected, pending: ex.pending,
      }));
      continue;
    }
    const dateProof = hit === seasonHit
      ? `tvdb season premiere ${Math.round((sky.evidence.get(hit.tvdbId ?? '')!.seasonDeltaMs ?? 0) / 86400000)}d`
      : hit === firstHit
        ? `premiere date ${Math.round((premiereDelta(hit.premiereDate, entry.airDateMs ?? null) ?? 0) / 86400000)}d`
        : null;
    await setIdentityOverride(mergeIdentityPatch(ex, {
      anilistId: row.anilistId,
      tvdbId: hit.tvdbId,
      tmdbId: ex.tmdbId,
      tmdbKind: ex.tmdbKind,
      candidates: mergedCands,
      // A date-verified TVDB id settles a row that was only queued; an
      // exact-title one fills the id but stays whatever it was.
      pending: dateProof ? false : ex.pending,
      note: dateProof && ex.pending ? `remote: ${dateProof}` : ex.note,
      confirmed: ex.confirmed, rejected: ex.rejected,
    }));
    filled++;
    if (dateProof) verified++;
  }
  return { tried, filled, verified };
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
    // Every entry, not just the ones needing a first lookup — the re-grade
    // pass below needs titles and premiere dates for rows already stored.
    const entryById = new Map<number, RemoteQuery>();
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
        // Native included: TMDB stores an `original_title`, and it is the one
        // form that doesn't depend on which English localisation a cataloguer
        // chose.
        const titles = [s.title?.english, s.title?.romaji, s.title?.native]
          .filter(Boolean) as string[];
        if (!titles.length) continue;
        const q: RemoteQuery = {
          anilistId: s.id,
          titles,
          format: s.format ?? null,
          year: s.startDate?.year ?? null,
          airDateMs: anilistDateToMs(s.startDate ?? null),
        };
        entryById.set(s.id, q);
        // NOT "has any identity row" — that retired an entry permanently the
        // first time a search came back empty, and made the retry schedule
        // below unreachable. See needsRemoteLookup.
        if (!needsRemoteLookup(s.id)) continue;
        todo.push(q);
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

    const byTvdb = new Map<string, MatchableSeries>();
    const byTmdb = new Map<string, MatchableSeries>();
    for (const s of library) {
      if (s.tvdbId) byTvdb.set(String(s.tvdbId), s);
      if (s.tmdbId) byTmdb.set(String(s.tmdbId), s);
    }

    // Backfill rows written before ids were completed at write time: a stored
    // remote row missing one id space gains its sibling once the library or
    // the community map has learned it — complete the ids (see
    // completeIdentityIds). Pure in-memory joins — cheap, idempotent, and the
    // merge preserves the row's provenance while the identity-change hook
    // busts any cached verdict.
    let backfilled = 0;
    const stored = await prisma.seriesIdentity.findMany({
      where: { source: 'remote' },
      select: { anilistId: true, tvdbId: true, tmdbId: true },
    });
    for (const row of stored) {
      if ((row.tvdbId && row.tmdbId) || (!row.tvdbId && !row.tmdbId)) continue;
      const ex = rawIdentityOverride(row.anilistId);
      if (!ex) continue;
      const inLib =
        (ex.tvdbId ? byTvdb.get(String(ex.tvdbId)) : undefined) ??
        (ex.tmdbId && ex.tmdbKind !== 'movie' ? byTmdb.get(String(ex.tmdbId)) : undefined);
      const full = completeIdentityIds(
        { tvdbId: ex.tvdbId, tmdbId: ex.tmdbId, tmdbKind: ex.tmdbKind },
        inLib ?? null
      );
      if (full.tvdbId === ex.tvdbId && full.tmdbId === ex.tmdbId) continue;
      await setIdentityOverride(mergeIdentityPatch(ex, {
        anilistId: row.anilistId,
        tvdbId: full.tvdbId,
        tmdbId: full.tmdbId,
        tmdbKind: full.tmdbKind,
        // Date it while we're here: the stored candidates and the held
        // library item are the only local sources.
        year: ex.year ?? (ex.candidates ?? []).find((c) => c.year != null)?.year
          ?? inLib?.year ?? null,
        confirmed: ex.confirmed,
        rejected: ex.rejected,
        pending: ex.pending,
      }));
      backfilled++;
    }
    if (backfilled) {
      console.log(`[identity] backfilled ${backfilled} half-filled row(s) with cross-walked ids`);
    }

    // Date legacy rows the local sources couldn't: one remote by-id lookup
    // each, capped per run — the backlog (271 undated rows when this shipped)
    // drains across a week of sweeps instead of hammering the provider. Rows
    // are taken oldest-updatedAt first and TOUCHED even when the provider has
    // no date, so the window rotates instead of retrying the same undatable
    // forty forever.
    let dated = 0;
    const undatedRows = await prisma.seriesIdentity.findMany({
      where: { source: 'remote', year: null, tmdbId: { not: null } },
      select: { anilistId: true },
      orderBy: { updatedAt: 'asc' },
      take: MAX_PER_RUN,
    });
    for (const row of undatedRows) {
      const ex = rawIdentityOverride(row.anilistId);
      if (!ex?.tmdbId || ex.year != null) continue;
      const named = await lookupByProviderId(api, ex.tmdbId, ex.tmdbKind);
      await setIdentityOverride(mergeIdentityPatch(ex, {
        anilistId: row.anilistId,
        tvdbId: ex.tvdbId,
        tmdbId: ex.tmdbId,
        tmdbKind: ex.tmdbKind,
        year: named?.year ?? null,
        confirmed: ex.confirmed,
        rejected: ex.rejected,
        pending: ex.pending,
      }));
      if (named?.year != null) dated++;
      await new Promise((r) => setTimeout(r, PACE_MS));
    }
    if (dated) {
      console.log(`[identity] dated ${dated} legacy row(s) via remote lookup`);
    }

    const rg = await regradeStoredRows(api, library, entryById, MAX_PER_RUN);
    if (rg.regraded) {
      console.log(
        `[identity] re-graded ${rg.regraded} stored row(s) with premiere dates ` +
          `(${rg.promoted} promoted, ${rg.flagged} flagged for review)`
      );
    }

    const gaps = await fillTvdbGaps(entryById, MAX_PER_RUN);
    if (gaps.tried) {
      console.log(
        `[identity] tvdb gap fill: ${gaps.tried} searched, ${gaps.filled} filled ` +
          `(${gaps.verified} date-verified)`
      );
    }

    if (!batch.length) {
      // "Ran and found nothing to ask" is a result worth recording — the whole
      // point of the status is telling that apart from "never ran".
      await saveSweepStatus({
        finishedAt: Date.now(), looked: 0, accepted: 0, queued: 0, rejected: 0,
        remaining: todo.length, overrides: identityOverrideCount(),
        mapSize: anilistTvdbMapSize(),
      });
      return;
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
        const deltaMs = await episodeDeltaMs(api, inLib, q.airDateMs);
        const tvdb = await tvdbEvidenceFor(found.tvdbEvidence, hit, inLib, deltaMs, q.airDateMs ?? null);
        const yearDelta =
          hit.year != null && q.year != null ? Math.abs(hit.year - q.year) : null;
        const { verdict, rung } = verdictFor({
          exact: hit.exact, inLibrary: !!inLib, deltaMs, yearDelta, kind: hit.tmdbKind,
          premiereDeltaMs: premiereDelta(hit.premiereDate, q.airDateMs ?? null),
          tvdbSeasonDeltaMs: tvdb.seasonDeltaMs,
          tvdbHasUndatedFutureSeason: tvdb.undatedFutureSeason,
        });
        if (verdict === 'reject') {
          // We hold this series and its episodes are nowhere near the entry's
          // premiere, so the candidate is a different work. Record only that
          // we looked.
          rejected++;
          await setIdentityOverride({
            anilistId: q.anilistId, tvdbId: null, tmdbId: null, tmdbKind: null,
            pending: true, source: 'remote', matchedTitle: null,
            note: `remote: rejected ${hit.matchedTitle} (${Math.round((deltaMs ?? 0) / 86400000)}d off)`,
          });
          await new Promise((r) => setTimeout(r, PACE_MS));
          continue;
        }
        // Complete the ids before storing (see completeIdentityIds).
        const full = completeIdentityIds(hit, inLib ?? null);
        await setIdentityOverride({
          anilistId: q.anilistId,
          tvdbId: full.tvdbId,
          tmdbId: full.tmdbId,
          tmdbKind: full.tmdbKind,
          // The year is known right here (TMDB said it) and nothing else can
          // date an unheld gap entry later — store it or lose it.
          year: hit.year,
          // `pending` no longer withholds the id — positive-only does the
          // protecting. It only marks what still wants a human eye.
          pending: verdict === 'queue',
          matchedTitle: hit.matchedTitle,
          candidates: found.candidates,
          source: 'remote',
          // Say which rung of the ladder accepted it — the ladder itself names
          // it, so the note can never claim evidence the verdict didn't use.
          note: verdict === 'accept' && rung ? `remote: ${rung}` : 'remote: unverified',
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
    await saveSweepStatus({
      finishedAt: Date.now(), looked, accepted, queued, rejected,
      remaining: todo.length - batch.length, overrides: identityOverrideCount(),
      mapSize: anilistTvdbMapSize(),
    });
  } catch (err: any) {
    console.warn('[identity] remote sweep failed:', err?.message ?? err);
  } finally {
    _running = false;
  }
}
