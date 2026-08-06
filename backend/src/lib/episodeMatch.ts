// ---------------------------------------------------------------------------
// Which episode does an AniList entry start at?
//
// Pure, so it is unit-testable without a server and - more importantly - so the
// availability path and the remote id resolver share ONE definition of "how far
// off is this". They ask the same question for different reasons:
//
//   availability : which episode should Watch open?
//   resolver     : is this candidate id even the right series?
//
// Both answers turn on the same measurement - the one recorded on
// AIR_DATE_TOLERANCE_MS below. Two copies of that arithmetic would eventually
// disagree, and the disagreement would be invisible.
// ---------------------------------------------------------------------------

/** Anything with the fields Jellyfin returns by default on /Shows/{id}/Episodes. */
export interface DatedEpisode {
  ParentIndexNumber?: number | null;
  IndexNumber?: number | null;
  PremiereDate?: string | null;
}

/**
 * The dated episode closest to `airDateMs`, and how far off it is.
 *
 * Season 0 is skipped: specials' dates cluster around the seasons they ship
 * with and would otherwise win ties against the real episode.
 *
 * Ties go to the *earlier* episode by (season, episode) number - enforced here,
 * not assumed of the input, because Jellyfin's episode order is not a contract
 * (the episode picker in routes/jellyfin.ts has always sorted before trusting
 * it) and a same-day double premiere would otherwise open Watch on whichever
 * episode the response happened to list first.
 */
export function closestDatedEpisode<T extends DatedEpisode>(
  episodes: T[],
  airDateMs: number
): { episode: T; deltaMs: number } | null {
  let best: T | null = null;
  let bestDelta = Infinity;
  for (const e of episodes) {
    if ((e.ParentIndexNumber ?? 0) < 1 || !e.PremiereDate) continue;
    const t = Date.parse(e.PremiereDate);
    if (Number.isNaN(t)) continue;
    const delta = Math.abs(t - airDateMs);
    if (delta < bestDelta || (delta === bestDelta && best !== null && earlier(e, best))) {
      best = e;
      bestDelta = delta;
    }
  }
  return best ? { episode: best, deltaMs: bestDelta } : null;
}

function earlier(a: DatedEpisode, b: DatedEpisode): boolean {
  const sa = a.ParentIndexNumber ?? 0;
  const sb = b.ParentIndexNumber ?? 0;
  if (sa !== sb) return sa < sb;
  return (a.IndexNumber ?? 0) < (b.IndexNumber ?? 0);
}

/**
 * How far an episode's air date may sit from the AniList entry's start date and
 * still be considered the same broadcast. Anime premieres land within a few days
 * of AniList's date; a month absorbs timezone/region skew and a `day: null`
 * partial date (which we read as the 1st), while still being far tighter than
 * the gap to any *other* season - the nearest neighbouring season is a cour
 * away, ~90 days.
 *
 * Measured against the real library, the separation is far larger than the
 * tolerance: across every non-exact match tested, correct results land 0-3
 * days from the AniList premiere and wrong ones land 329 to 11,083 days away.
 * There is no middle.
 */
export const AIR_DATE_TOLERANCE_MS = 31 * 24 * 60 * 60 * 1000;

/** AniList's partial date, read as the earliest day it could mean. */
export function anilistDateToMs(
  d?: { year?: number | null; month?: number | null; day?: number | null } | null
): number | null {
  if (!d?.year) return null;
  return Date.UTC(d.year, (d.month ?? 1) - 1, d.day ?? 1);
}
