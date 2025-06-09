import { Router } from 'express';
import axios from 'axios';
import { setTimeout as delay } from 'timers/promises';
import prisma from '../db';
import { LRUCache } from 'lru-cache';

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

router.get('/', async (req, res) => {
  const { season, year, format } = req.query as SeasonQuery;

  if (!season || !year) {
    return res.status(400).json({ error: 'Missing "season" or "year" query param' });
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

    const ONE_HOUR_SECONDS = 60 * 60; // 1 h
    if (cached.length) {
      const currentEpoch = Math.floor(Date.now() / 1000);
      const ageSeconds = currentEpoch - Number(cached[0].updatedEpoch);
      if (ageSeconds < ONE_HOUR_SECONDS) {
        // Serve from DB cache and populate in-memory cache for faster subsequent calls
        const data = JSON.parse(cached[0].data);
        memory.set(memKey, data);
        return res.json(data);
      }
    }

    // ---------------------- Fetch from AniList ----------------------
    const allMedia: any[] = [];
    let page = 1;
    const perPage = 50;
    let hasNext = true;

    while (hasNext) {
      // retry mechanism for 429 rate limits
      let attempts = 0;
      let response;
      const maxAttempts = 3;
      while (true) {
        try {
          response = await axios.post(
            'https://graphql.anilist.co',
            {
              query,
              variables: {
                page,
                perPage,
                season: season.toUpperCase(),
                seasonYear: Number(year),
                ...(format ? { format: format.toUpperCase() } : {})
              }
            },
            {
              headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json'
              },
              validateStatus: () => true // handle 429 manually
            }
          );

          if (response.status !== 429) break; // success or other error

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
            // Fallback exponential back-off within 1-min window
            waitMs = 60_000 * attempts;
          }

          console.warn(`AniList 429 received, retrying in ${(waitMs / 1000).toFixed(0)}s…`);
          await delay(waitMs);
        } catch (err: any) {
          if (err.response?.status !== 429 || attempts >= maxAttempts) {
            throw err;
          }
        }
      }

      if (response.status !== 200) {
        return res.status(response.status).json({ error: 'AniList error' });
      }

      const pageData = response.data?.data?.Page;
      allMedia.push(...(pageData?.media ?? []));
      hasNext = pageData?.pageInfo?.hasNextPage ?? false;
      page += 1;
    }

    // Save/replace cache
    await prisma.$executeRawUnsafe(
      `INSERT OR REPLACE INTO "SeasonCache" (season, year, format, data, updatedAt)
       VALUES (?, ?, ?, ?, datetime('now'))`,
      season.toUpperCase(),
      Number(year),
      cacheKeyFormat,
      JSON.stringify(allMedia)
    );

    memory.set(memKey, allMedia);

    res.json(allMedia);
  } catch (error) {
    console.error('AniList API error', error);
    res.status(500).json({ error: 'Failed to fetch data from AniList' });
  }
});

export default router;
