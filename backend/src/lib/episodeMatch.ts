// ---------------------------------------------------------------------------
// Which episode does an AniList entry start at?
//
// Pure, so it is unit-testable without a server and — more importantly — so the
// availability path and the remote id resolver share ONE definition of "how far
// off is this". They ask the same question for different reasons:
//
//   availability : which episode should Watch open?
//   resolver     : is this candidate id even the right series?
//
// Both answers turn on the same measurement, and the second only works because
// of what the first revealed: across every non-exact match tested against the
// real library, correct results land 0-3 days from the AniList premiere and
// wrong ones land 329 to 11,083 days away. There is no middle. Two copies of
// that arithmetic would eventually disagree, and the disagreement would be
// invisible.
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
 * Ties go to the *earlier* episode — a same-day double premiere should start at
 * the first of the two, not whichever the list happened to yield last.
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
    if (delta < bestDelta) {
      best = e;
      bestDelta = delta;
    }
  }
  return best ? { episode: best, deltaMs: bestDelta } : null;
}

/**
 * How far an episode's air date may sit from the AniList entry's start date and
 * still be considered the same broadcast. Anime premieres land within a few days
 * of AniList's date; a month absorbs timezone/region skew and a `day: null`
 * partial date (which we read as the 1st), while still being far tighter than
 * the gap to any *other* season — the nearest neighbouring season is a cour
 * away, ~90 days.
 *
 * Measured against the real library, the separation is far larger than the
 * tolerance: correct matches land 0-3 days out, wrong ones 329+.
 */
export const AIR_DATE_TOLERANCE_MS = 31 * 24 * 60 * 60 * 1000;

/** AniList's partial date, read as the earliest day it could mean. */
export function anilistDateToMs(
  d?: { year?: number | null; month?: number | null; day?: number | null } | null
): number | null {
  if (!d?.year) return null;
  return Date.UTC(d.year, (d.month ?? 1) - 1, d.day ?? 1);
}
