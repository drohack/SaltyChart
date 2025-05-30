import { Router } from 'express';
import axios from 'axios';
import { setTimeout as delay } from 'timers/promises';

const router = Router();

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

    res.json(allMedia);
  } catch (error) {
    console.error('AniList API error', error);
    res.status(500).json({ error: 'Failed to fetch data from AniList' });
  }
});

export default router;
