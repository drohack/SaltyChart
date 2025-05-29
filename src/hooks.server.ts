import type { Handle } from '@sveltejs/kit';
import { parse } from 'cookie';

export const handle: Handle = async ({ event, resolve }) => {
  const cookieHeader = event.request.headers.get('cookie') || '';
  const cookies = parse(cookieHeader);

  if (cookies['anilist_token']) {
    try {
      const stored = JSON.parse(cookies['anilist_token']);
      event.locals.token = stored;
    } catch {
      // ignore invalid cookie
    }
  }

  return resolve(event);
};
