import { redirect, type RequestHandler } from '@sveltejs/kit';

export const GET: RequestHandler = async () => {
  const CLIENT_ID = process.env.ANILIST_CLIENT_ID;
  const REDIRECT_URI = process.env.ANILIST_REDIRECT_URI;

  if (!CLIENT_ID || !REDIRECT_URI) {
    return new Response('OAuth not configured', { status: 500 });
  }

  const url = new URL('https://anilist.co/api/v2/oauth/authorize');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('response_type', 'code');

  throw redirect(302, url.toString());
};
