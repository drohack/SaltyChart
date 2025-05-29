import { GraphQLClient } from 'graphql-request';

const API_URL = process.env.ANILIST_API_URL ?? 'https://graphql.anilist.co';

export const client = new GraphQLClient(API_URL, {
  headers: {
    'Content-Type': 'application/json'
  }
});

export interface Media {
  id: number;
  title: {
    romaji?: string;
    english?: string;
    native?: string;
  };
  coverImage: {
    large: string;
    color?: string;
  };
  season?: string;
  seasonYear?: number;
  description?: string;
  isAdult?: boolean;
  trailer?: {
    id?: string;
    site?: string;
  };
  relations?: {
    nodes: { id: number; type: string }[];
  };
}

export interface PageData {
  Page: {
    media: Media[];
  };
}

export async function fetchSeason(season: string, seasonYear: number): Promise<Media[]> {
  const query = /* GraphQL */ `
    query ($page: Int = 1, $perPage: Int = 50, $season: MediaSeason, $seasonYear: Int) {
      Page(page: $page, perPage: $perPage) {
        media(season: $season, seasonYear: $seasonYear, type: ANIME, format_not: MUSIC) {
          id
          title {
            romaji
            english
            native
          }
          coverImage {
            large
            color
          }
          season
          seasonYear
          description(asHtml: false)
          relations {
            nodes {
              id
              type
            }
          }
          trailer {
            id
            site
          }
          isAdult
        }
      }
    }
  `;

  const variables = {
    season: season.toUpperCase(),
    seasonYear
  } as Record<string, string | number>;

  const data = await client.request<PageData>(query, variables);
  return data.Page.media;
}
