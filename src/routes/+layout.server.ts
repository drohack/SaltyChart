import type { LayoutServerLoad } from './$types';

// Expose `isLoggedIn` boolean to the rest of the app. Because we rely on
// `locals`, this load function must run **only on the server** — hence the
// `.server.ts` suffix.  In a browser context `locals` is undefined.

export const load: LayoutServerLoad = async ({ locals }) => {
  return {
    isLoggedIn: Boolean(locals?.token?.access_token)
  };
};
