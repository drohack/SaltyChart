import { GraphQLClient, gql } from 'graphql-request';
import type { MediaEntry } from '$lib/types';

const ENDPOINT = 'https://graphql.anilist.co';

export async function fetchSeasonalAnime(
  season: 'WINTER' | 'SPRING' | 'SUMMER' | 'FALL',
  year: number
): Promise<MediaEntry[]> {
  const graphQLClient = new GraphQLClient(ENDPOINT);

  const query = gql`
    query ($page: Int, $perPage: Int, $season: MediaSeason, $seasonYear: Int) {
      Page(page: $page, perPage: $perPage) {
        media(season: $season, seasonYear: $seasonYear, type: ANIME, sort: POPULARITY_DESC) {
          id
          title {
            romaji
            english
            native
          }
          coverImage {
            large
            medium
            color
          }
          description(asHtml: false)
          season
          seasonYear
          trailer {
            id
            site
          }
          relations {
            edges {
              relationType
            }
          }
        }
      }
    }
  `;

  const variables = {
    page: 1,
    perPage: 50,
    season,
    seasonYear: year,
  };

  const data = await graphQLClient.request<{
    Page: { media: MediaEntry[] };
  }>(query, variables);

  return data.Page.media;
}
