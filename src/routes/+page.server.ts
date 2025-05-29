import { currentSeason } from '$lib/utils';
import { redirect } from '@sveltejs/kit';

export const load = () => {
  const year = new Date().getFullYear();
  const season = currentSeason();
  throw redirect(307, `/${year}/${season}`);
};
