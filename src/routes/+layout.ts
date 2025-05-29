import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals }) => {
  return {
    isLoggedIn: Boolean(locals.token?.access_token),
  };
};
