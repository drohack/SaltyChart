import { error, type PageServerLoad } from '@sveltejs/kit';
import { fetchSeasonalAnime } from '$lib/anilist';
import { capitalize, seasons } from '$lib/utils';

export const load: PageServerLoad = async ({ params }) => {
  const year = Number(params.year);
  const seasonParam = params.season.toLowerCase();

  if (!seasons.includes(seasonParam as any) || isNaN(year)) {
    throw error(404, 'Invalid season or year');
  }

  const seasonUpper = seasonParam.toUpperCase() as 'WINTER' | 'SPRING' | 'SUMMER' | 'FALL';

  const media = await fetchSeasonalAnime(seasonUpper, year);

  return {
    season: capitalize(seasonParam),
    year,
    media,
  };
};
