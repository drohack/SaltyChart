import { Router } from 'express';
import axios from 'axios';
import { setTimeout as delay } from 'timers/promises';
import prisma from '../db';
import { LRUCache } from 'lru-cache';
import { isValidSeason, isValidYear } from '../lib/validateSeason';

const router = Router();
// In-memory cache to avoid hitting SQLite (and AniList) for hot requests.
// 20 keys ≈ two years of data including format variants; each payload is a
// couple of hundred kilobytes at most → memory footprint is negligible.
const memory = new LRUCache<string, any[]>({ max: 20, ttl: 1000 * 60 * 60 });

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
 * Fetch one AniList page with 429 retry/backoff. Returns the GraphQL `Page`
 * object ({ pageInfo, media }). Throws UpstreamError on non-200/non-429.
 */
async function fetchAniListPage(query: string, baseVariables: Record<string, unknown>, page: number) {
  let attempts = 0;
  const maxAttempts = 3;
  while (true) {
    const response = await axios.post(
      'https://graphql.anilist.co',
      { query, variables: { ...baseVariables, page } },
      {
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        validateStatus: () => true // handle 429 manually
      }
    );

    if (response.status === 200) return response.data?.data?.Page ?? {};
    if (response.status !== 429) throw new UpstreamError(response.status);

    // received 429, wait then retry
    attempts++;
    if (attempts > maxAttempts) throw new Error('AniList rate limit exceeded');
    // Respect AniList headers when provided
    const retryAfterHeader = response.headers['retry-after'];
    const resetHeader = response.headers['x-ratelimit-reset'];

    let waitMs: number;
    if (retryAfterHeader) {
      waitMs = Number(retryAfterHeader) * 1000;
    } else if (resetHeader) {
      const resetTs = Number(resetHeader) * 1000; // header is seconds
      waitMs = Math.max(resetTs - Date.now(), 0);
    } else {
      // No headers on the 429: escalate within AniList's 1-minute window.
      // (60s per attempt made a contended cold load feel dead — the page
      // sat on skeletons for minutes when 15-45s was enough to recover.)
      waitMs = 15_000 * attempts;
    }
    // Floor the wait: a reset timestamp in the past (clock skew, or the
    // window rolling over mid-burst) yields 0 ms — instant retries just
    // burn maxAttempts while the limit is still active.
    waitMs = Math.max(waitMs, 2_000 * attempts);

    console.warn(`AniList 429 received, retrying in ${(waitMs / 1000).toFixed(0)}s…`);
    await delay(waitMs);
  }
}

/**
 * Fetch every page of a season from AniList. Page 1 tells us lastPage, so
 * the remaining pages are fetched with a small concurrency pool instead of
 * one-at-a-time — a mid-season list is 6-12 pages and the sequential round
 * trips dominated cold-load latency.
 */
async function fetchSeasonFromAniList(query: string, baseVariables: Record<string, unknown>): Promise<any[]> {
  const firstPage = await fetchAniListPage(query, baseVariables, 1);
  const allMedia: any[] = [...(firstPage.media ?? [])];
  const lastPage: number = firstPage.pageInfo?.lastPage
    ?? (firstPage.pageInfo?.hasNextPage ? 2 : 1);

  if (lastPage > 1) {
    const pageNums = Array.from({ length: lastPage - 1 }, (_, i) => i + 2);
    const results: any[][] = new Array(pageNums.length);
    let nextIdx = 0;
    let lastPageInfo: any = firstPage.pageInfo;
    const worker = async () => {
      while (nextIdx < pageNums.length) {
        const i = nextIdx++;
        const pageData = await fetchAniListPage(query, baseVariables, pageNums[i]);
        results[i] = pageData.media ?? [];
        if (pageNums[i] === lastPage) lastPageInfo = pageData.pageInfo;
      }
    };
    const CONCURRENCY = 3; // gentle on AniList's rate limit (429 backoff still applies per page)
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pageNums.length) }, worker));
    for (const media of results) allMedia.push(...media);

    // Safety net: if lastPage under-reported (entries added mid-fetch), keep
    // walking sequentially like the old loop did.
    let page = lastPage;
    while (lastPageInfo?.hasNextPage) {
      page += 1;
      const pageData = await fetchAniListPage(query, baseVariables, page);
      allMedia.push(...(pageData.media ?? []));
      lastPageInfo = pageData.pageInfo;
    }
  }
  return allMedia;
}

// In-flight cold fetches keyed like the memory cache — concurrent requests
// for the same season await one shared AniList chain.
const inflight = new Map<string, Promise<any[]>>();

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
    // -------------------------------------------------------------------
    // Cache lookup
    // -------------------------------------------------------------------
    // The `updatedAt` column is stored using SQLite's `datetime('now')` which
    // yields the non-ISO format "YYYY-MM-DD HH:MM:SS". Date parsing that
    // string directly is implementation-defined. To avoid any ambiguity we
    // request that SQLite converts the value to a Unix timestamp (seconds)
    // using `strftime('%s', …)`.  Working with the raw epoch lets us calculate
    // ages with simple integer math and guarantees consistent behaviour across
    // platforms.

    // Build cache lookup SQL depending on whether a "format" filter is used.
    // When format is null/undefined we need to compare against NULL with "IS
    // NULL"; when it's present we use a normal equality comparison.  Mixing
    // the two in a single parameterised clause (e.g. "format IS ?") can yield
    // unexpected results because "IS" only treats NULL specially – for normal
    // values it behaves like "=", but some SQLite/driver versions optimise it
    // differently.  Splitting the query removes all doubt.

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
          const allMedia = await fetchSeasonFromAniList(query, {
            perPage: 50,
            season: season.toUpperCase(),
            seasonYear: Number(year),
            ...(format ? { format: format.toUpperCase() } : {})
          });

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

    const ONE_HOUR_SECONDS = 60 * 60; // 1 h
    if (cached.length) {
      const currentEpoch = Math.floor(Date.now() / 1000);
      const ageSeconds = currentEpoch - Number(cached[0].updatedEpoch);
      const data = JSON.parse(cached[0].data);
      if (ageSeconds < ONE_HOUR_SECONDS) {
        // Serve from DB cache and populate in-memory cache for faster subsequent
        // calls. Seed with the DB row's *remaining* freshness (not a full fresh
        // hour) so the in-memory copy doesn't outlive the DB row's 1h validity.
        memory.set(memKey, data, { ttl: Math.max(1, ONE_HOUR_SECONDS - ageSeconds) * 1000 });
        return res.json(data);
      }
      // Stale-while-revalidate: season data barely changes hour-to-hour, and
      // a cold AniList fetch can take minutes under rate-limit pressure —
      // serve the expired copy instantly and refresh in the background.
      startColdFetch().catch((err) =>
        console.warn(`[anime] background refresh failed for ${memKey}:`, err?.message ?? err)
      );
      return res.json(data);
    }

    // Never-fetched season: nothing to serve until AniList answers.
    res.json(await startColdFetch());
  } catch (error) {
    if (error instanceof UpstreamError) {
      return res.status(error.status).json({ error: 'AniList error', code: 'UPSTREAM_ERROR' });
    }
    console.error('AniList API error', error);
    res.status(500).json({ error: 'Failed to fetch data from AniList', code: 'SERVER_ERROR' });
  }
});

export default router;
