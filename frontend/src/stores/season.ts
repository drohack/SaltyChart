import { writable, type Writable } from 'svelte/store';

// ---------------------------------------------------------------------------
// Global Season / Year store shared by all pages
// ---------------------------------------------------------------------------

export type Season = 'WINTER' | 'SPRING' | 'SUMMER' | 'FALL';

// Helper: derive the anime “production” season from today’s month.
// Mapping follows the common industry convention:
//   Winter : January – March  (0–2)
//   Spring : April  – June   (3–5)
//   Summer : July   – September (6–8)
//   Fall   : October – December (9–11)
function currentSeason(date: Date = new Date()): Season {
  const m = date.getMonth();
  if (m <= 2) return 'WINTER';
  if (m <= 5) return 'SPRING';
  if (m <= 8) return 'SUMMER';
  return 'FALL';
}

const STORAGE_KEY = 'season-year';

// Attempt to restore the last selection from localStorage (browser-only).
function loadPersisted(): { season: Season; year: number } | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const { season, year } = JSON.parse(raw);
    if (
      (season === 'WINTER' || season === 'SPRING' || season === 'SUMMER' || season === 'FALL') &&
      typeof year === 'number' &&
      Number.isFinite(year)
    ) {
      return { season, year } as { season: Season; year: number };
    }
  } catch {
    /* ignore malformed data */
  }
  return null;
}

const initial = loadPersisted() ?? {
  season: currentSeason(),
  year: new Date().getFullYear()
};

export const seasonYear: Writable<{ season: Season; year: number }> = writable(initial);

// Persist changes so the selection survives navigation / reloads.
if (typeof localStorage !== 'undefined') {
  seasonYear.subscribe((val) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(val));
    } catch {
      /* quota or other errors – ignore */
    }
  });
}

// ---------------------------------------------------------------------------
// Fetch current season/year from AniList GraphQL (once per session)
// ---------------------------------------------------------------------------

let _apiPromise: Promise<{ season: Season; seasonYear: number }> | null = null;

export function getCurrentSeasonFromAPI(): Promise<{ season: Season; seasonYear: number }> {
  if (_apiPromise) return _apiPromise;

  const body = {
    query: 'query { Site { season seasonYear } }'
  };

  _apiPromise = fetch('https://graphql.anilist.co', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(body)
  })
    .then((r) => {
      if (!r.ok) throw new Error(`AniList HTTP ${r.status}`);
      return r.json();
    })
    .then((json) => {
      const site = json?.data?.Site;
      if (!site) throw new Error('Malformed AniList response');
      return {
        season: site.season as Season,
        seasonYear: site.seasonYear as number
      };
    })
    .catch((err) => {
      console.error('Failed fetching current season from AniList:', err);
      // Reset so future calls can retry
      _apiPromise = null;
      // Re-throw to let callers handle it
      throw err;
    });

  return _apiPromise;
}

// Helper to compute next season start (AniList boundaries)
export function nextSeasonInfo(
  season: Season,
  year: number
): { season: Season; year: number; starts: Date } {
  switch (season) {
    case 'WINTER':
      return { season: 'SPRING', year, starts: new Date(year, 2, 1) }; // 1 Mar
    case 'SPRING':
      return { season: 'SUMMER', year, starts: new Date(year, 5, 1) }; // 1 Jun
    case 'SUMMER':
      return { season: 'FALL', year, starts: new Date(year, 8, 1) }; // 1 Sep
    case 'FALL':
    default:
      return { season: 'WINTER', year: year + 1, starts: new Date(year, 11, 1) }; // 1 Dec
  }
}

