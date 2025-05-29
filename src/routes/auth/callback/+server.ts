import type { RequestHandler } from '@sveltejs/kit';
import { serialize } from 'cookie';
import type { OAuthToken } from '$lib/types';

export const GET: RequestHandler = async ({ url }) => {
  const code = url.searchParams.get('code');
  if (!code) {
    return new Response('Missing code', { status: 400 });
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: process.env.ANILIST_CLIENT_ID ?? '',
    client_secret: process.env.ANILIST_CLIENT_SECRET ?? '',
    redirect_uri: process.env.ANILIST_REDIRECT_URI ?? '',
    code,
  });

  const tokenRes = await fetch('https://anilist.co/api/v2/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    return new Response(`Token exchange failed: ${text}`, { status: 500 });
  }

  const tokenData = (await tokenRes.json()) as OAuthToken;

  const cookie = serialize('anilist_token', JSON.stringify(tokenData), {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: tokenData.expires_in,
  });

  return new Response(null, {
    status: 302,
    headers: {
      location: '/',
      'set-cookie': cookie,
    },
  });
};
