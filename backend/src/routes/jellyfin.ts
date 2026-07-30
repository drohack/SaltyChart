import { Router, Response, NextFunction } from 'express';
import express from 'express';
import axios, { AxiosInstance } from 'axios';
import rateLimit from 'express-rate-limit';
import prisma from '../db';
import { requireAuth, AuthRequest } from '../middleware/auth';

// ---------------------------------------------------------------------------
// /api/jellyfin — Jellyfin server configuration.
//
// Currently config only: the admin stores a server URL + API key on the /admin
// page (AppConfig keys `jellyfinUrl` / `jellyfinApiKey`) so the connection can
// be set up and verified. The API key NEVER reaches a browser — the same rule
// as the Plex token: reads return only `apiKeySet`.
//
// Why this exists: Plex has no endpoint that serves an embedded subtitle track
// (`/library/streams/{id}` → 501, and its HLS carries no subtitle renditions),
// which is why SaltyChart extracts subtitles by reading whole episode files.
// Jellyfin does expose subtitles as a first-class API, so having the
// connection configured lets that be measured against the real library.
// ---------------------------------------------------------------------------

const router = Router();
router.use(express.json());

const ADMIN_USER_ID = parseInt(process.env.ADMIN_USER_ID || '1', 10);
const _isDev = process.env.NODE_ENV === 'development' || !process.env.NODE_ENV;

const jellyfinLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  message: { error: 'Too many requests, please slow down.', code: 'RATE_LIMITED' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => _isDev,
});

function requireAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  if (req.userId !== ADMIN_USER_ID) {
    return res.status(403).json({ error: 'Admin access required', code: 'ADMIN_REQUIRED' });
  }
  return next();
}

export interface JellyfinConfig {
  url: string; // no trailing slash
  apiKey: string;
}

// undefined = not loaded yet; null = not configured
let _configCache: JellyfinConfig | null | undefined;

export async function getJellyfinConfig(): Promise<JellyfinConfig | null> {
  if (_configCache !== undefined) return _configCache;
  const rows = await prisma.appConfig.findMany({
    where: { key: { in: ['jellyfinUrl', 'jellyfinApiKey'] } },
  });
  const url = (rows.find((r) => r.key === 'jellyfinUrl')?.value ?? '').replace(/\/+$/, '');
  const apiKey = rows.find((r) => r.key === 'jellyfinApiKey')?.value ?? '';
  _configCache = url && apiKey ? { url, apiKey } : null;
  return _configCache;
}

/**
 * Jellyfin accepts the API key as an Authorization header; keeping it out of
 * the URL means it can't leak through logs or error messages the way a query
 * parameter does.
 */
export function jellyfinAxios(cfg: JellyfinConfig): AxiosInstance {
  return axios.create({
    baseURL: cfg.url,
    timeout: 8000,
    headers: {
      Authorization: `MediaBrowser Token="${cfg.apiKey}", Client="SaltyChart", Device="Web", DeviceId="saltychart", Version="1.0"`,
      Accept: 'application/json',
    },
  });
}

// Admin: read config — the URL only; the key is never sent back.
router.get('/config', jellyfinLimiter, requireAuth, requireAdmin, async (_req, res) => {
  const rows = await prisma.appConfig.findMany({
    where: { key: { in: ['jellyfinUrl', 'jellyfinApiKey'] } },
  });
  res.json({
    url: rows.find((r) => r.key === 'jellyfinUrl')?.value ?? '',
    apiKeySet: !!rows.find((r) => r.key === 'jellyfinApiKey')?.value,
  });
});

// Admin: save config. An empty/absent key keeps the stored one so the admin
// can edit the URL without re-pasting the key.
router.put('/config', jellyfinLimiter, requireAuth, requireAdmin, async (req, res) => {
  const { url, apiKey } = req.body ?? {};
  if (typeof url !== 'string' || (apiKey !== undefined && typeof apiKey !== 'string')) {
    return res
      .status(400)
      .json({ error: 'Expected { url: string, apiKey?: string }', code: 'BAD_REQUEST' });
  }
  const cleanUrl = url.trim().replace(/\/+$/, '');
  if (cleanUrl && !/^https?:\/\//i.test(cleanUrl)) {
    return res
      .status(400)
      .json({ error: 'URL must start with http:// or https://', code: 'BAD_REQUEST' });
  }
  await prisma.appConfig.upsert({
    where: { key: 'jellyfinUrl' },
    update: { value: cleanUrl },
    create: { key: 'jellyfinUrl', value: cleanUrl },
  });
  if (typeof apiKey === 'string' && apiKey.trim()) {
    await prisma.appConfig.upsert({
      where: { key: 'jellyfinApiKey' },
      update: { value: apiKey.trim() },
      create: { key: 'jellyfinApiKey', value: apiKey.trim() },
    });
  }
  _configCache = undefined;
  res.json({ ok: true });
});

// Admin: test a connection. Uses supplied values when given, falling back to
// stored ones — so the admin can test before saving. Always 200; failures are
// reported in-body for inline display.
router.post('/config/test', jellyfinLimiter, requireAuth, requireAdmin, async (req, res) => {
  const { url, apiKey } = req.body ?? {};
  const rows = await prisma.appConfig.findMany({
    where: { key: { in: ['jellyfinUrl', 'jellyfinApiKey'] } },
  });
  const stored = {
    url: rows.find((r) => r.key === 'jellyfinUrl')?.value ?? '',
    apiKey: rows.find((r) => r.key === 'jellyfinApiKey')?.value ?? '',
  };
  const testUrl = (typeof url === 'string' && url.trim() ? url.trim() : stored.url).replace(
    /\/+$/,
    ''
  );
  const testKey = typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : stored.apiKey;
  if (!testUrl || !testKey) {
    return res.json({ ok: false, error: 'Both a server URL and an API key are required.' });
  }

  try {
    const ax = jellyfinAxios({ url: testUrl, apiKey: testKey });
    // /System/Info needs authentication, so a 200 here proves the key works —
    // unlike /System/Info/Public, which any unauthenticated caller can read.
    const info = await ax.get('/System/Info');
    const serverName = info.data?.ServerName;
    if (!serverName) {
      return res.json({ ok: false, error: 'Reached the server but it did not look like Jellyfin.' });
    }
    const folders = await ax.get('/Library/VirtualFolders');
    const libraries = (folders.data ?? []).map((f: any) => ({
      title: String(f.Name ?? ''),
      type: String(f.CollectionType ?? ''),
    }));
    res.json({
      ok: true,
      serverName: String(serverName),
      version: String(info.data?.Version ?? ''),
      libraries,
    });
  } catch (err: any) {
    const status = err?.response?.status;
    const hint =
      status === 401
        ? 'Jellyfin rejected the API key (401). Create one under Dashboard → API Keys.'
        : err?.code === 'ECONNREFUSED'
        ? 'Connection refused — check the URL and port (Jellyfin defaults to 8096).'
        : err?.message ?? 'Unknown error';
    res.json({ ok: false, error: hint });
  }
});

export default router;
