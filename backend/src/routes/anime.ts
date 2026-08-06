import { Router } from 'express';
import axios from 'axios';
import { setTimeout as delay } from 'timers/promises';
import prisma from '../db';
import { LRUCache } from 'lru-cache';
import { isValidSeason, isValidYear } from '../lib/validateSeason';
import { backoffFor, readBudget, MAX_ATTEMPTS, DEFAULT_LOCKOUT_MS } from '../lib/anilistRateLimit';

const router = Router();
// In-memory cache to avoid hitting SQLite (and AniList) for hot requests.
// 20 keys ~ two years of data including format variants; each payload is a
// couple of hundred kilobytes at most -> memory footprint is negligible.
// The default ttl matches the DB row's; a copy seeded from an aging DB row gets
// only that row's *remaining* freshness (see the memory.set below).
const memory = new LRUCache<string, any[]>({ max: 20, ttl: 6 * 60 * 60 * 1000 });

/**
 * What AniList last told us about our budget, and which keys are locked out.
 *
 * Both are mirrored into `AppConfig` because the load they guard against is
 * *caused* by restarts. Every other throttle here - the LRU, the in-flight
 * coalescing map - dies with the process, which is fine because losing them
 * costs a SQLite read. Losing these costs upstream requests: a fresh backend
 * would believe it has full budget and no key is failing, and immediately go
 * and find out the hard way. A mutation audit restarts the backend ~26 times an
 * hour, so "on restart" is the common case, not the edge case.
 */
const RATE_LIMIT_KEY = 'anilistRateLimit';
const BACKOFF_KEY = 'anilistBackoff';

/**
 * Below this many requests left in the window, optional work stands down.
 * Roughly one season's worth of pages, so a viewer-blocking fetch still has
 * room to complete after we stop refreshing in the background.
 */
const BUDGET_FLOOR = 8;

/** An observation older than this says nothing about the current window. */
const BUDGET_FRESH_MS = 60_000;

let budget: { remaining: number | null; limit: number | null; observedAt: number } | null = null;
/** key -> epoch ms before which we must not ask AniList about it again. */
let backoffUntil = new Map<string, number>();

let stateLoaded = false;
const stateReady = (async () => {
  try {
    const rows = await prisma.appConfig.findMany({
      where: { key: { in: [RATE_LIMIT_KEY, BACKOFF_KEY] } },
    });
    const b = rows.find((r) => r.key === RATE_LIMIT_KEY)?.value;
    if (b) budget = JSON.parse(b);
    const c = rows.find((r) => r.key === BACKOFF_KEY)?.value;
    if (c) backoffUntil = new Map(Object.entries(JSON.parse(c) as Record<string, number>));
  } catch {
    // A corrupt row must degrade to "we know nothing", never to an outage.
  } finally {
    stateLoaded = true;
  }
})();

function persist(key: string, value: unknown): void {
  const str = JSON.stringify(value);
  prisma.appConfig
    .upsert({ where: { key }, update: { value: str }, create: { key, value: str } })
    .catch(() => undefined); // bookkeeping; never fail a request over it
}

function recordBudget(observed: { remaining: number | null; limit: number | null }): void {
  if (observed.remaining == null) return;
  budget = { ...observed, observedAt: Date.now() };
  persist(RATE_LIMIT_KEY, budget);
}

/**
 * Is there enough budget left to spend on work nobody is waiting for?
 *
 * Only ever consulted for background refreshes. A stale row is already being
 * served, so standing down is free; the alternative is spending the last of the
 * window on a refresh and leaving a never-cached season with nothing.
 */
function budgetAllowsOptionalWork(): boolean {
  if (!stateLoaded) return false; // assume the worst until the DB has answered
  if (!budget || budget.remaining == null) return true; // never asked; no reason to hold back
  if (Date.now() - budget.observedAt > BUDGET_FRESH_MS) return true; // window has rolled over
  return budget.remaining > BUDGET_FLOOR;
}

function lockedOut(key: string): boolean {
  const until = backoffUntil.get(key);
  if (until == null) return false;
  if (Date.now() >= until) {
    backoffUntil.delete(key);
    persist(BACKOFF_KEY, Object.fromEntries(backoffUntil));
    return false;
  }
  return true;
}

/**
 * Remember that this key just failed, so the next request doesn't immediately
 * try again - which is what turned a single 429 into a storm, since a stale row
 * re-triggers its refresh on *every* request and on every restart.
 */
function markFailed(key: string, waitMs: number): void {
  backoffUntil.set(key, Date.now() + Math.max(waitMs, DEFAULT_LOCKOUT_MS));
  persist(BACKOFF_KEY, Object.fromEntries(backoffUntil));
}

function markSucceeded(key: string): void {
  if (!backoffUntil.delete(key)) return;
  persist(BACKOFF_KEY, Object.fromEntries(backoffUntil));
}

interface SeasonQuery {
  season?: string;
  year?: string;
  format?: string;
}

/** Non-429 AniList failure; carries the upstream HTTP status for passthrough. */
class UpstreamError extends Error {
  constructor(public status: number) {
    super(`AniList responded ${status}`);
  }
}

/**
 * Gave up on a 429. Carries the wait AniList asked for so the caller can set a
 * cooldown of the right length rather than inventing one.
 */
class RateLimitedError extends Error {
  constructor(public waitMs: number) {
    super('AniList rate limit exceeded');
  }
}

/**
 * Fetch one AniList page with 429 retry/backoff. Returns the GraphQL `Page`
 * object ({ pageInfo, media }). Throws UpstreamError on non-200/non-429.
 */
async function fetchAniListPage(query: string, baseVariables: Record<string, unknown>, page: number) {
  let attempt = 0;
  while (true) {
    const response = await axios.post(
      'https://graphql.anilist.co',
      { query, variables: { ...baseVariables, page } },
      {
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        validateStatus: () => true // handle 429 manually
      }
    );

    // AniList reports the remaining budget on *every* response, not just 429s.
    // This is the number pacing decisions are made from - anything else is a
    // guess at a value we are already being told.
    recordBudget(readBudget(response.headers as Record<string, unknown>));

    if (response.status === 200) return response.data?.data?.Page ?? {};
    if (response.status !== 429) throw new UpstreamError(response.status);

    attempt++;
    const { waitMs, source } = backoffFor(response.headers as Record<string, unknown>, attempt);
    if (attempt >= MAX_ATTEMPTS) {
      // The caller records the cooldown; it knows the cache key, we don't.
      throw new RateLimitedError(waitMs);
    }

    // Name the key and page. This line is often the only thing on screen for a
    // full minute (the status bar shows the last line written), and without the
    // key it says only "something is rate-limited" - which is exactly the
    // question a reader has. Derived from the variables rather than passed in,
    // so a new call site cannot forget it.
    const who = [baseVariables.season, baseVariables.seasonYear, baseVariables.format]
      .filter(Boolean).join('-');
    console.warn(
      `AniList 429 for ${who || 'unknown key'} p${page} (attempt ${attempt}/${MAX_ATTEMPTS}), ` +
      `waiting ${(waitMs / 1000).toFixed(0)}s [${source}]`
    );
    await delay(waitMs);
  }
}

//: Pages fetched at once. Still gentle on the rate limit, and it keeps the
//: cold-load latency win that the old pool was written for.
const PAGE_CONCURRENCY = 3;

//: Refuse to walk past this many pages. Nothing legitimate comes close (a big
//: season is 3-4 pages at perPage 50); it exists so a wrong answer from
//: upstream can never again turn one refresh into a hundred requests.
const MAX_SEASON_PAGES = 20;

/**
 * Fetch every page of a season from AniList.
 *
 * **`pageInfo` cannot be trusted for this query, and trusting it was expensive.**
 * Measured directly against the API for SPRING 2026:
 *
 *     pageInfo: { total: 5000, lastPage: 100, hasNextPage: true, perPage: 50 }
 *     media returned on page 1: 50      <- the season really holds ~113 entries
 *
 * `Page.pageInfo` does not reflect the `media(season:, seasonYear:)` filter; it
 * reports an unfiltered, capped total. The previous implementation read
 * `lastPage` and dutifully fetched **100 pages per season refresh**, ~97 of
 * them empty. Six cache keys is ~600 requests against a shared 30/min budget,
 * which is why a single "warm once at the start" never held and why a mutation
 * audit logged 219 live 429s. The old comment here claimed "a mid-season list
 * is 6-12 pages"; that was a belief about lastPage, never a measurement.
 *
 * So paging stops on a SHORT PAGE (fewer items than `perPage`) - the standard
 * way to page an API whose counts you cannot rely on, and the only signal here
 * that actually tracks the filtered result set. `hasNextPage` is deliberately
 * not consulted: it is true on page 1 of a 113-entry season and stays true.
 */
async function fetchSeasonFromAniList(query: string, baseVariables: Record<string, unknown>): Promise<any[]> {
  const perPage = Number(baseVariables.perPage) || 50;
  const allMedia: any[] = [];
  let next = 1;

  while (next <= MAX_SEASON_PAGES) {
    // A wave of pages at once, then decide. Over-fetching by at most
    // CONCURRENCY-1 pages is the price of not doing this one round trip at a
    // time; against the old 100 pages it is not a price worth optimising.
    const wave = [];
    for (let i = 0; i < PAGE_CONCURRENCY && next + i <= MAX_SEASON_PAGES; i++) {
      wave.push(fetchAniListPage(query, baseVariables, next + i));
    }
    const pages = await Promise.all(wave);
    next += pages.length;

    for (const pageData of pages) {
      const media = pageData.media ?? [];
      allMedia.push(...media);
      // Short page: this was the end of the real result set. Anything the rest
      // of the wave returned has already been collected above, so stopping
      // here loses nothing.
      if (media.length < perPage) return allMedia;
    }
  }

  console.warn(
    `[anime] stopped at the ${MAX_SEASON_PAGES}-page cap with ${allMedia.length} entries - ` +
    `either a season really is this large, or upstream paging changed shape again`
  );
  return allMedia;
}

// In-flight cold fetches keyed like the memory cache - concurrent requests
// for the same season await one shared AniList chain.
const inflight = new Map<string, Promise<any[]>>();

const SEASON_TTL_SECONDS = 6 * 60 * 60;

router.get('/', async (req, res) => {
  const { season, year, format } = req.query as SeasonQuery;

  if (!season || !year) {
    return res.status(400).json({ error: 'Missing "season" or "year" query param', code: 'BAD_REQUEST' });
  }
  if (!isValidSeason(season) || !isValidYear(year)) {
    return res.status(400).json({ error: 'Invalid season or year', code: 'BAD_REQUEST' });
  }

  const formatArg = format ? ', format: $format' : '';
  const formatVar = format ? ', $format: MediaFormat' : '';

  const query = /* GraphQL */ `
    query ($page: Int, $perPage: Int, $season: MediaSeason, $seasonYear: Int${formatVar}) {
      Page(page: $page, perPage: $perPage) {
        pageInfo { hasNextPage total currentPage lastPage }
        media(season: $season, seasonYear: $seasonYear, type: ANIME${formatArg}) {
          id
          title {
            romaji
            english
            native
          }
          description(asHtml: false)
          isAdult
          coverImage {
            # Include highest quality available for cover images
            extraLarge
            large
            medium
          }
          trailer {
            id
            site
            thumbnail
          }
          format
          season
          seasonYear
          status
          nextAiringEpisode {
            airingAt
            episode
          }
          episodes
          startDate { year month day }
          endDate { year month day }
          relations {
            edges {
              relationType
              node {
                id
                title { romaji }
              }
            }
          }
          source
        }
      }
    }
  `;

  try {
    // -------------------------- Memory cache ---------------------------
    const memKey = `${season}-${year}-${format ?? ''}`.toUpperCase();
    const cachedMem = memory.get(memKey);
    if (cachedMem) {
      return res.json(cachedMem);
    }

    // ---------------------- Cache lookup ----------------------
    // Use empty string to represent "no format filter" because NULL values are
    // not allowed in composite PRIMARY KEY columns in SQLite.  Using '' keeps
    // the constraint intact and still distinguishes it from real format
    // strings such as 'TV'.
    const cacheKeyFormat: string = format ? format.toUpperCase() : '';
    // `updatedAt` is stored via SQLite's `datetime('now')`, a non-ISO string
    // whose direct Date-parse is implementation-defined - so SQLite converts
    // it to a Unix epoch (`strftime('%s', ...)`) and age math stays integer.
    const cached = await prisma.$queryRawUnsafe(
      `SELECT data, strftime('%s', updatedAt) AS updatedEpoch
       FROM   "SeasonCache"
       WHERE  season = ?
       AND    year   = ?
       AND    format = ?
       LIMIT  1`,
      season.toUpperCase(),
      Number(year),
      cacheKeyFormat
    ) as { data: string; updatedEpoch: string | number }[];

    // Cold fetch, coalesced: page reloads while a fetch is stuck in 429
    // backoff would otherwise each start their own multi-page AniList chain,
    // deepening the rate-limit penalty.
    const startColdFetch = (): Promise<any[]> => {
      let pending = inflight.get(memKey);
      if (!pending) {
        pending = (async () => {
          let allMedia: any[];
          try {
            allMedia = await fetchSeasonFromAniList(query, {
              perPage: 50,
              season: season.toUpperCase(),
              seasonYear: Number(year),
              ...(format ? { format: format.toUpperCase() } : {})
            });
          } catch (err) {
            // Record the lockout against this key so the next request - and the
            // next process - doesn't walk straight back into it.
            markFailed(memKey, err instanceof RateLimitedError ? err.waitMs : DEFAULT_LOCKOUT_MS);
            throw err;
          }
          markSucceeded(memKey);

          // Save/replace cache (only the winning fetch writes)
          await prisma.$executeRawUnsafe(
            `INSERT OR REPLACE INTO "SeasonCache" (season, year, format, data, updatedAt)
             VALUES (?, ?, ?, ?, datetime('now'))`,
            season.toUpperCase(),
            Number(year),
            cacheKeyFormat,
            JSON.stringify(allMedia)
          );
          memory.set(memKey, allMedia);
          return allMedia;
        })().finally(() => inflight.delete(memKey));
        inflight.set(memKey, pending);
      }
      return pending;
    };

    // Six hours for every season, deliberately flat. Two boundaries, both real:
    // pinning a finished season for DAYS decides on AniList's behalf that its
    // data is frozen - entries get added and corrected long after a season ends
    // (late OVAs, retitles, metadata fixes) - while refreshing every HOUR spends
    // the shared ~30 req/min per-IP budget on data that barely moves, and it was
    // the background-refresh frequency behind every 429 storm here (a ~90-minute
    // test run outgrew a 1h TTL and re-fired a refresh on each of ~114 backend
    // restarts). Stale-while-revalidate below means the TTL never adds viewer
    // latency either way; it only sets how often AniList gets asked. The one
    // user-visible cost of 6h: a show added on AniList takes up to ~6h to appear.
    //
    // Upstream load beyond that is handled where it belongs: by the observed
    // budget and the per-key cooldown above, both of which survive a restart.
    const ttlSeconds = SEASON_TTL_SECONDS;
    if (cached.length) {
      const currentEpoch = Math.floor(Date.now() / 1000);
      const ageSeconds = currentEpoch - Number(cached[0].updatedEpoch);
      const data = JSON.parse(cached[0].data);
      if (ageSeconds < ttlSeconds) {
        // Serve from DB cache and populate in-memory cache for faster subsequent
        // calls. Seed with the DB row's *remaining* freshness (not a full fresh
        // TTL) so the in-memory copy doesn't outlive the DB row's validity.
        memory.set(memKey, data, { ttl: Math.max(1, ttlSeconds - ageSeconds) * 1000 });
        return res.json(data);
      }
      // Stale-while-revalidate: season data barely changes hour-to-hour, and
      // a cold AniList fetch can take minutes under rate-limit pressure -
      // serve the expired copy instantly and refresh in the background.
      //
      // Skipped when the budget is thin or this key is in a cooldown. We
      // already have an answer to serve, so standing down costs the viewer
      // nothing - whereas spending the last of the window here leaves a
      // never-cached season, which has nothing to show anyone, with none.
      if (budgetAllowsOptionalWork() && !lockedOut(memKey)) {
        startColdFetch().catch((err) =>
          console.warn(`[anime] background refresh failed for ${memKey}:`, err?.message ?? err)
        );
      }
      return res.json(data);
    }

    // Never-fetched season: nothing to serve until AniList answers. This path
    // is never delayed on purpose - a viewer is watching a spinner - but it does
    // refuse to queue behind a known lockout, because waiting out a 429 with a
    // request held open is how a page comes to hang for minutes.
    if (lockedOut(memKey)) {
      return res.status(503).json({
        error: 'AniList is rate-limiting us; try again shortly',
        code: 'UPSTREAM_ERROR',
      });
    }
    res.json(await startColdFetch());
  } catch (error) {
    if (error instanceof UpstreamError) {
      return res.status(error.status).json({ error: 'AniList error', code: 'UPSTREAM_ERROR' });
    }
    if (error instanceof RateLimitedError) {
      // Being rate-limited upstream is not a server error, and reporting it as
      // one is actively misleading: a 500 says "we are broken", sends callers
      // looking in the wrong place, and throws away the one useful fact we have.
      // The lockout path a few lines above already answers 503 for exactly this
      // condition, so the two must agree.
      res.setHeader('Retry-After', Math.ceil(error.waitMs / 1000));
      return res.status(503).json({
        error: 'AniList is rate-limiting us; try again shortly',
        code: 'UPSTREAM_ERROR',
      });
    }
    console.error('AniList API error', error);
    res.status(500).json({ error: 'Failed to fetch data from AniList', code: 'SERVER_ERROR' });
  }
});

export default router;
