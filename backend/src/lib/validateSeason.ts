// Shared validators for the season / year query-params that show up in
// almost every list-ish route. Returning booleans (and also type guards)
// keeps route bodies simple:
//
//   if (!isValidSeason(season) || !isValidYear(year)) {
//     return res.status(400).json({ error: 'Invalid season or year', code: 'BAD_REQUEST' });
//   }

export const VALID_SEASONS = ['WINTER', 'SPRING', 'SUMMER', 'FALL'] as const;
export type Season = (typeof VALID_SEASONS)[number];

const SEASON_SET = new Set<string>(VALID_SEASONS);

/** Narrow an unknown (typically from req.query/body) to one of the 4 season strings. */
export function isValidSeason(s: unknown): s is Season {
  return typeof s === 'string' && SEASON_SET.has(s.toUpperCase());
}

/**
 * Narrow an unknown year to an integer inside a sensible bound. Accepts
 * both string (common from req.query) and number forms.
 */
export function isValidYear(y: unknown): boolean {
  const n = typeof y === 'string' ? Number(y) : (y as number);
  return Number.isInteger(n) && n >= 1970 && n <= 2100;
}

/**
 * An optional `?season=&year=` override: both or neither, and both valid.
 * `refs: null` means "neither was sent - use the route's default seasons".
 * Shared by `/api/sonarr` (`/push`, `/push/preview`, `/report`) and
 * `/api/translate/report`, which each carried an identical copy.
 */
export function seasonOverride(
  season: string | undefined,
  year: string | undefined
): { error: string } | { refs: { season: Season; year: number }[] | null } {
  if ((season && !year) || (!season && year)) {
    return { error: 'Provide both "season" and "year", or neither' };
  }
  if (season && year) {
    if (!isValidSeason(season) || !isValidYear(year)) return { error: 'Invalid season or year' };
    return { refs: [{ season: season.toUpperCase() as Season, year: Number(year) }] };
  }
  return { refs: null };
}
