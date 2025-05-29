import { Router } from 'express';
import axios from 'axios';

const router = Router();

interface SeasonQuery {
  season?: string;
  year?: string;
}

router.get('/', async (req, res) => {
  const { season, year } = req.query as SeasonQuery;

  if (!season || !year) {
    return res.status(400).json({ error: 'Missing "season" or "year" query param' });
  }

  const query = /* GraphQL */ `
    query ($season: MediaSeason, $seasonYear: Int) {
      Page(perPage: 50) {
        media(season: $season, seasonYear: $seasonYear, type: ANIME) {
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
          seasonYear: Number(year)
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
