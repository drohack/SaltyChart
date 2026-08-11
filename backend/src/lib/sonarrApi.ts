import axios, { AxiosInstance } from 'axios';
import prisma from '../db';

// ---------------------------------------------------------------------------
// Sonarr client: every read we need, and exactly one write.
//
// SaltyChart adds a new seasonal series to Sonarr once, with
// `POST /api/v3/series`, and then never speaks about it again. An earlier design
// served a Custom List for Sonarr to poll; that was replaced because a Custom
// List is a *declarative set* ("everything here should exist") and re-added
// anything deleted from it within ~5 minutes, forever. `lib/sonarrPush.ts` has
// the argument in full.
//
// **`addSeries` is the only write verb, and the list below is a boundary, not a
// backlog.** There is no deleteSeries, no updateSeries, no addExclusion, no tag
// creation. Adding is what this feature is *for*; removing is Maintainerr's job,
// and it decides using Tautulli watch data we do not have. Two systems that can
// both delete, neither knowing why the other did, is a bad place to end up. A
// second write verb should be its own decision with its own review, not
// something appended because the module already writes.
//
// **The API key never reaches a browser.** Same rule as the Jellyfin key, and
// the same trap: an axios error carries its request `config`, so logging the
// error object prints the `X-Api-Key` header into the backend log. Log
// `sonarrErrorInfo(err)`, never `err`.
// ---------------------------------------------------------------------------

export interface SonarrConfig {
  url: string;
  apiKey: string;
  /** Labels applied to every series we add. See `TAGS_DEFAULT`. */
  tags: string[];
  /**
   * The one label that means **we added this**. Always present in `tags`.
   *
   * Separate from the rest because the rest are shared: `anime` is a library
   * convention and sits on 692 series here, so "is it tagged?" answered yes for
   * shows the owner had for years. Only this one is ours.
   */
  markerTag: string;
  /** Where added series live, e.g. `/media/Anime`. Must match a Sonarr root folder exactly. */
  rootFolderPath: string;
  qualityProfileId: number;
  /** `standard` or `anime` - this changes how releases are matched to episodes. */
  seriesType: string;
  seasonFolder: boolean;
}

/**
 * The label that marks a series as ours.
 *
 * **This is a second, independent record of what we added**, and that is the
 * point of it: `SonarrPush` lives in one database, and a database does not
 * follow you from dev to production or survive being restored from an old
 * backup. The tag lives in Sonarr, beside the series it describes, so "did we
 * add this?" stays answerable when the row is gone.
 */
export const MARKER_TAG_DEFAULT = 'saltychart';

/**
 * Labels applied to every series we add.
 *
 * `anime` matches the surrounding library's own convention; the marker above is
 * what Maintainerr scopes cleanup on. **All of them must already exist in
 * Sonarr** - we resolve labels to ids with `sonarrTags()` and refuse to push if
 * any is missing, because creating them would mean a second write verb and an
 * untagged add is invisible to Maintainerr's scoping, which fails silently.
 */
export const TAGS_DEFAULT = ['anime', MARKER_TAG_DEFAULT];

/**
 * What Sonarr should monitor on a newly added series.
 *
 * `firstSeason` is the whole point: Seerr refuses a request for a
 * `PARTIALLY_AVAILABLE` season, so grabbing only the pilot would break the way
 * people ask for the rest. Under a Custom List this was Sonarr's `shouldMonitor`
 * setting, typed in by hand and unverifiable from here; sending it ourselves is
 * one of the reasons the push replaced the list.
 */
export const ADD_MONITOR = 'firstSeason';

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
 * library is empty" and must never be collapsed into it - see
 * `runSonarrSnapshot`, where taking an empty read at face value would make every
 * series Sonarr already holds look like a new candidate, and the next push would
 * try to add all of them. Never throws, so a caller cannot forget to handle the
 * failure.
 */
export interface SonarrSnapshot {
  ok: boolean;
  series: SonarrSeries[];
  error?: string;
}

// undefined = not loaded yet; null = not configured. Mirrors getJellyfinConfig.
let _configCache: SonarrConfig | null | undefined;

export const SONARR_CONFIG_KEYS = [
  'sonarrUrl',
  'sonarrApiKey',
  'sonarrTags',
  'sonarrMarkerTag',
  'sonarrTag', // legacy single-label key, read as a fallback only
  'sonarrRootFolder',
  'sonarrQualityProfileId',
  'sonarrSeriesType',
  'sonarrSeasonFolder',
];

/** `"anime, saltychart"` -> `['anime', 'saltychart']`, blanks dropped. */
export function parseTagList(raw: string | null | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

/** The applied set, with the marker guaranteed present (case-insensitively). */
export function withMarker(tags: string[], marker: string): string[] {
  return tags.some((t) => t.toLowerCase() === marker.toLowerCase()) ? tags : [...tags, marker];
}

export async function getSonarrConfig(): Promise<SonarrConfig | null> {
  if (_configCache !== undefined) return _configCache;
  const rows = await prisma.appConfig.findMany({ where: { key: { in: SONARR_CONFIG_KEYS } } });
  const val = (k: string) => rows.find((r) => r.key === k)?.value ?? '';
  const url = val('sonarrUrl').replace(/\/+$/, '');
  const apiKey = val('sonarrApiKey');
  // `sonarrTag` predates multi-tag support; honour it so an upgrade does not
  // silently drop the label someone already configured.
  const tags = parseTagList(val('sonarrTags') || val('sonarrTag'));
  const markerTag = val('sonarrMarkerTag') || MARKER_TAG_DEFAULT;
  const qualityProfileId = Number(val('sonarrQualityProfileId'));
  _configCache =
    url && apiKey
      ? {
          url,
          apiKey,
          // The marker is forced into the applied set. Everything we add must
          // carry it, or the tag stops being a record of what we added - and it
          // is the only record that survives losing the database.
          tags: withMarker(tags.length ? tags : TAGS_DEFAULT, markerTag),
          markerTag,
          // Trailing slashes are stripped: Sonarr reports `/media/Anime`, and a
          // stored `/media/Anime/` would not match any root folder it offers.
          rootFolderPath: val('sonarrRootFolder').replace(/\/+$/, ''),
          qualityProfileId: Number.isInteger(qualityProfileId) ? qualityProfileId : 0,
          seriesType: val('sonarrSeriesType') || 'standard',
          seasonFolder: val('sonarrSeasonFolder') !== 'false',
        }
      : null;
  return _configCache;
}

/**
 * Is there enough configuration to actually add a series?
 *
 * Separate from `getSonarrConfig() !== null`, which only means "we can talk to
 * Sonarr". Reading works with just a URL and key; adding additionally needs a
 * destination and a quality profile, and a missing one is a setup mistake we
 * should name rather than a push that lands somewhere unintended.
 */
export function pushConfigProblems(cfg: SonarrConfig | null): string[] {
  if (!cfg) return ['Sonarr is not configured'];
  const out: string[] = [];
  if (!cfg.rootFolderPath) out.push('no root folder chosen');
  if (!cfg.qualityProfileId) out.push('no quality profile chosen');
  if (!cfg.tags.length) out.push('no tags set');
  return out;
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
 * Sonarr's own "never add this", global across every import list. It does not
 * bind `POST /api/v3/series` - an explicit add succeeds regardless - so we treat
 * it as a human's stated intent and skip anything on it. Displayed on
 * `/admin/sonarr` so a skip is explicable rather than mysterious.
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

// --- setup dropdowns -------------------------------------------------------

export interface SonarrRootFolder {
  path: string;
  freeSpace?: number;
}

export interface SonarrQualityProfile {
  id: number;
  name: string;
}

/**
 * Root folders Sonarr will accept.
 *
 * Offered as a dropdown rather than a text field on purpose: `rootFolderPath`
 * has to match one of these *exactly* or the add is rejected, and a typo in a
 * free-text path is a setup error nobody would find by reading it back.
 */
export async function sonarrRootFolders(cfg: SonarrConfig): Promise<SonarrRootFolder[] | null> {
  try {
    const { data } = await sonarrAxios(cfg).get('/api/v3/rootfolder');
    if (!Array.isArray(data)) return null;
    return data
      .map((r: any) => ({ path: String(r?.path ?? ''), freeSpace: Number(r?.freeSpace) || undefined }))
      .filter((r) => r.path);
  } catch (err) {
    console.warn('[sonarr] could not read root folders:', sonarrErrorInfo(err));
    return null;
  }
}

export async function sonarrQualityProfiles(
  cfg: SonarrConfig
): Promise<SonarrQualityProfile[] | null> {
  try {
    const { data } = await sonarrAxios(cfg).get('/api/v3/qualityprofile');
    if (!Array.isArray(data)) return null;
    return data
      .map((p: any) => ({ id: Number(p?.id), name: String(p?.name ?? '') }))
      .filter((p) => Number.isInteger(p.id));
  } catch (err) {
    console.warn('[sonarr] could not read quality profiles:', sonarrErrorInfo(err));
    return null;
  }
}

// --- the add path ----------------------------------------------------------

/**
 * Sonarr's own record for a TVDB id, or null if it does not know the id.
 *
 * **This is the validity check, and it is a read.** A null here means the TVDB
 * id we resolved is wrong or retired, which is a matching problem to surface on
 * `/admin/matching` - not something to push and let fail.
 *
 * It also supplies the object we post. Sonarr's add endpoint wants the series
 * shape it produced (title, titleSlug, images, seasons, year), and hand-building
 * that means guessing at required fields that change between versions; every
 * established client does lookup-then-post for the same reason. `null` is "not
 * found"; a thrown error is a transport failure and must not be confused with it,
 * so failures reject rather than returning null.
 */
export async function sonarrLookup(cfg: SonarrConfig, tvdbId: number): Promise<any | null> {
  const { data } = await sonarrAxios(cfg).get('/api/v3/series/lookup', {
    params: { term: `tvdb:${tvdbId}` },
  });
  if (!Array.isArray(data) || data.length === 0) return null;
  // Sonarr can answer a tvdb: term with near matches; only an exact id is us.
  return data.find((s: any) => Number(s?.tvdbId) === tvdbId) ?? null;
}

export interface AddSeriesResult {
  ok: boolean;
  /** Sonarr's own series id, on success. Stored so a human can find the row. */
  seriesId?: number;
  status?: number;
  error?: string;
  /** Sonarr's validation messages, which carry the "already exists" case. */
  body?: unknown;
}

/**
 * **The only write in this codebase's Sonarr integration.**
 *
 * Adds one series, monitoring season 1, and by default searching for nothing -
 * `searchForMissingEpisodes` is off, so episodes arrive via RSS as they air.
 * That suits upcoming seasons, where there is nothing to search for yet; an
 * already-finished series added this way sits there until someone hits Search,
 * which `/admin/sonarr` says out loud rather than leaving to be discovered.
 *
 * Never throws: the caller has to record the outcome either way, and an
 * exception is easy to forget in a loop that must not stop on one bad row.
 */
export async function addSeries(
  cfg: SonarrConfig,
  lookup: any,
  tagIds: number[],
  opts?: { searchForMissingEpisodes?: boolean }
): Promise<AddSeriesResult> {
  const payload = {
    ...lookup,
    rootFolderPath: cfg.rootFolderPath,
    qualityProfileId: cfg.qualityProfileId,
    seriesType: cfg.seriesType,
    seasonFolder: cfg.seasonFolder,
    monitored: true,
    tags: tagIds,
    addOptions: {
      monitor: ADD_MONITOR,
      searchForMissingEpisodes: opts?.searchForMissingEpisodes ?? false,
      searchForCutoffUnmetEpisodes: false,
      ignoreEpisodesWithFiles: false,
      ignoreEpisodesWithoutFiles: false,
    },
  };
  try {
    const { data } = await sonarrAxios(cfg).post('/api/v3/series', payload);
    return { ok: true, seriesId: Number(data?.id) || undefined };
  } catch (err: any) {
    return {
      ok: false,
      status: err?.response?.status,
      error: sonarrErrorInfo(err),
      body: err?.response?.data,
    };
  }
}
