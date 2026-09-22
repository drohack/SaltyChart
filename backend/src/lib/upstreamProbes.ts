/**
 * The probes: one cheap, read-only call per service, so a service nobody has
 * used today still reports.
 *
 * THE RULE THAT MATTERS: **a probe goes through our own client**, never a
 * hand-rolled request to the same URL. skyhook's outage was our axios instance
 * being rejected for its `User-Agent` while `curl` to the identical URL
 * returned 200 - a probe that built its own request would have reported green
 * throughout. This is the repo's standing "a diagnostic that doesn't send what
 * the real caller sends measures a program you don't ship" rule, and this file
 * is the place it is easiest to get wrong.
 *
 * YouTube alone is `passiveOnly`: its failure mode IS request volume, so a
 * synthetic probe risks deepening the bot wall it exists to detect. Its record
 * comes from real traffic. Everything else is probed - including AniList, which
 * was passive at first on the theory that a probe would compete with its shared
 * ~30/min budget. One request a day is 0.002% of that budget, and AniList is
 * called ONLY from the /api/anime route, so without a probe a quiet server
 * would never check it at all.
 *
 * `skipped` is not a failure. A Sonarr with no URL saved is a deliberate state,
 * and recording it as an outage would train the reader to ignore the page.
 */
import prisma from '../db';
import { getSystemApi } from '@jellyfin/sdk/lib/utils/api/system-api';
import { getItemLookupApi } from '@jellyfin/sdk/lib/utils/api/item-lookup-api';
import { jellyfinApi } from './jellyfinApi';
import { getJellyfinConfig } from '../routes/jellyfin';
import { getSonarrConfig, testSonarr } from './sonarrApi';
import { skyhookSearch } from './skyhookIdentity';
import { pingAniList } from '../routes/anime';
import { getMailer, type Mailer } from './mailer';
import {
  CONFIRM_RETRY_MS,
  EMPTY_RECORD,
  UPSTREAMS,
  readAll,
  recordSkip,
  recordUpstream,
  type ProbeResult,
  type UpstreamRecord,
  type UpstreamSpec,
} from './upstreamHealth';

/** Pull a status code out of whatever the client threw. */
function statusOf(err: any): number | undefined {
  return err?.response?.status ?? err?.status ?? undefined;
}

function reasonOf(err: any): string {
  return String(err?.response?.status ? `HTTP ${err.response.status}` : err?.code ?? err?.message ?? err).slice(0, 300);
}

/**
 * A term skyhook has always matched. Chosen deliberately: an empty result for a
 * well-known series means our request was rejected or the index is broken, and
 * that is the failure we need to see. `skyhookSearch` (not `skyhookShow`) -
 * shows are memoised for the process lifetime, so a repeat show probe would be
 * answered from cache and test nothing.
 */
const SKYHOOK_PROBE_TERM = 'Frieren';

/** How stale the id map may get before the refresh is considered broken. It is
 *  refreshed daily, so two days means two missed runs, not one slow one. */
export const MAP_STALE_MS = 2 * 24 * 3600 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When was the id map last fetched?
 *
 * `AppConfig.anilistTvdbMapAt` stores **epoch milliseconds as a string**
 * (`'1789925873565'`), not an ISO timestamp - `Date.parse` on it yields NaN.
 * The first version of this probe did exactly that and therefore reported "the
 * map has never been fetched" on a server whose map was minutes old. Caught by
 * reading the probe's own output instead of trusting a passing test, which is
 * the same rule this whole feature exists to serve.
 *
 * Accepts both shapes, so a future change of format cannot silently re-break it.
 */
export function parseFetchedAt(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const ms = Number(trimmed);
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export const PROBES: Record<string, () => Promise<ProbeResult>> = {
  async skyhook() {
    try {
      const results = await skyhookSearch(SKYHOOK_PROBE_TERM);
      if (results.length === 0) {
        return { ok: false, reason: `search for "${SKYHOOK_PROBE_TERM}" returned nothing - the client is being refused, or the index is empty` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: reasonOf(err), status: statusOf(err) };
    }
  },

  async anilist() {
    const res = await pingAniList();
    return res.skipped ? { ok: true, skipped: res.skipped } : res;
  },

  async jellyfin() {
    const cfg = await getJellyfinConfig();
    if (!cfg) return { ok: true, skipped: 'no Jellyfin server configured' };
    try {
      const api = await jellyfinApi(cfg);
      await getSystemApi(api).getSystemInfo();
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: reasonOf(err), status: statusOf(err) };
    }
  },

  async tmdb() {
    // TMDB is reached THROUGH Jellyfin's remote search, so this is graded
    // separately from Jellyfin itself on purpose: "Jellyfin is up but its TMDB
    // provider is failing" is the single blindest failure in the codebase
    // (`remoteIdentity.searchOne` swallowed it with no log at all).
    const cfg = await getJellyfinConfig();
    if (!cfg) return { ok: true, skipped: 'no Jellyfin server configured' };
    try {
      const api = await jellyfinApi(cfg);
      // The SAME request shape `remoteIdentity.searchOne` sends, field for
      // field, including IncludeDisabledProviders - a probe that sends
      // something else grades a program we do not ship.
      const { data } = await getItemLookupApi(api).getSeriesRemoteSearchResults(
        { seriesInfoRemoteSearchQuery: { SearchInfo: { Name: 'Frieren' }, IncludeDisabledProviders: true } },
        { timeout: 30_000 },
      );
      if (!Array.isArray(data) || data.length === 0) {
        return { ok: false, reason: 'Jellyfin answered, but its remote search returned nothing - the metadata provider is not responding' };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: reasonOf(err), status: statusOf(err) };
    }
  },

  async sonarr() {
    const cfg = await getSonarrConfig();
    if (!cfg) return { ok: true, skipped: 'no Sonarr server configured' };
    const res = await testSonarr(cfg);
    return res.ok ? { ok: true } : { ok: false, reason: String(res.error ?? 'Sonarr did not answer').slice(0, 300) };
  },

  async animeIdMap() {
    // No request of its own: the daily refresh already records its own success
    // by stamping this key, so the honest check is whether that stamp is moving.
    try {
      const row = await prisma.appConfig.findUnique({ where: { key: 'anilistTvdbMapAt' } });
      const at = parseFetchedAt(row?.value);
      if (at === null) return { ok: true, skipped: 'the map has never been fetched on this server' };
      const age = Date.now() - at;
      if (age > MAP_STALE_MS) {
        return { ok: false, reason: `last successful refresh was ${Math.round(age / 3600000)}h ago; it should run daily` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: reasonOf(err) };
    }
  },

  async smtp() {
    const mailer = getMailer() as Mailer & { verify?: () => Promise<void> };
    if (!mailer.configured()) return { ok: true, skipped: 'SMTP is not configured' };
    if (typeof mailer.verify !== 'function') {
      // Honest rather than green: we could not check, so say so.
      return { ok: true, skipped: 'this mailer cannot be verified' };
    }
    try {
      await mailer.verify();
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: reasonOf(err), status: statusOf(err) };
    }
  },
};

/**
 * Is this service due a probe?
 *
 * The two intervals are the whole "probe daily, confirm fast" design:
 *  - healthy -> its own `minProbeIntervalMs`, which for a third-party API is a
 *    day, because that is the rate at which an API actually changes.
 *  - already failing -> `CONFIRM_RETRY_MS`, minutes, so a real breakage is
 *    confirmed and mailed the same hour instead of taking `brokenAfter` days.
 * Pure, so both halves are testable without a clock or a network.
 */
export function probeDue(
  spec: UpstreamSpec,
  rec: UpstreamRecord,
  now: number,
  force = false,
): boolean {
  if (spec.passiveOnly) return false;
  if (force) return true;
  if (!rec.lastCheckedAt) return true;
  const since = now - Date.parse(rec.lastCheckedAt);
  if (!Number.isFinite(since)) return true;
  const wait = rec.consecutiveFailures > 0 ? CONFIRM_RETRY_MS : (spec.minProbeIntervalMs ?? DAY_MS);
  return since >= wait;
}

/**
 * Run whatever is due and record it. Returns a one-line summary for the log.
 *
 * Returns a summary rather than logging one. The CALLER decides whether a
 * firing is worth a line - `index.ts` suppresses the no-op case behind a
 * six-hour heartbeat, because "silent unless it acts is indistinguishable from
 * never ran" is right for a daily job and inverts at quarter-hourly cadence,
 * where it printed four lines an hour and buried the identity sweep - the same rule the Sonarr
 * push and the yt-dlp updater already follow.
 */
export async function runDueProbes(force = false): Promise<string> {
  const now = Date.now();
  const records = await readAll();
  let ran = 0;
  let failed = 0;
  let skipped = 0;
  const notDue: string[] = [];

  for (const spec of UPSTREAMS) {
    const probe = PROBES[spec.id];
    if (!probe) continue;
    const rec = records[spec.id] ?? { ...EMPTY_RECORD };
    if (!probeDue(spec, rec, now, force)) {
      notDue.push(spec.id);
      continue;
    }
    let res: ProbeResult;
    try {
      res = await probe();
    } catch (err) {
      // A probe that throws is itself a failure signal, not a crash.
      res = { ok: false, reason: reasonOf(err), status: statusOf(err) };
    }
    ran++;
    if (res.skipped) {
      skipped++;
      await recordSkip(spec.id, res.skipped);
      continue;
    }
    if (!res.ok) failed++;
    await recordUpstream(spec.id, res.ok, { reason: res.reason, status: res.status ?? null });
  }

  return `[upstream] probes: ${ran} run, ${failed} failing, ${skipped} not configured` +
    (notDue.length ? `, ${notDue.length} not due (${notDue.join(', ')})` : '');
}

/** Every service that declares a probe interval must have one implemented. */
export function missingProbes(): string[] {
  return UPSTREAMS.filter((u) => !u.passiveOnly && !PROBES[u.id]).map((u) => u.id);
}

/** Probes defined for services that are not in the registry at all. */
export function orphanProbes(): string[] {
  const ids = new Set(UPSTREAMS.map((u) => u.id));
  return Object.keys(PROBES).filter((id) => !ids.has(id));
}
