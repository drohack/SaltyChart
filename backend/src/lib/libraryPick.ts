// ---------------------------------------------------------------------------
// Searching the held library so a VIEWER can correct a wrong match.
//
// The Randomize pop-up is where a bad match is actually noticed - /admin/matching
// is where it can be fixed, and nobody goes there. This is the search behind the
// pop-up's "Not the right show?" picker.
//
// It offers LIBRARY ITEMS, never the resolver's stored candidates. Candidates
// are TMDB/TVDB ids, and most of them aren't held - that is usually *why* a row
// is unverified. A menu where six of eight options can't play is worse than one
// honest answer.
// ---------------------------------------------------------------------------
import { normalizeTitle, type MatchableSeries } from './animeMatch';

/** A held series, exactly as `getSeriesLibrary` returns it. */
export type PickableSeries = MatchableSeries;

/** A held film, as `jellyfinFilmIndex` stores it (keyed by TMDB id). */
export interface PickableFilm {
  itemId: string;
  title: string;
  year?: number | null;
}

/** One option a viewer may pick. Ids are ours, read from the library. */
export interface PickOption {
  kind: 'tv' | 'movie';
  /** Jellyfin item id - what the pick endpoint resolves against. */
  itemId: string;
  title: string;
  year: number | null;
  tvdbId: string | null;
  tmdbId: string | null;
}

/**
 * Film titles arrive unnormalized: `jellyfinFilmIndex` is deliberately an id
 * index and not a second matchable corpus, so it stores no `norms`. Normalizing
 * ~6,600 of them on every keystroke would be silly, and the index object is
 * replaced wholesale on refresh - so memoize against its identity and let the
 * old entry fall out with it.
 */
const _filmNorms = new WeakMap<object, Map<string, string>>();

function filmNormsFor(films: Record<string, PickableFilm>): Map<string, string> {
  const hit = _filmNorms.get(films);
  if (hit) return hit;
  const norms = new Map<string, string>();
  for (const [tmdbId, f] of Object.entries(films)) norms.set(tmdbId, normalizeTitle(f.title));
  _filmNorms.set(films, norms);
  return norms;
}

/** 0 exact, 1 prefix, 2 contains, null no match. */
function tierOf(norm: string, want: string): 0 | 1 | 2 | null {
  if (!norm) return null;
  if (norm === want) return 0;
  if (norm.startsWith(want)) return 1;
  return norm.includes(want) ? 2 : null;
}

/**
 * Rank the held library against a typed term.
 *
 * **A contains tier is correct here**, and deliberately unlike `matchSeries`,
 * whose contains-anywhere tier was removed after firing 9 times over 6 seasons
 * and being wrong all 9. That rule is about matching *automatically*, with no
 * human to catch it. Here a person reads the list and chooses, so hiding the
 * right answer because their term sits mid-title is the only real failure.
 *
 * Items with no id in either space are dropped: a pick is written as an
 * identity override and resolved by id, so an id-less item cannot be pinned and
 * offering it would be a control that silently does nothing.
 */
export function searchLibrary(
  term: string,
  series: readonly PickableSeries[],
  films: Record<string, PickableFilm>,
  limit = 12
): PickOption[] {
  const want = normalizeTitle(term.trim());
  if (!want) return [];

  const scored: { tier: 0 | 1 | 2; opt: PickOption }[] = [];

  for (const s of series) {
    if (!s.tvdbId && !s.tmdbId) continue;
    let best: 0 | 1 | 2 | null = null;
    for (const n of s.norms) {
      const t = tierOf(n, want);
      if (t !== null && (best === null || t < best)) best = t;
    }
    if (best === null) continue;
    scored.push({
      tier: best,
      opt: {
        kind: 'tv',
        itemId: s.id,
        title: s.title,
        year: s.year ?? null,
        tvdbId: s.tvdbId ?? null,
        tmdbId: s.tmdbId ?? null,
      },
    });
  }

  const norms = filmNormsFor(films);
  for (const [tmdbId, f] of Object.entries(films)) {
    const t = tierOf(norms.get(tmdbId) ?? '', want);
    if (t === null) continue;
    scored.push({
      tier: t,
      opt: {
        kind: 'movie',
        itemId: f.itemId,
        title: f.title,
        year: f.year ?? null,
        tvdbId: null,
        tmdbId,
      },
    });
  }

  // Tier first, then the shortest title - the least extra noise around the
  // words the viewer actually typed, same instinct as matchByTitle.
  scored.sort((a, b) => a.tier - b.tier || a.opt.title.length - b.opt.title.length);
  return scored.slice(0, limit).map((s) => s.opt);
}
