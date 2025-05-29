import type { RequestHandler } from '@sveltejs/kit';
import { serialize } from 'cookie';

export const GET: RequestHandler = async () => {
  const cookie = serialize('anilist_token', '', {
    path: '/',
    maxAge: 0,
  });

  return new Response(null, {
    status: 302,
    headers: {
      location: '/',
      'set-cookie': cookie,
    },
  });
};
