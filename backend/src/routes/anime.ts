import { Router } from 'express';
import axios from 'axios';

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

  const query = /* GraphQL */ `
    query ($season: MediaSeason, $seasonYear: Int, $format: MediaFormat) {
      Page(perPage: 100) {
        media(season: $season, seasonYear: $seasonYear, type: ANIME, format: $format) {
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
    const response = await axios.post(
      'https://graphql.anilist.co',
      {
        query,
        variables: {
          season: season.toUpperCase(),
          seasonYear: Number(year),
          format: format ? format.toUpperCase() : null
        }
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      }
    );

    const media = response.data?.data?.Page?.media ?? [];

    res.json(media);
  } catch (error) {
    console.error('AniList API error', error);
    res.status(500).json({ error: 'Failed to fetch data from AniList' });
  }
});

export default router;
