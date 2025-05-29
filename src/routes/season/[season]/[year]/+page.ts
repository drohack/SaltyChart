import type { PageLoad } from './$types';
import { fetchSeason } from '$lib/api/anilist';

export const load: PageLoad = async ({ params }) => {
  const season = params.season;
  const year = Number(params.year);

  const anime = await fetchSeason(season, year);

  return { season, year, anime };
};
