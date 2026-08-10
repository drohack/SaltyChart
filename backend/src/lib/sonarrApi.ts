import axios, { AxiosInstance } from 'axios';
import prisma from '../db';

// ---------------------------------------------------------------------------
// Read-only Sonarr client.
//
// SaltyChart publishes a Custom List and Sonarr pulls it; we never push. This
// module exists so the admin page can answer "what did Sonarr actually do with
// it" - what it holds, what it excludes, which series carry our tag.
//
// **There are deliberately no write verbs here.** No addSeries, no
// deleteSeries, no addExclusion. Read-only is enforced by absence rather than
// by discipline: a later contributor cannot casually reach for a delete that
// was already sitting in the module. Cleanup belongs to Maintainerr, which
// reads Tautulli watch data we do not have; two systems that can both delete,
// neither knowing why the other did, is a bad place to end up. If a future pass
// genuinely needs to write, that should be its own decision with its own
// review.
//
// **The API key never reaches a browser.** Same rule as the Jellyfin key, and
// the same trap: an axios error carries its request `config`, so logging the
// error object prints the `X-Api-Key` header into the backend log. Log
// `sonarrErrorInfo(err)`, never `err`.
// ---------------------------------------------------------------------------

export interface SonarrConfig {
  url: string;
  apiKey: string;
  /** The tag Sonarr applies to series added from our list. See `TAG_DEFAULT`. */
  tag: string;
}

/**
 * The tag an admin is expected to set on the import list in Sonarr.
 *
 * It is what lets Maintainerr scope its cleanup to series *we* auto-added
 * rather than the whole library. Tags are a property of the import list's
 * configuration, not of the payload we serve, so this string has to be typed
 * into Sonarr by hand and can be typo'd - which fails silently by scoping
 * Maintainerr to nothing. `/report` counts how many held series actually carry
 * it so the typo is visible.
 */
export const TAG_DEFAULT = 'saltychart';

/** One series as Sonarr reports it. Only the fields we actually read. */
export interface SonarrSeries {
  id: number;
  title: string;
  tvdbId: number;
  /** Tag ids, not labels - resolve them through `sonarrTags()`. */
  tags: number[];
  added?: string;
}

export interface SonarrExclusion {
  tvdbId: number;
  title?: string;
}

export interface SonarrTag {
  id: number;
  label: string;
}

/**
 * The result of one attempt to read Sonarr's library.
 *
 * `ok: false` means "we could not ask", which is a different thing from "the
 * library is empty" and must never be collapsed into it - see `reconcileSeen`
 * in `lib/sonarrSeen.ts`, where treating one as the other would suppress the
 * entire list permanently. Never throws, so a caller cannot forget to handle
 * the failure.
 */
export interface SonarrSnapshot {
  ok: boolean;
  series: SonarrSeries[];
  error?: string;
}

// undefined = not loaded yet; null = not configured. Mirrors getJellyfinConfig.
let _configCache: SonarrConfig | null | undefined;

export async function getSonarrConfig(): Promise<SonarrConfig | null> {
  if (_configCache !== undefined) return _configCache;
  const rows = await prisma.appConfig.findMany({
    where: { key: { in: ['sonarrUrl', 'sonarrApiKey', 'sonarrTag'] } },
  });
  const url = (rows.find((r) => r.key === 'sonarrUrl')?.value ?? '').replace(/\/+$/, '');
  const apiKey = rows.find((r) => r.key === 'sonarrApiKey')?.value ?? '';
  const tag = rows.find((r) => r.key === 'sonarrTag')?.value || TAG_DEFAULT;
  _configCache = url && apiKey ? { url, apiKey, tag } : null;
  return _configCache;
}

/** Call after any write to the sonarr* AppConfig keys, or the cache goes stale. */
export function clearSonarrConfigCache(): void {
  _configCache = undefined;
}

/**
 * A loggable one-line description of a failure, with no credential in it.
 *
 * The Jellyfin key left the building through `console.warn('...', err)` once,
 * because an axios error carries the request headers that produced it. Same
 * shape, same reason.
 */
export function sonarrErrorInfo(err: any): string {
  const status = err?.response?.status;
  const parts = [err?.code, status ? `HTTP ${status}` : null, err?.message].filter(Boolean);
  return parts.length ? parts.join(' ') : String(err);
}

/**
 * Admin-path only, so the timeout is generous: this deployment's Sonarr holds
 * a few thousand series and `/series` returns all of them in one response.
 * Nothing here is ever on a viewer's request path.
 */
function sonarrAxios(cfg: SonarrConfig): AxiosInstance {
  return axios.create({
    baseURL: cfg.url,
    timeout: 15_000,
    headers: { 'X-Api-Key': cfg.apiKey, Accept: 'application/json' },
  });
}

/**
 * Sonarr's whole series library.
 *
 * Returns a `SonarrSnapshot` rather than throwing, because every caller has to
 * distinguish "could not ask" from "nothing there" and an exception makes that
 * easy to get wrong.
 */
export async function fetchSnapshot(cfg: SonarrConfig): Promise<SonarrSnapshot> {
  try {
    const { data } = await sonarrAxios(cfg).get('/api/v3/series');
    if (!Array.isArray(data)) {
      return { ok: false, series: [], error: `expected an array, got ${typeof data}` };
    }
    const series: SonarrSeries[] = [];
    for (const s of data) {
      const tvdbId = Number(s?.tvdbId);
      if (!Number.isInteger(tvdbId) || tvdbId <= 0) continue;
      series.push({
        id: Number(s?.id) || 0,
        title: typeof s?.title === 'string' ? s.title : '',
        tvdbId,
        tags: Array.isArray(s?.tags) ? s.tags.filter((t: unknown) => typeof t === 'number') : [],
        added: typeof s?.added === 'string' ? s.added : undefined,
      });
    }
    return { ok: true, series };
  } catch (err) {
    return { ok: false, series: [], error: sonarrErrorInfo(err) };
  }
}

/**
 * The Import List Exclusions Sonarr itself enforces.
 *
 * This is the authoritative "never add this" - it is global across every import
 * list and it beats anything we do. Our own suppression is a backstop for the
 * case where a deletion did not set one.
 */
export async function sonarrExclusions(cfg: SonarrConfig): Promise<SonarrExclusion[] | null> {
  try {
    const { data } = await sonarrAxios(cfg).get('/api/v3/importlistexclusion');
    if (!Array.isArray(data)) return null;
    return data
      .map((e: any) => ({ tvdbId: Number(e?.tvdbId), title: e?.title }))
      .filter((e) => Number.isInteger(e.tvdbId) && e.tvdbId > 0);
  } catch (err) {
    console.warn('[sonarr] could not read exclusions:', sonarrErrorInfo(err));
    return null;
  }
}

/** Tag id -> label, so a held series' numeric tags can be matched to `cfg.tag`. */
export async function sonarrTags(cfg: SonarrConfig): Promise<SonarrTag[] | null> {
  try {
    const { data } = await sonarrAxios(cfg).get('/api/v3/tag');
    if (!Array.isArray(data)) return null;
    return data
      .map((t: any) => ({ id: Number(t?.id), label: String(t?.label ?? '') }))
      .filter((t) => Number.isInteger(t.id));
  } catch (err) {
    console.warn('[sonarr] could not read tags:', sonarrErrorInfo(err));
    return null;
  }
}

/**
 * Authenticated reachability probe, for the admin Test button.
 *
 * Hits `/system/status`, which requires the key - so a green result proves the
 * key works rather than merely that something answered on the port.
 */
export async function testSonarr(
  cfg: SonarrConfig
): Promise<{ ok: boolean; version?: string; error?: string }> {
  try {
    const { data } = await sonarrAxios(cfg).get('/api/v3/system/status');
    return { ok: true, version: typeof data?.version === 'string' ? data.version : undefined };
  } catch (err) {
    return { ok: false, error: sonarrErrorInfo(err) };
  }
}
