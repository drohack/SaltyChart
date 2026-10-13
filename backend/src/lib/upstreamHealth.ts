/**
 * Is each upstream service actually answering us?
 *
 * WHY. This app is an aggregator over services it neither controls nor
 * versions, and in one week two of them changed and broke silently. YouTube
 * stopped serving unbounded media requests, so every trailer download 403'd for
 * four weeks. skyhook began answering 400 to axios's default `User-Agent`, and
 * a bare `catch` turned every failure into an empty result *that was then
 * cached* - the whole TVDB evidence tier was dead and nothing said so.
 *
 * Different upstream causes, one bug in our code both times: a `catch` that
 * converts a failure into a plausible empty answer, so "could not ask" and
 * "there is nothing there" become the same value. This module is the place
 * where those two stop being the same value.
 *
 * SHAPE. `lib/downloadHealth.ts` already solved this for YouTube and is the
 * proven design: record what real traffic tells you, treat a *streak* as the
 * signal, log and mail exactly once at the crossing. That module keeps its own
 * store - its bot-wall hold and stale-yt-dlp hint are YouTube-specific, and its
 * hold gates are pinned by mutation rows - so this one covers everything else
 * and the status route composes both.
 *
 * The transitions here are a threshold-aware twin of that module's. They are
 * not shared code, because per-service thresholds are the whole point and
 * `downloadHealth`'s are module constants pinned by a mutation row;
 * `upstreamHealth.test.ts` pins what must still match (the streak
 * arithmetic) AND the divergence itself, so neither can drift unnoticed. They
 * no longer agree on the mail: this module needs a time window, that one
 * watches a path whose calls are minutes apart and does not. Same rule as `MODEL_RANK`.
 */
import prisma from '../db';
import { alertAdmins, ownerEmail } from './subtitleAlerts';
import { alertsEnabledFor, readAlertSettings, resolveRecipients } from './alertSettings';

export const UPSTREAM_HEALTH_KEY = 'upstreamHealth';

/** One service's record. Deliberately the same shape as `DownloadHealth` plus
 *  the two things a multi-service page needs: a status code and a check time. */
export interface UpstreamRecord {
  lastOkAt: string | null;
  lastFailAt: string | null;
  lastFailReason: string | null;
  /** HTTP status when there was one - 400 vs 403 vs 500 is how "their API
   *  changed" tells itself apart from "their server fell over". */
  lastFailStatus: number | null;
  consecutiveFailures: number;
  /**
   * When the CURRENT streak began, or null when there is none. This is what
   * "how long has it been down" is measured from - see `failingLongEnough`.
   * Records written before it existed fall back to `lastFailAt`.
   */
  failingSince: string | null;
  okCount: number;
  failCount: number;
  /** Last time we found out either way, probe or real traffic. */
  lastCheckedAt: string | null;
  /**
   * Why the last check did not happen - "no Sonarr server configured" and the
   * like. Set means the service is not set up, which is a DELIBERATE state and
   * must never render as a fault; cleared by the first real result either way.
   */
  lastSkipped: string | null;
  /**
   * When we last MAILED that this service is down, or null.
   *
   * Exists so "announce once" survives a rule that is no longer a single
   * equality: the streak and the outage window can become true in either order.
   * It is also what pairs the recovery mail to an outage we actually reported -
   * keying recovery off the streak instead would announce a recovery from an
   * outage nobody was told about.
   */
  downAlertedAt: string | null;
}

export const EMPTY_RECORD: UpstreamRecord = {
  lastOkAt: null,
  lastFailAt: null,
  lastFailReason: null,
  lastFailStatus: null,
  consecutiveFailures: 0,
  failingSince: null,
  okCount: 0,
  failCount: 0,
  lastCheckedAt: null,
  lastSkipped: null,
  downAlertedAt: null,
};

/** What a probe says. `skipped` is NOT a failure - see `UpstreamState`. */
export interface ProbeResult {
  ok: boolean;
  reason?: string;
  status?: number;
  /** Set when the service is not set up at all, e.g. no Sonarr URL saved. */
  skipped?: string;
}

export interface UpstreamSpec {
  id: string;
  label: string;
  /** What a viewer loses while this is down. Rendered on the page and mailed. */
  impact: string;
  /**
   * Consecutive failures before this counts as down. NOT sufficient on its own
   * to mail: the streak must also have lasted `outageWindowMs` - see
   * `failingLongEnough`.
   */
  brokenAfter: number;
  /**
   * How long a streak must last before it is an outage. Defaults to
   * `MIN_OUTAGE_MS`; read it through `outageWindowFor`, never directly.
   */
  outageWindowMs?: number;
  /**
   * No probe on purpose. YouTube is the only one: what breaks there is its
   * tolerance for our requests, so a synthetic probe is the wrong shape - the
   * argument is in `downloadHealth.ts`.
   */
  passiveOnly?: boolean;
  /** Skip a probe if one succeeded this recently. Rate-limited services set this high. */
  minProbeIntervalMs?: number;
  /** Where an admin goes to do something about it. */
  adminPath?: string;
  /** This service's record lives in another module; the route composes it. */
  recordSource?: 'downloadHealth';
  /** Remedy line for a specific failure, when one is known. */
  hint?: (reason: string | null, status: number | null) => string | null;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How soon to re-check a service whose probe just failed.
 *
 * WHY THIS EXISTS, and why the probe interval is not simply the alert latency:
 * third-party APIs do not break several times a day. They break on a release
 * cadence - weeks or months - so probing hourly monitors far faster than the
 * event ever occurs, and a daily probe is the honest frequency. But a daily
 * probe with a 3-failure threshold would take THREE DAYS to say anything.
 *
 * So: probe daily, confirm fast. When an API genuinely changes it fails *every*
 * call (skyhook answered 400 to 100% of ours; YouTube 403'd 100%), so two
 * confirmations minutes apart settle it - while a transient 500, of which
 * skyhook produced 25 in one sweep, clears itself and never reaches the
 * threshold. Healthy cost stays one request per service per day.
 */
export const CONFIRM_RETRY_MS = 5 * MINUTE;

/**
 * Don't re-write a healthy record more than once a minute. These hooks are on
 * real request paths (a sweep makes hundreds of skyhook calls), and each write
 * rewrites the whole blob. A failure is never coalesced, and neither is the
 * success that ends a streak.
 */
export const OK_COALESCE_MS = MINUTE;

/**
 * Every third-party surface, in one list, so a new dependency cannot be added
 * without also getting a status row. `upstreamHealth.test.ts` asserts each
 * entry is either probeable or explicitly `passiveOnly`.
 */
export const UPSTREAMS: UpstreamSpec[] = [
  {
    id: 'youtube',
    label: 'YouTube (yt-dlp)',
    impact: 'New trailers cannot be subtitled. Cached ones keep playing, which is why the site looks fine.',
    brokenAfter: 3,
    // Zero: downloadHealth owns this verdict and has no time window - its calls
    // are minutes apart, so three in a row already spans time. The composed
    // record carries no `failingSince`, and a window here would grade the badge
    // on the age of the LAST failure and paint a broken path amber.
    outageWindowMs: 0,
    passiveOnly: true,
    recordSource: 'downloadHealth',
    adminPath: '/admin/subtitles',
  },
  {
    id: 'skyhook',
    label: 'skyhook (TVDB)',
    impact: 'No TVDB ids or air dates for new entries, so matches fall back to title text and grade weak.',
    // Higher than the default 3, and the number came from being wrong once.
    // A drain tripped this at 3 and mailed "skyhook is not responding" while
    // skyhook was fine: the sweep was making hundreds of requests and skyhook
    // answered three of them 500 in a row. Measured over one evening,
    // **45 of 45 status-bearing failures were 500** and not one was a 4xx since
    // the User-Agent fix - so every failure seen so far is its server hiccuping
    // under our load, not its API changing.
    //
    // 6 costs almost nothing in detection: a genuine API change fails *every*
    // call, so under sweep load it is reached in seconds, and on an idle server
    // CONFIRM_RETRY_MS gets there in half an hour. Sporadic 500s at the observed
    // rate reach 3 regularly and 6 almost never.
    brokenAfter: 6,
    // Two hours, because a burst of 4xx is no more an outage than a burst of
    // 500s. On 2026-09-29 the 2 AM sweep got six 403s in about two seconds
    // (skyhook sits behind Cloudflare) and mailed "not responding"; the status
    // page showed it answering again within minutes. What this service's
    // failure costs is one sweep's worth of evidence, and the sweep is daily,
    // so nothing is lost by waiting - while a genuinely dead service keeps
    // failing its CONFIRM_RETRY_MS re-checks and crosses this on its own.
    outageWindowMs: 2 * HOUR,
    // Daily. A metadata API changes on a release cadence, not several times a
    // day, so this is the rate the event actually happens at; CONFIRM_RETRY_MS
    // is what keeps the alert fast once something does look wrong.
    minProbeIntervalMs: DAY,
    adminPath: '/admin/matching',
    hint: (_reason, status) =>
      status === 400
        ? 'A 400 here has meant a rejected User-Agent before, not a bad request. Check the header in lib/skyhookIdentity.ts.'
        : status === 403
          ? 'skyhook sits behind Cloudflare. A 403 has meant a block on our address before (2026-09-29), which lifted by itself.'
          : null,
  },
  {
    id: 'tmdb',
    label: 'TMDB (via Jellyfin remote search)',
    impact: 'Films and anything skyhook misses stop resolving; the identity sweep finds nothing and says nothing.',
    brokenAfter: 3,
    // Same as skyhook: only the daily sweep and admin lookups call it, in bursts.
    outageWindowMs: 2 * HOUR,
    minProbeIntervalMs: DAY,
    adminPath: '/admin/matching',
  },
  {
    id: 'anilist',
    label: 'AniList',
    impact: 'Seasons cannot refresh. Cached seasons keep serving until their rows age out.',
    // Higher: AniList answers 429 as normal operation under a shared IP budget,
    // and the existing backoff already handles that without anyone being told.
    brokenAfter: 5,
    // Cached seasons keep serving through an outage (see `impact`), and cold
    // fetches arrive as bursts of pages, so a short window catches only bursts.
    outageWindowMs: 2 * HOUR,
    // Probed daily, and the earlier decision NOT to probe it was wrong on both
    // counts. "A probe competes with the shared ~30/min budget" is 1 request
    // against ~43,200 a day - 0.002%. And "real traffic is frequent enough" is
    // false: AniList is called only from the /api/anime route, never on a
    // timer, so a quiet server would leave this row unchecked for ever. YouTube
    // stays passive because ITS failure mode is request volume; AniList's is a
    // 429 that backs off politely, which is a different thing entirely.
    minProbeIntervalMs: DAY,
  },
  {
    id: 'animeIdMap',
    label: 'AniList-to-TVDB id map (Fribb)',
    impact: 'The map stops refreshing. The cached copy keeps working, so this degrades slowly rather than breaking.',
    brokenAfter: 2,
    // Derived from the stored fetch timestamp - no request of its own - and the
    // refresh it watches runs daily, so checking more often re-reads one row
    // and learns nothing.
    minProbeIntervalMs: DAY,
  },
  {
    id: 'jellyfin',
    label: 'Jellyfin',
    impact: 'Availability and playback stop. The pop-up reports "could not ask" rather than "not in library".',
    brokenAfter: 3,
    // Frequent, unlike the third-party APIs above, because this is OUR OWN
    // infrastructure and it fails for ordinary reasons - a reboot, a stopped
    // container, a full disk - which really can happen several times in a day.
    // It is also free: one call to a box on the LAN.
    minProbeIntervalMs: 15 * MINUTE,
    adminPath: '/admin',
  },
  {
    id: 'sonarr',
    label: 'Sonarr',
    impact: 'The auto-add cannot see what is held, so it refuses to push rather than risk duplicate adds.',
    brokenAfter: 3,
    // Same reasoning as Jellyfin: our own box, ordinary failure modes, free.
    minProbeIntervalMs: 15 * MINUTE,
    adminPath: '/admin/sonarr',
  },
  {
    id: 'smtp',
    label: 'Email (SMTP)',
    impact: 'Password resets and THESE ALERTS cannot be delivered. Nothing can mail you that mail is broken.',
    brokenAfter: 2,
    minProbeIntervalMs: DAY,
    adminPath: '/admin/users',
  },
  {
    id: 'pypi',
    label: 'PyPI (yt-dlp updates)',
    impact: 'yt-dlp stops being updated and ages silently - which is exactly how the 2026-09 outage arrived.',
    brokenAfter: 2,
    passiveOnly: true,
    adminPath: '/admin/subtitles',
  },
];

export function upstreamById(id: string): UpstreamSpec | undefined {
  return UPSTREAMS.find((u) => u.id === id);
}

// --- Pure transitions --------------------------------------------------------

/**
 * The default for how long a failure streak must LAST before it is an outage.
 *
 * A streak alone is not an outage, and skyhook proved it: measured over one
 * evening it answered 66 calls and failed 16 - a 19.5% failure rate, every one
 * a 500, while working perfectly well. The resolver drains at 300 ms per call,
 * so three consecutive failures is 0.9 SECONDS. It mailed "not responding" and
 * "working again" one minute apart. Raising the threshold (3 -> 6) was tuning,
 * not fixing: six in a row is still about two seconds.
 *
 * The first fix measured the wrong clock. It asked "has anything succeeded in
 * the last ten minutes?", which catches a burst right AFTER a success and
 * nothing else: a service probed daily has a last success hours old on an idle
 * server, so the condition was already true before the first failure arrived,
 * and on 2026-09-29 six 403s in two seconds mailed an outage that cleared
 * within minutes. Duration is now measured from the START OF THE STREAK
 * (`failingSince`), which a success resets - so "failing for ten minutes" also
 * implies "nothing has worked for ten minutes", and the old rule is a special
 * case of this one.
 *
 * Ten minutes suits our own boxes; services the sweep hammers set a longer
 * `outageWindowMs`. A probed service is re-checked every CONFIRM_RETRY_MS while
 * failing, so a genuinely dead one keeps recording failures and crosses.
 */
export const MIN_OUTAGE_MS = 10 * 60_000;

/** The one place a spec's window is read, so no caller can forget the default. */
export function outageWindowFor(spec: Pick<UpstreamSpec, 'outageWindowMs'>): number {
  return spec.outageWindowMs ?? MIN_OUTAGE_MS;
}

/**
 * When did the current streak begin? Null when there is no streak. A record
 * written before `failingSince` existed falls back to `lastFailAt`, which is
 * LATER than the true start - so an old record errs towards not alerting yet,
 * and the next failure stamps a real start.
 */
export function streakStartedAt(rec: UpstreamRecord): string | null {
  if (rec.consecutiveFailures <= 0) return null;
  return rec.failingSince ?? rec.lastFailAt;
}

/**
 * Has the current streak lasted long enough to be an outage?
 *
 * The single definition, used by BOTH the alert (`failureTransition`) and the
 * badge (`stateOf`). It was once inlined in the alert only, and the badge kept
 * a streak-alone rule - so a service rendered a red **Down** while the system
 * had deliberately decided it was not an outage and sent nothing.
 *
 * An unparseable start counts as long enough: a corrupt record must not mute
 * an alert, the same mistake as reading `unknown` as healthy.
 */
export function failingLongEnough(
  failingSince: string | null,
  nowIso: string,
  windowMs: number,
): boolean {
  if (!failingSince) return false;
  const lasted = Date.parse(nowIso) - Date.parse(failingSince);
  return !Number.isFinite(lasted) || lasted >= windowMs;
}

export function failureTransition(
  rec: UpstreamRecord,
  reason: string,
  status: number | null,
  nowIso: string,
  brokenAfter: number,
  windowMs: number,
): { next: UpstreamRecord; crossed: boolean } {
  const streak = rec.consecutiveFailures + 1;
  // How long has it been failing? A burst seconds long is a flaky upstream or
  // a brief block, not an outage - see MIN_OUTAGE_MS.
  const failingSince = streakStartedAt(rec) ?? nowIso;
  const lasted = failingLongEnough(failingSince, nowIso, windowMs);
  // `>=` and a stored flag rather than `=== brokenAfter`, because the two
  // conditions become true in either order: the streak reaches the threshold
  // in seconds, and the window opens later. The flag is what keeps it to one
  // mail, and okTransition clears it.
  const crossed = streak >= brokenAfter && lasted && !rec.downAlertedAt;
  return {
    next: {
      ...rec,
      lastFailAt: nowIso,
      lastFailReason: reason.slice(0, 500),
      lastFailStatus: status,
      consecutiveFailures: streak,
      failingSince,
      failCount: rec.failCount + 1,
      lastCheckedAt: nowIso,
      lastSkipped: null,
      downAlertedAt: crossed ? nowIso : rec.downAlertedAt,
    },
    crossed,
  };
}

/**
 * A success. `recovered` is true only if we ACTUALLY MAILED about this outage -
 * `stateOf` can call a record `down` on the streak while the outage window kept
 * the mail back, and announcing a recovery from an outage nobody was told about
 * reads as a first mail that went missing.
 */
export function okTransition(
  rec: UpstreamRecord,
  nowIso: string,
  brokenAfter: number,
): { next: UpstreamRecord; recovered: boolean } {
  // Announce recovery only from an outage we actually announced. `brokenAfter`
  // stays in the signature because the downloadHealth twin still takes it and
  // the agreement test compares them.
  void brokenAfter;
  return {
    next: {
      ...rec,
      lastOkAt: nowIso,
      consecutiveFailures: 0,
      failingSince: null,
      okCount: rec.okCount + 1,
      lastCheckedAt: nowIso,
      lastSkipped: null,
      downAlertedAt: null,
    },
    recovered: !!rec.downAlertedAt,
  };
}

export type UpstreamState = 'ok' | 'failing' | 'down' | 'unknown' | 'notConfigured';

/**
 * The verdict, decided HERE and not in the page. Two of these exist only so a
 * reader is never misled: `unknown` means we have not asked yet - it must never
 * render as healthy - and `notConfigured` means nobody set the service up,
 * which is a deliberate state and not a fault.
 */
export function stateOf(
  rec: UpstreamRecord,
  brokenAfter: number,
  nowIso: string,
  windowMs: number,
): UpstreamState {
  if (rec.lastSkipped) return 'notConfigured';
  if (!rec.lastCheckedAt) return 'unknown';
  // `down` means what the ALERT means by it, not merely "the streak is long".
  // Without the window here, skyhook answering 66 calls and failing 16 in one
  // evening - 19.5%, all 500s, while working - painted a red badge for a
  // service nothing was wrong with, and the page contradicted its own email.
  if (rec.consecutiveFailures >= brokenAfter && failingLongEnough(streakStartedAt(rec), nowIso, windowMs)) {
    return 'down';
  }
  if (rec.consecutiveFailures > 0) return 'failing';
  return 'ok';
}

// --- Storage -----------------------------------------------------------------

type HealthMap = Record<string, UpstreamRecord>;

/** All records. A corrupt or missing row reads as "nothing known", never throws. */
export async function readAll(): Promise<HealthMap> {
  try {
    const row = await prisma.appConfig.findUnique({ where: { key: UPSTREAM_HEALTH_KEY } });
    if (!row?.value) return {};
    const parsed = JSON.parse(row.value);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: HealthMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v && typeof v === 'object') out[k] = { ...EMPTY_RECORD, ...(v as object) } as UpstreamRecord;
    }
    return out;
  } catch {
    return {};
  }
}

async function writeAll(map: HealthMap): Promise<void> {
  const value = JSON.stringify(map);
  await prisma.appConfig.upsert({
    where: { key: UPSTREAM_HEALTH_KEY },
    update: { value },
    create: { key: UPSTREAM_HEALTH_KEY, value },
  });
}

// --- Recording ---------------------------------------------------------------

/**
 * Tell the health record how a call went. **Never throws and never rejects** -
 * this sits on request paths and on a timer, and a health write turning into a
 * second incident is the one outcome worse than no health record at all.
 *
 * Callers use `void recordUpstream(...)` and do not await it.
 */
export async function recordUpstream(
  id: string,
  ok: boolean,
  detail: { reason?: string; status?: number | null } = {},
): Promise<void> {
  try {
    const spec = upstreamById(id);
    if (!spec) return;
    const map = await readAll();
    const rec = map[id] ?? { ...EMPTY_RECORD };
    const nowIso = new Date().toISOString();

    if (ok) {
      // Successes are COALESCED. These hooks sit on real request paths - an
      // identity sweep makes hundreds of skyhook calls in a row - and each
      // write is a read-modify-write of the whole blob. A service that was
      // already healthy a moment ago has told us nothing new, so skip it.
      //
      // Never coalesced: a success that ENDS a failure streak, because that is
      // the recovery edge and the mail hangs off it. `okCount` therefore counts
      // recorded successes rather than calls, which is what it is read as.
      if (
        rec.consecutiveFailures === 0 &&
        rec.lastOkAt &&
        Date.now() - Date.parse(rec.lastOkAt) < OK_COALESCE_MS
      ) {
        return;
      }
      const { next, recovered } = okTransition(rec, nowIso, spec.brokenAfter);
      map[id] = next;
      await writeAll(map);
      if (recovered) {
        console.log(`[upstream] ${spec.label} RECOVERED after ${rec.consecutiveFailures} consecutive failures`);
        void announce(spec, 'recovered', rec, next);
      }
      return;
    }

    const reason = detail.reason ?? 'unknown error';
    const status = detail.status ?? null;
    const { next, crossed } = failureTransition(rec, reason, status, nowIso, spec.brokenAfter, outageWindowFor(spec));
    map[id] = next;
    await writeAll(map);
    if (!crossed) return;
    console.error(
      `[upstream] ${spec.label} LOOKS DOWN - ${next.consecutiveFailures} consecutive failures, ` +
      `latest${status ? ` (${status})` : ''}: ${reason.slice(0, 200)}`,
    );
    void announce(spec, 'down', rec, next);
  } catch (err: any) {
    console.warn(`[upstream] could not record health for ${id}: ${err?.message ?? err}`);
  }
}

/**
 * The service is not set up, so there was nothing to check. Records THAT, and
 * deliberately touches neither counter: a skip is not a success (it would paint
 * an unconfigured service green) and not a failure (it would paint a
 * deliberate choice red and train the reader to ignore the page).
 */
export async function recordSkip(id: string, why: string): Promise<void> {
  try {
    if (!upstreamById(id)) return;
    const map = await readAll();
    const rec = map[id] ?? { ...EMPTY_RECORD };
    map[id] = { ...rec, lastCheckedAt: new Date().toISOString(), lastSkipped: why.slice(0, 200) };
    await writeAll(map);
  } catch (err: any) {
    console.warn(`[upstream] could not record skip for ${id}: ${err?.message ?? err}`);
  }
}

function minutesSince(iso: string | null): number {
  const ms = iso ? Date.now() - Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 60_000)) : 0;
}

/** The mail. Respects the alert settings; silent services still record. */
async function announce(
  spec: UpstreamSpec,
  kind: 'down' | 'recovered',
  before: UpstreamRecord,
  after: UpstreamRecord,
): Promise<void> {
  try {
    const settings = await readAlertSettings();
    if (!alertsEnabledFor(settings, spec.id, kind)) {
      console.log(`[upstream] ${kind} alerts are off for ${spec.id}; not mailing`);
      return;
    }
    // The owner alone by default - not every admin. `resolveRecipients` adds
    // whatever extra addresses were configured on /admin/status.
    const owner = ownerEmail(
      await prisma.user.findMany({
        where: { isAdmin: true },
        select: { id: true, email: true, emailVerifiedAt: true },
      }),
    );
    const to = resolveRecipients(settings, owner ? [owner] : []);

    const subject =
      kind === 'down' ? `${spec.label} is not responding` : `${spec.label} is working again`;
    const hint = kind === 'down' ? spec.hint?.(after.lastFailReason, after.lastFailStatus) : null;
    const text =
      kind === 'down'
        ? `${spec.label} has been failing for ${minutesSince(after.failingSince)} minutes ` +
          `(${after.consecutiveFailures} failures in a row, nothing succeeding in between).\n\n` +
          `${spec.impact}\n\n` +
          `Latest failure${after.lastFailStatus ? ` (HTTP ${after.lastFailStatus})` : ''}: ` +
          `${after.lastFailReason ?? 'unknown'}\n\n` +
          (hint ? `${hint}\n\n` : '') +
          'A status code like 400 or 403 means the service is up and refusing us - either it ' +
          'changed what it accepts, or it is blocking our address.\n\n' +
          '/admin/status shows every service and will announce recovery.'
        : `${spec.label} is answering again after ${before.consecutiveFailures} consecutive failures.\n\n` +
          `Last failure was: ${before.lastFailReason ?? 'unknown'}\n\n/admin/status has the details.`;

    await alertAdmins(subject, text, { recipients: async () => to });
  } catch (err: any) {
    console.warn(`[upstream] could not announce ${spec.id}: ${err?.message ?? err}`);
  }
}
