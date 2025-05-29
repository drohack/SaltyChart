export interface OAuthToken {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token?: string;
}

export interface MediaEntry {
  id: number;
  title: {
    romaji: string;
    english: string | null;
    native: string | null;
  };
  coverImage: {
    large: string;
    medium: string;
    color: string | null;
  };
  description: string | null;
  trailer: {
    id: string;
    site: string;
  } | null;
  seasonYear: number;
  season: 'SPRING' | 'SUMMER' | 'FALL' | 'WINTER';
  relations?: {
    edges: {
      relationType: string;
    }[];
  };
}
