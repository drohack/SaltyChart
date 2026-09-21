/**
 * Is the trailer download path actually working?
 *
 * THE POINT. The 2026-09 outage was not hard to fix - it was hard to *notice*.
 * yt-dlp went stale, every new trailer's download 403'd, and nothing anywhere
 * said so: already-translated trailers kept serving from `SubtitleCache`, the
 * suite stayed green (nothing in it downloads a fresh video), and the only
 * symptom was a transient chip in a modal that cleared itself after 6 seconds.
 * It ran for months and was found by a viewer, not by us.
 *
 * So this records what real traffic already tells us. **It makes no requests of
 * its own** - no canary, no polling - because the thing that breaks is
 * YouTube's tolerance for our requests, and a health check that adds load is
 * the wrong shape. Every genuine download either works or doesn't; we just
 * write down which.
 *
 * What makes it a *signal* rather than a log: consecutive failures. One failure
 * is a private video, a deleted trailer, a flaky minute. A run of them with the
 * same reason is the download path being broken for everyone, which is exactly
 * the state nobody could see last time. Crossing that line logs once, mails the
 * admins once (lib/subtitleAlerts.ts), and recovery does the same - never per
 * failure, or the alert becomes the noise that gets muted.
 *
 * The transitions are pure functions (`failureTransition`, `okTransition`) so
 * the "once, at the crossing" rule is unit-tested. The `record*` wrappers read,
 * decide, write and act on the flags - `recordDownloadFailure` also asks
 * `countsTowardBroken` first, and a dead video writes the counters without
 * touching the streak at all.
 *
 * Persisted in `AppConfig` for the reason everything else here is: a deploy is a
 * restart, and a restart is precisely when someone asks "is it working now".
 */
import prisma from '../db';
import { alertAdmins } from './subtitleAlerts';

const KEY = 'subtitleDownloadHealth';

/** Consecutive failures before we call the path broken rather than unlucky. */
export const BROKEN_AFTER = 3;

/**
 * How long to refuse NEW downloads after YouTube explicitly challenged or
 * rate-limited us (`kind: 'botwall'`).
 *
 * Why this exists: without it, every viewer who opens a trailer during a block
 * fires another attempt at a blocked IP - the exact behaviour `tools/yt_guard.py`
 * stops for dev tooling, and nothing stopped it in production. A bot wall is
 * not a per-video failure like a private trailer; it is YouTube saying "you",
 * so one is enough to hold.
 *
 * A `forbidden` (403) failure does NOT hold. That is the stale-yt-dlp signature,
 * each attempt fails fast and harmlessly, and the daily updater or a deploy may
 * fix it at any moment - refusing attempts would only hide the recovery.
 *
 * THE NUMBER IS A GUESS, and is labelled as one. Nothing publishes how long a
 * YouTube soft block lasts (checked 2026-09-20: yt-dlp's FAQ calls it "usually
 * a soft block" with no duration; community reports for hard IP bans run
 * 24-48 h). Fifteen minutes is a conservative starting point: long enough that
 * a burst of viewers cannot deepen a block, short enough that recovery is
 * noticed the same evening. Re-arms on every bot-wall failure, so repeated
 * refusals extend it naturally.
 */
export const BOT_WALL_HOLD_MS = 15 * 60 * 1000;

/**
 * The daemon classifies every failure (`classify_error` in translate_stream.py)
 * and sends one of these. Anything else that arrives - a future daemon, a
 * corrupt line - is stored as `other`, because this value is persisted config
 * written from a spawned process's JSON and nothing else in that path is
 * unbounded.
 */
export const FAIL_KINDS = ['botwall', 'forbidden', 'unavailable', 'other'] as const;
export type FailKind = typeof FAIL_KINDS[number];

/**
 * Does this failure say anything about whether the download PATH works?
 *
 * Only `unavailable` does not. A video that no longer exists is a fact about
 * that video, not about us, so it is not evidence in either direction - it must
 * neither advance the broken streak nor clear it. Everything else does count:
 * a 403 on every video is the stale-yt-dlp signature and a bot wall is YouTube
 * refusing us, which are precisely what the streak exists to catch.
 *
 * Measured: SUMMER 2026 failed FIVE trailers back to back - Anpanman, Crayon
 * Shin-chan, TOMICA and two more - every one `Video unavailable`, against a
 * BROKEN_AFTER of 3. Without this the batch would mail "the download path is
 * broken" while that same run downloaded 51 other trailers successfully.
 *
 * Pure and exported so the rule is testable and mutable on its own, rather than
 * buried in a branch inside a function that needs a database.
 */
export function countsTowardBroken(kind: FailKind): boolean {
  return kind !== 'unavailable';
}

export function normalizeFailKind(k: unknown): FailKind {
  return (FAIL_KINDS as readonly string[]).includes(k as string) ? (k as FailKind) : 'other';
}

export interface DownloadHealth {
  lastOkAt: string | null;
  lastFailAt: string | null;
  lastFailReason: string | null;
  /** One of FAIL_KINDS - classified by the daemon, normalised here. */
  lastFailKind: string | null;
  consecutiveFailures: number;
  /** Total counts, so "3 failures" can be read against how much we attempt. */
  okCount: number;
  failCount: number;
}

const EMPTY: DownloadHealth = {
  lastOkAt: null,
  lastFailAt: null,
  lastFailReason: null,
  lastFailKind: null,
  consecutiveFailures: 0,
  okCount: 0,
  failCount: 0,
};

async function read(): Promise<DownloadHealth> {
  try {
    const rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT "value" FROM "AppConfig" WHERE "key" = ? LIMIT 1`, KEY,
    );
    if (!rows.length) return { ...EMPTY };
    // A corrupt row must read as "no history", never throw - this sits on the
    // translation path and must not be able to break a viewer's subtitles.
    return { ...EMPTY, ...JSON.parse(rows[0].value) };
  } catch {
    return { ...EMPTY };
  }
}

async function write(h: DownloadHealth): Promise<void> {
  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "AppConfig" ("key", "value") VALUES (?, ?)
       ON CONFLICT("key") DO UPDATE SET "value" = excluded."value"`,
      KEY, JSON.stringify(h),
    );
  } catch (err) {
    console.warn('[subtitles] could not persist download health:', err);
  }
}

// --- Pure transitions --------------------------------------------------------

/**
 * One more failure. `crossed` is true on exactly the failure that takes the
 * streak to BROKEN_AFTER - not before, not on any failure after it. That single
 * edge is what gets logged loudly and mailed; logging every failure afterwards
 * would bury it, and mailing every failure is how an alert gets muted.
 */
export function failureTransition(
  h: DownloadHealth, reason: string, kind: FailKind, nowIso: string,
): { next: DownloadHealth; crossed: boolean } {
  const streak = h.consecutiveFailures + 1;
  return {
    next: {
      ...h,
      lastFailAt: nowIso,
      lastFailReason: reason.slice(0, 500),
      lastFailKind: kind,
      consecutiveFailures: streak,
      failCount: h.failCount + 1,
    },
    crossed: streak === BROKEN_AFTER,
  };
}

/** A success. `recovered` is true only if the path was broken before it. */
export function okTransition(
  h: DownloadHealth, nowIso: string,
): { next: DownloadHealth; recovered: boolean } {
  return {
    next: { ...h, lastOkAt: nowIso, consecutiveFailures: 0, okCount: h.okCount + 1 },
    recovered: h.consecutiveFailures >= BROKEN_AFTER,
  };
}

/**
 * Is this failure the stale-yt-dlp signature? ONE definition: the log hint, the
 * alert body and the admin banner all read this.
 *
 * `kind` matters: the daemon checks bot-wall phrases BEFORE the 403 status,
 * because a YouTube challenge can arrive as an HTTP 403 whose body says "Sign in
 * to confirm you're not a bot". A bare regex on the text would hang the
 * "out-of-date yt-dlp" hint under a bot-wall failure - the wrong remedy. Rows
 * stored before `kind` existed pass no kind and fall back to the text.
 */
export function looksLikeStaleYtDlp(reason: string | null | undefined, kind?: string | null): boolean {
  if (kind && kind !== 'forbidden') return false;
  return /403|Forbidden/i.test(reason ?? '');
}

// --- Recording ---------------------------------------------------------------

/** A download succeeded. Clears the failure streak - recovery is the news. */
export async function recordDownloadOk(): Promise<void> {
  const h = await read();
  const { next, recovered } = okTransition(h, new Date().toISOString());
  await write(next);
  if (recovered) {
    console.log(`[subtitles] download path RECOVERED after ${h.consecutiveFailures} consecutive failures`);
    void alertAdmins(
      'trailer downloads recovered',
      `Trailer audio downloads are working again after ${h.consecutiveFailures} consecutive failures.\n` +
      `Last failure: ${h.lastFailReason ?? 'unknown'}\n\n/admin/subtitles has the details.`,
    );
  }
}

/**
 * A download failed. `reason` is the raw yt-dlp text, not the viewer-facing
 * one - this is the operator's copy and the raw string is what identifies the
 * failure mode. `kind` is whatever the daemon sent; it is normalised here.
 */
export async function recordDownloadFailure(reason: string, kind: unknown = 'other'): Promise<void> {
  const h = await read();
  const k = normalizeFailKind(kind);

  // A video that no longer exists says NOTHING about whether downloading works,
  // so it neither advances the broken streak nor clears it - it is not evidence
  // in either direction. Without this, an old season is enough to mail "the
  // download path is broken" while the path is fine: measured on a real run,
  // SUMMER 2026 failed five trailers BACK TO BACK (Anpanman, Crayon Shin-chan,
  // TOMICA and two more), every one of them `Video unavailable`, against a
  // BROKEN_AFTER of 3. The counters still move, because "how many trailers are
  // simply gone" is worth seeing on /admin/subtitles; only the alert is spared.
  //
  // This is the same rule the upstream quiet window enforces one module over:
  // count failures, but ask what they MEAN before calling them an outage.
  if (!countsTowardBroken(k)) {
    await write({
      ...h,
      lastFailAt: new Date().toISOString(),
      lastFailReason: reason.slice(0, 500),
      lastFailKind: k,
      failCount: h.failCount + 1,
    });
    return;
  }

  const { next, crossed } = failureTransition(h, reason, k, new Date().toISOString());
  await write(next);
  if (!crossed) return;

  const stale = looksLikeStaleYtDlp(reason, k);
  console.error(
    `[subtitles] DOWNLOAD PATH LOOKS BROKEN - ${next.consecutiveFailures} consecutive failures, ` +
    `latest: ${reason.slice(0, 200)}`,
  );
  if (stale) {
    console.error(
      '[subtitles] a 403 here is almost always a stale yt-dlp, not an auth ' +
      'problem - see "Keeping yt-dlp current" in backend/CLAUDE.md',
    );
  }
  void alertAdmins(
    'trailer downloads broken',
    `${next.consecutiveFailures} consecutive trailer audio downloads have failed. New trailers cannot ` +
    `be subtitled; cached ones keep working, which is why the site looks mostly fine.\n\n` +
    `Latest failure (${k}): ${reason.slice(0, 500)}\n\n` +
    (stale
      ? 'A 403 on the download is almost always an out-of-date yt-dlp on the server, not an ' +
        'authentication problem. The daily updater and the next deploy both upgrade it; if this ' +
        'persists past a day, upgrade it by hand.\n\n'
      : '') +
    '/admin/subtitles shows the live state and will announce recovery.',
  );
}

// --- Reading -----------------------------------------------------------------

/** ISO time the current bot-wall hold ends, or null when not holding. Pure. */
export function holdUntil(h: DownloadHealth, now: number = Date.now()): string | null {
  if (h.lastFailKind !== 'botwall' || !h.lastFailAt) return null;
  const until = Date.parse(h.lastFailAt) + BOT_WALL_HOLD_MS;
  return until > now ? new Date(until).toISOString() : null;
}

/**
 * Should `/stream` (and the check paths) refuse to start NEW YouTube work?
 *
 * Read on every cache miss, so it must be cheap (one AppConfig row) and must
 * never throw - `read()` already degrades to "no history", which is "no hold".
 * Callers answer the viewer with the same friendly message the daemon would
 * have produced, and record nothing: a refused attempt is not a failure.
 */
export async function shouldHoldDownloads(): Promise<{ hold: boolean; until: string | null }> {
  const until = holdUntil(await read());
  return { hold: until !== null, until };
}

export async function getDownloadHealth(): Promise<DownloadHealth & { broken: boolean; staleYtDlp: boolean; holdingUntil: string | null }> {
  const h = await read();
  return {
    ...h,
    broken: h.consecutiveFailures >= BROKEN_AFTER,
    staleYtDlp: looksLikeStaleYtDlp(h.lastFailReason, h.lastFailKind),
    holdingUntil: holdUntil(h),
  };
}
