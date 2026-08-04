import { writable, type Writable } from 'svelte/store';

// ---------------------------------------------------------------------------
// Global Season / Year store shared by all pages
// ---------------------------------------------------------------------------

export type Season = 'WINTER' | 'SPRING' | 'SUMMER' | 'FALL';

/**
 * How early to switch the default view to the upcoming season.
 *
 * Was 76 days, which flipped the default about two weeks after the *current*
 * season's premieres — so for most of a season you landed on one where nothing
 * had aired and nothing could be in the library yet. 50 days moves the cutover
 * to roughly six weeks in, leaving the airing season as the default for longer
 * while still giving a month and a half of trailer-browsing lead time.
 *
 * Declared at the top of the module on purpose: `computeInitialSeason()` runs
 * during module initialisation (the store restores its value eagerly), so a
 * `const` declared next to that function sits in the temporal dead zone and
 * throws `Cannot access 'LOOKAHEAD_DAYS' before initialization` — which renders
 * the entire app blank, since the store never initialises.
 */
const LOOKAHEAD_DAYS = 50;

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
// Persisted value expires after CACHE_TTL_MS to ensure we eventually return
// to the real “current” season when users revisit after a longer break.
// Keep this in sync with the backend SeasonCache TTL (1 h) so we fetch fresh
// data when the cache becomes stale.
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// ---------------------------------------------------------------------------
// Force-reset helper for hard reload (Ctrl + F5)
// ---------------------------------------------------------------------------

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => {
    if (
      (e.ctrlKey && (e.key === 'F5' || e.keyCode === 116)) ||       // Ctrl+F5
      (e.ctrlKey && e.shiftKey && (e.key === 'R' || e.key === 'r')) // Ctrl+Shift+R
    ) {
      try {
        sessionStorage.setItem('forceSeasonReset', '1');
      } catch {
        /* ignore */
      }
    }
  });
}

// Attempt to restore the last selection from localStorage (browser-only).
interface Persisted {
  season: Season;
  year: number;
  saved: number; // epoch ms
}

function loadPersisted(): { season: Season; year: number } | null {
  if (typeof localStorage === 'undefined') return null;
  // If a hard-reload flag was set, clear and skip immediately
  if (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('forceSeasonReset')) {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {/* ignore */}
    sessionStorage.removeItem('forceSeasonReset');
    return null;
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const { season, year, saved } = JSON.parse(raw) as Partial<Persisted>;

    const now = Date.now();
    if (typeof saved === 'number' && now - saved > CACHE_TTL_MS) {
      // Expired – clear so next load uses current season
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }

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

const initial = loadPersisted() ?? computeInitialSeason();

export const seasonYear: Writable<{ season: Season; year: number }> = writable(initial);

// Persist changes so the selection survives navigation / reloads.
if (typeof localStorage !== 'undefined') {
  seasonYear.subscribe((val) => {
    try {
      const payload: Persisted = { ...val, saved: Date.now() } as Persisted;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      /* quota or other errors – ignore */
    }
  });
}

// ---------------------------------------------------------------------------
// Fetch current season/year from AniList GraphQL (once per session).
//
// ⚠ Calls graphql.anilist.co DIRECTLY from the browser — invisible to every
// backend rate-limit control, because the backend never sees it. It currently
// has no callers. Don't wire it up; route it through /api/anime if the need
// returns.
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

// Helper to compute next season start (anime industry boundaries: Jan/Apr/Jul/Oct)
export function nextSeasonInfo(
  season: Season,
  year: number
): { season: Season; year: number; starts: Date } {
  switch (season) {
    case 'WINTER':
      return { season: 'SPRING', year, starts: new Date(year, 3, 1) }; // 1 Apr
    case 'SPRING':
      return { season: 'SUMMER', year, starts: new Date(year, 6, 1) }; // 1 Jul
    case 'SUMMER':
      return { season: 'FALL', year, starts: new Date(year, 9, 1) }; // 1 Oct
    case 'FALL':
    default:
      return { season: 'WINTER', year: year + 1, starts: new Date(year + 1, 0, 1) }; // 1 Jan next yr
  }
}

// Returns the season to show by default: the upcoming season if within
// LOOKAHEAD_DAYS (declared at the top of this module) of its start, otherwise
// the current season. Handles the cross-year case (FALL→WINTER) correctly.
function computeInitialSeason(date: Date = new Date()): { season: Season; year: number } {
  const m = date.getMonth();
  let raw: Season;
  if (m <= 2) raw = 'WINTER';
  else if (m <= 5) raw = 'SPRING';
  else if (m <= 8) raw = 'SUMMER';
  else raw = 'FALL';

  const rawYear = date.getFullYear();
  const next = nextSeasonInfo(raw, rawYear);
  const daysUntil = (next.starts.getTime() - date.getTime()) / 86_400_000;
  if (daysUntil <= LOOKAHEAD_DAYS) return { season: next.season, year: next.year };
  return { season: raw, year: rawYear };
}
