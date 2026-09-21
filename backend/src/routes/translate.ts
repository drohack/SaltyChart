import { Router, Request, Response } from 'express';
import express from 'express';
import { spawn, ChildProcess } from 'child_process';
import { recordDownloadOk, recordDownloadFailure, getDownloadHealth, shouldHoldDownloads } from '../lib/downloadHealth';
import { checkVerdict } from '../lib/subtitleCheck';
import { alertAdmins, localRunSilence, LOCAL_RUN_SILENT_DAYS } from '../lib/subtitleAlerts';
import type { RecycleOutcome } from '../lib/ytdlpUpdate';
import path from 'path';
import crypto from 'crypto';
import prisma from '../db';
import { requireAuth, requireAdmin, AuthRequest } from '../middleware/auth';
import { isValidSeason, isValidYear, type Season } from '../lib/validateSeason';
import { seasonsForSonarr, type SeasonRef } from '../lib/sonarrSelect';
import { describeBatchSchedule } from '../lib/batchSchedule';
import {
  buildSubtitleReport,
  isBelowChampion,
  MODEL_RANK,
  CHAMPION,
  type SeasonEntry,
  type SeasonInput,
  type SubtitleRow,
} from '../lib/subtitleReport';

const router = Router();

const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;
const MAX_CONCURRENT = 2;
let activeTranslations = 0;

// Use python3 on Linux (Docker), python on Windows
const PYTHON = process.platform === 'win32' ? 'python' : 'python3';

// ---------------------------------------------------------------------------
// Persistent daemon management
// ---------------------------------------------------------------------------

let daemon: ChildProcess | null = null;
let daemonReady = false;
let readyResolvers: Array<() => void> = [];
let daemonBuffer = '';

const pendingStreams = new Map<string, Response>();
const pendingChecks = new Map<string, { resolve: (data: any) => void }>();
// Segments collected per request, cached to the DB when translation completes
// (`cache: false` for partial start>0 runs - the batch makes the full version).
const pendingSegments = new Map<string, { videoId: string; mediaId: number | null; segments: any[]; cache: boolean }>();
// In-flight translations by videoId, so concurrent requests for the same
// uncached video share one run instead of translating twice.
const inFlightTranslations = new Map<string, { promise: Promise<void>; resolve: () => void }>();

function getDaemonScriptPath(): string {
  return path.resolve(__dirname, '../../scripts/translate_daemon.py');
}

function getStreamScriptPath(): string {
  return path.resolve(__dirname, '../../scripts/translate_stream.py');
}

function handleDaemonLine(line: string): void {
  let data: any;
  try {
    data = JSON.parse(line);
  } catch {
    return;
  }

  if (data.ready) {
    daemonReady = true;
    for (const resolve of readyResolvers) resolve();
    readyResolvers = [];
    return;
  }

  // Daemon idle shutdown
  if (data.shutdown) {
    console.log('[translate/daemon] Shutting down:', data.shutdown);
    cleanupDaemon();
    return;
  }

  const rid = data.rid;
  if (!rid) return;

  const check = pendingChecks.get(rid);
  if (check) {
    pendingChecks.delete(rid);
    const { rid: _, ...rest } = data;
    check.resolve(rest);
    return;
  }

  // Route to SSE stream handler
  const res = pendingStreams.get(rid);
  if (!res) return;

  // Strip rid, and the daemon's operator-only fields, before forwarding.
  // `raw` is the unedited yt-dlp text and `stage` is internal plumbing; both
  // feed the download-health record below and neither belongs in a browser.
  const { rid: _rid, raw: _raw, stage: _stage, kind: _kind, ...payload } = data;

  // Record whether the *download* step is working. Driven entirely by traffic
  // that was going to happen anyway - see lib/downloadHealth.ts for why this is
  // not a canary. `progress: transcribing` is the daemon's "download returned".
  if (payload.progress === 'transcribing') {
    void recordDownloadOk();
  } else if (payload.error && data.stage === 'download') {
    void recordDownloadFailure(String(data.raw ?? payload.error), String(data.kind ?? 'other'));
  }

  if (payload.done) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    pendingStreams.delete(rid);
    activeTranslations = Math.max(0, activeTranslations - 1);
    res.end();

    // Save collected segments to cache and resolve in-flight waiters
    const pending = pendingSegments.get(rid);
    if (pending && !pending.cache) {
      // Partial run (started mid-playback at start>0) - don't cache it as if it
      // were the full video; the batch produces the complete cached version.
      // Still resolve any in-flight waiters so they fall through and re-translate.
      pendingSegments.delete(rid);
      const inFlight = inFlightTranslations.get(pending.videoId);
      if (inFlight) {
        inFlightTranslations.delete(pending.videoId);
        inFlight.resolve();
      }
    } else if (pending) {  // cache even 0-segment results - prevents re-translating silent videos
      pendingSegments.delete(rid);
      const segJson = JSON.stringify(pending.segments);
      prisma.$executeRawUnsafe(
        `INSERT INTO "SubtitleCache" ("videoId", "mediaId", "modelName", "segments")
         VALUES (?, ?, 'small', ?)
         ON CONFLICT("videoId") DO UPDATE SET
           "mediaId" = COALESCE(excluded."mediaId", "SubtitleCache"."mediaId"),
           "modelName" = CASE WHEN "SubtitleCache"."modelName" IS NULL
                              OR "SubtitleCache"."modelName" IN ('tiny', 'base', 'small')
                         THEN excluded."modelName" ELSE "SubtitleCache"."modelName" END,
           "segments" = CASE WHEN "SubtitleCache"."segments" IS NULL
                              OR "SubtitleCache"."modelName" IS NULL
                              OR "SubtitleCache"."modelName" IN ('tiny', 'base', 'small')
                         THEN excluded."segments" ELSE "SubtitleCache"."segments" END`,
        pending.videoId,
        pending.mediaId,
        segJson
      ).then(() => {
        // Resolve any waiters after cache is written
        const inFlight = inFlightTranslations.get(pending.videoId);
        if (inFlight) {
          inFlightTranslations.delete(pending.videoId);
          inFlight.resolve();
        }
      }).catch((err: any) => {
        console.error('[translate/cache] Failed to save segments:', err);
        // Still resolve waiters even on cache write failure
        if (pending) {
          const inFlight = inFlightTranslations.get(pending.videoId);
          if (inFlight) {
            inFlightTranslations.delete(pending.videoId);
            inFlight.resolve();
          }
        }
      });
    }
    return;
  }

  if (payload.error) {
    // Terminal: mirror the `done` teardown so an errored translation doesn't
    // hold a MAX_CONCURRENT slot or leave the dedup lock stuck forever.
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    pendingStreams.delete(rid);
    activeTranslations = Math.max(0, activeTranslations - 1);
    res.end();

    const pending = pendingSegments.get(rid);
    pendingSegments.delete(rid);
    if (pending) {
      const inFlight = inFlightTranslations.get(pending.videoId);
      if (inFlight) {
        inFlightTranslations.delete(pending.videoId);
        inFlight.resolve();
      }
    }
    return;
  }

  // Collect segment for caching (only actual subtitle segments with start/end/text)
  if (payload.start !== undefined && payload.text) {
    const pending = pendingSegments.get(rid);
    if (pending) {
      pending.segments.push({ start: payload.start, end: payload.end, text: payload.text });
    }
  }

  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function cleanupDaemon(): void {
  if (daemon) {
    daemon.stdout?.removeAllListeners();
    daemon.stderr?.removeAllListeners();
    daemon.removeAllListeners();
  }
  daemon = null;
  daemonReady = false;
  daemonBuffer = '';

  // Pending checks resolve WITH an error (not reject) - callers treat any
  // shape without hasEnglish as "unknown" and move on.
  for (const [rid, check] of pendingChecks) {
    check.resolve({ error: 'Daemon exited' });
  }
  pendingChecks.clear();

  for (const [rid, res] of pendingStreams) {
    try {
      res.write(`data: ${JSON.stringify({ error: 'Translation daemon exited' })}\n\n`);
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    } catch (err) {
      console.error('[translate] Failed to flush pending stream on daemon exit:', err);
    }
  }
  pendingStreams.clear();
  pendingSegments.clear();

  // Resolve dedup waiters so blocked /stream requests fall through and can
  // re-translate instead of awaiting a promise that will never settle.
  for (const [, inFlight] of inFlightTranslations) {
    inFlight.resolve();
  }
  inFlightTranslations.clear();

  activeTranslations = 0;
}

function ensureDaemon(): Promise<void> {
  if (daemon && daemonReady) return Promise.resolve();

  if (daemon && !daemonReady) {
    // Daemon is starting up, wait for ready
    return new Promise<void>((resolve) => readyResolvers.push(resolve));
  }

  return new Promise<void>((resolve, reject) => {
    console.log('[translate/daemon] Spawning persistent daemon...');
    daemon = spawn(PYTHON, [getDaemonScriptPath()], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    readyResolvers.push(resolve);

    daemon.stdout!.on('data', (chunk: Buffer) => {
      daemonBuffer += chunk.toString();
      const lines = daemonBuffer.split('\n');
      daemonBuffer = lines.pop()!;
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) handleDaemonLine(trimmed);
      }
    });

    daemon.stderr!.on('data', (chunk: Buffer) => {
      console.error('[translate/daemon]', chunk.toString());
    });

    daemon.on('close', (code) => {
      console.log(`[translate/daemon] Daemon exited with code ${code}`);
      cleanupDaemon();
    });

    daemon.on('error', (err) => {
      console.error('[translate/daemon] Spawn error:', err.message);
      cleanupDaemon();
      reject(err);
    });
  });
}

/**
 * Retire an idle daemon so the next request respawns it.
 *
 * Python caches `yt_dlp` in `sys.modules` at first import, so upgrading the
 * package under a running daemon changes nothing - it keeps using the copy it
 * loaded, which is the stale one we just replaced. Only a fresh process picks
 * the new version up.
 *
 * Refuses while a translation is in flight: killing the daemon mid-run would
 * surface as "Translation daemon exited" to whoever is watching that trailer.
 * The caller is a daily timer, so waiting for the next one costs nothing.
 * Returns whether it actually recycled, because a job that logs "updated" while
 * silently declining to apply it is the kind of thing nobody catches for months.
 */
export function recycleTranslateDaemon(): RecycleOutcome {
  if (!daemon) return 'none';
  if (activeTranslations > 0 || pendingStreams.size > 0) return 'busy';
  daemon.kill('SIGTERM');
  cleanupDaemon();
  return 'recycled';
}

function sendCommand(cmd: object): void {
  if (daemon && daemon.stdin && !daemon.stdin.destroyed) {
    daemon.stdin.write(JSON.stringify(cmd) + '\n');
  }
}

process.on('SIGTERM', () => {
  if (daemon && !daemon.killed) {
    daemon.kill('SIGTERM');
  }
});
process.on('SIGINT', () => {
  if (daemon && !daemon.killed) {
    daemon.kill('SIGTERM');
  }
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * GET /check-batch?videoIds=id1,id2,...
 * Lightweight bulk lookup: returns which videoIds have confirmed English subs
 * (hasEnglishSubs=1 in DB). The response itself is DB-only (~5 ms); uncached
 * IDs are queued as background daemon checks so later /check calls hit cache.
 */
router.get('/check-batch', async (req: Request, res: Response) => {
  const raw = (req.query.videoIds as string) || '';
  const ids = raw.split(',').map(s => s.trim()).filter(s => VIDEO_ID_RE.test(s)).slice(0, 100);
  if (ids.length === 0) return res.json({});

  // Single DB query for all requested IDs
  let rows: any[] = [];
  try {
    const placeholders = ids.map(() => '?').join(',');
    rows = await prisma.$queryRawUnsafe(
      `SELECT "videoId", "hasEnglishSubs" FROM "SubtitleCache" WHERE "videoId" IN (${placeholders})`,
      ...ids
    );
  } catch (err) {
    console.error('[translate/check-batch] DB lookup failed:', err);
  }

  // `null` must survive this map. It used to be `Number(r.hasEnglishSubs)`, and
  // `Number(null)` is 0 - so "nobody has checked" and "checked, no English CC"
  // became the same value, which is the distinction the queueing below turns on.
  const known = new Map<string, number | null>(
    rows.map((r: any) => [r.videoId, r.hasEnglishSubs == null ? null : Number(r.hasEnglishSubs)]),
  );

  // Return confirmed positives immediately
  const result: Record<string, boolean> = {};
  for (const id of ids) {
    if (known.get(id) === 1) result[id] = true;
  }

  // Decide up front whether anything will be queued, and say so in a header.
  // It is the only observable surface for "the hold stopped us" - a test cannot
  // read the server console - and it has to be computed before the body goes
  // out, because headers cannot follow it. `uncached` below reuses this.
  const uncachedIds = ids.filter(id => !known.has(id) || known.get(id) === null);
  const held = uncachedIds.length > 0 && (await shouldHoldDownloads()).hold;
  res.setHeader('X-Check-Queue', held ? 'held' : (daemon && daemonReady ? `queued:${uncachedIds.length}` : 'no-daemon'));
  res.json(result);

  // Background: queue Python checks for IDs not in DB at all so the cache
  // self-populates while the user browses. Bounded concurrency - a burst of
  // ~80 parallel youtube_transcript_api hits from one IP trips YouTube's bot
  // wall and poisons results with false negatives.
  // A row EXISTING is not a verdict. `hasEnglishSubs` is null on any row created
  // by something other than a check - `PATCH /dismiss` upserts one, and so does
  // caching translated segments - and the filter used to be `!known.has(id)`,
  // which read those rows as "already answered" and never queued a check again.
  //
  // That is a one-way trap, and it is upstream of the whole 403: a video whose
  // first view raced ahead of its check got a segments row, was never asked
  // about again, and so took the download path forever - including for videos
  // that have English CC and never needed downloading at all. Measured on
  // `8AnNxEp733c`: `check_subtitles` returns hasEnglish=true, the stored verdict
  // was null, and check-batch returned `{}` without queueing anything.
  const uncached = uncachedIds;
  // While YouTube is refusing us, queue nothing: a background check is a
  // YouTube request too, and the point of the hold is to stop poking a blocked
  // IP from every direction at once. These ids get checked on a later visit.
  if (held) return;
  const CHECK_CONCURRENCY = 2;
  let cursor = 0;
  const runCheck = async (videoId: string) => {
    try {
      if (daemon && daemonReady) {
        const rid = crypto.randomUUID();
        const checkResult: any = await new Promise((resolve) => {
          pendingChecks.set(rid, { resolve });
          sendCommand({ cmd: 'check', rid, videoId });
          setTimeout(() => { pendingChecks.delete(rid); resolve({ error: 'timeout' }); }, 15000);
        });
        // Only a real verdict is written. A failed check (IP block, timeout,
        // package missing) comes back as `hasEnglish: null`, and `null` passes
        // an `!== undefined` test - which is how a transient block used to be
        // pinned as "no CC" for seven days. checkVerdict() is the one gate.
        const verdict = checkVerdict(checkResult);
        if (verdict !== null) {
          // Stamp lastEnCheckAt so the /check 7-day negative-recheck logic
          // trusts this batch-populated row (it ignores negatives with a null
          // timestamp, otherwise re-hitting YouTube on the first modal open).
          prisma.$executeRawUnsafe(
            `INSERT INTO "SubtitleCache" ("videoId", "hasEnglishSubs", "lastEnCheckAt") VALUES (?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT("videoId") DO UPDATE SET
               "hasEnglishSubs" = CASE WHEN excluded."hasEnglishSubs" = 1 THEN 1 ELSE "SubtitleCache"."hasEnglishSubs" END,
               "lastEnCheckAt" = CURRENT_TIMESTAMP`,
            videoId, verdict
          ).catch(() => {});
        }
      }
    } catch {}
  };
  const worker = async () => {
    while (cursor < uncached.length) {
      await runCheck(uncached[cursor++]);
    }
  };
  for (let i = 0; i < Math.min(CHECK_CONCURRENCY, uncached.length); i++) void worker();
});

/**
 * GET /check?videoId=xxx&mediaId=yyy
 * Quick check whether a YouTube video has English subtitles.
 * Returns cached result if available; otherwise checks and caches the result.
 */
router.get('/check', async (req: Request, res: Response) => {
  const videoId = req.query.videoId as string;
  if (!videoId || !VIDEO_ID_RE.test(videoId)) {
    return res.status(400).json({ error: 'Invalid videoId', code: 'BAD_REQUEST' });
  }
  const mediaId = req.query.mediaId ? parseInt(req.query.mediaId as string, 10) : null;

  // cachedExtra preserves subtitlesDisabled/hasBurnedInSubs even when we fall
  // through to re-run the Python check (e.g. when hasEnglishSubs was cached wrong).
  let cachedExtra = { subtitlesDisabled: false, hasBurnedInSubs: false, hasCachedSegments: false, modelName: null as string | null };
  // Re-check stale "no English CC" results every 7 days so newly-added YouTube
  // CC eventually gets picked up. Positives are trusted forever (English CC
  // doesn't get removed). This keeps YouTube API calls roughly bounded by
  // "1 per uncached video per week" instead of "every play" - the rate-limit
  // risk that hit us before.
  const NEG_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;
  try {
    const cached: any[] = await prisma.$queryRawUnsafe(
      `SELECT "hasEnglishSubs", "subtitlesDisabled", "hasBurnedInSubs", "segments", "modelName", "lastEnCheckAt" FROM "SubtitleCache" WHERE "videoId" = ? LIMIT 1`,
      videoId
    );
    if (cached.length > 0) {
      cachedExtra = {
        subtitlesDisabled: Boolean(cached[0].subtitlesDisabled),
        hasBurnedInSubs: Boolean(cached[0].hasBurnedInSubs),
        hasCachedSegments: cached[0].segments != null,
        modelName: cached[0].modelName || null,
      };
      const cachedHasEn = Number(cached[0].hasEnglishSubs);
      if (cachedHasEn === 1) {
        // Trust positives forever
        return res.json({ hasEnglish: true, ...cachedExtra });
      }
      if (cachedHasEn === 0 && cached[0].lastEnCheckAt) {
        const age = Date.now() - new Date(cached[0].lastEnCheckAt).getTime();
        if (age < NEG_RECHECK_MS) {
          // Negative is fresh - trust it, skip the YouTube hit
          return res.json({ hasEnglish: false, ...cachedExtra });
        }
        // Otherwise: stale negative, fall through to re-check
      }
    }
  } catch (err) {
    console.error('[translate/cache] Check lookup failed:', err);
  }

  // While YouTube is refusing us, this is one more live request per modal open
  // at a blocked IP - the same door /check-batch and /stream already close.
  // Answer from cache only: `hasEnglish: null` is "could not find out", which
  // the frontend already treats as "try translating" (and /stream then refuses
  // with the hold message). Nothing is written, so nothing is pinned.
  const hold = await shouldHoldDownloads();
  if (hold.hold) return res.json({ ...cachedExtra, hasEnglish: null, holdUntil: hold.until });

  let result: any;

  if (daemon && daemonReady) {
    const rid = crypto.randomUUID();
    result = await new Promise<any>((resolve) => {
      pendingChecks.set(rid, { resolve });
      sendCommand({ cmd: 'check', rid, videoId });

      // Timeout after 15s
      setTimeout(() => {
        if (pendingChecks.has(rid)) {
          pendingChecks.delete(rid);
          resolve({ error: 'Check timed out' });
        }
      }, 15000);
    });
  } else {
    // Fallback: standalone spawn (also warms up daemon for next request)
    ensureDaemon().catch((err) => console.error('[translate] daemon warm-up failed:', err));

    result = await new Promise<any>((resolve) => {
      const py = spawn(PYTHON, [getStreamScriptPath(), 'check', videoId], {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let output = '';
      py.stdout!.on('data', (chunk: Buffer) => { output += chunk.toString(); });
      py.stderr!.on('data', (chunk: Buffer) => {
        console.error('[translate/check]', chunk.toString());
      });

      py.on('close', () => {
        try {
          resolve(JSON.parse(output.trim()));
        } catch {
          resolve({ error: 'Failed to check subtitles' });
        }
      });

      py.on('error', (err) => {
        console.error('[translate/check] spawn error:', err.message);
        resolve({ error: 'Python is not available' });
      });
    });
  }

  // Cache the result + stamp lastEnCheckAt so we don't re-hit YouTube for 7
  // days. Only update hasEnglishSubs when the new value is true - never
  // overwrite a correct true with a potentially wrong false from a transient
  // network failure.
  // Same gate as check-batch: a `null` verdict (the check could not find out)
  // must never be written as 0 - see lib/subtitleCheck.ts.
  const verdict = checkVerdict(result);
  if (verdict !== null) {
    prisma.$executeRawUnsafe(
      `INSERT INTO "SubtitleCache" ("videoId", "mediaId", "hasEnglishSubs", "lastEnCheckAt")
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT("videoId") DO UPDATE SET
         "hasEnglishSubs" = CASE WHEN excluded."hasEnglishSubs" = 1 THEN 1 ELSE "SubtitleCache"."hasEnglishSubs" END,
         "mediaId" = COALESCE(excluded."mediaId", "SubtitleCache"."mediaId"),
         "lastEnCheckAt" = CURRENT_TIMESTAMP`,
      videoId,
      mediaId,
      verdict
    ).catch((err: any) => console.error('[translate/cache] Failed to cache check result:', err));
  }

  // Merge cached subtitlesDisabled/hasBurnedInSubs into the Python result so
  // the frontend gets a complete response even on cache-miss/re-check paths.
  return res.json({ ...cachedExtra, ...result });
});

/**
 * GET /stream?videoId=xxx&mediaId=yyy
 * SSE endpoint that streams translated subtitle segments.
 * - Cache hit: sends {cached: true} then all segments instantly from DB
 * - In-flight dedup: if another request is translating the same video, waits
 *   for it to finish then serves from cache
 * - Cache miss: translates via daemon, streams segments to client in real-time,
 *   collects them in pendingSegments, and saves to SubtitleCache on completion
 */
router.get('/stream', async (req: Request, res: Response) => {
  const videoId = req.query.videoId as string;
  if (!videoId || !VIDEO_ID_RE.test(videoId)) {
    return res.status(400).json({ error: 'Invalid videoId', code: 'BAD_REQUEST' });
  }
  const mediaId = req.query.mediaId ? parseInt(req.query.mediaId as string, 10) : null;
  // Playhead offset: begin transcription near the viewer's current position so we
  // don't burn CPU on already-watched audio. start>0 ⇒ partial run, not cached.
  const startSec = req.query.start ? Math.max(0, parseFloat(req.query.start as string) || 0) : 0;

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write(':ok\n\n');

  try {
    const cached: any[] = await prisma.$queryRawUnsafe(
      `SELECT "segments" FROM "SubtitleCache" WHERE "videoId" = ? LIMIT 1`,
      videoId
    );
    if (cached.length > 0 && cached[0].segments) {
      const segments = JSON.parse(cached[0].segments);
      // Stream cached segments immediately - no daemon needed
      res.write(`data: ${JSON.stringify({ cached: true })}\n\n`);
      for (const seg of segments) {
        res.write(`data: ${JSON.stringify(seg)}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
      return;
    }
  } catch (err) {
    console.error('[translate/cache] Stream lookup failed:', err);
  }

  // If another request is already translating this video, wait for it then serve from cache
  const inFlight = inFlightTranslations.get(videoId);
  if (inFlight) {
    try {
      await inFlight.promise;
      // Translation finished - serve from cache
      const cached: any[] = await prisma.$queryRawUnsafe(
        `SELECT "segments" FROM "SubtitleCache" WHERE "videoId" = ? LIMIT 1`,
        videoId
      );
      if (cached.length > 0 && cached[0].segments) {
        const segments = JSON.parse(cached[0].segments);
        res.write(`data: ${JSON.stringify({ cached: true })}\n\n`);
        for (const seg of segments) {
          res.write(`data: ${JSON.stringify(seg)}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        res.end();
        return;
      }
    } catch (err) {
      console.error('[translate] in-flight wait failed; falling through to re-translate:', err);
    }
    // If cache still empty after waiting, fall through to translate
  }

  // Cache miss - but first: is YouTube currently refusing us? If the last
  // download failure was an explicit bot wall, do not start another attempt.
  // Every viewer opening a trailer during a block would otherwise fire one
  // more request at a blocked IP and deepen it - the production twin of the
  // hand-retry loop tools/yt_guard.py exists to stop. Answer with the message
  // the daemon would have produced, and record nothing: this is a refusal, not
  // a failure. Duration and reasoning: BOT_WALL_HOLD_MS in lib/downloadHealth.ts.
  const hold = await shouldHoldDownloads();
  if (hold.hold) {
    res.write(`data: ${JSON.stringify({ error: 'YouTube rate-limited this server, try again later', holdUntil: hold.until })}\n\n`);
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
    return;
  }

  // Cache miss - translate via daemon
  if (activeTranslations >= MAX_CONCURRENT) {
    res.write(`data: ${JSON.stringify({ error: 'Server busy, try again shortly' })}\n\n`);
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
    return;
  }
  activeTranslations++;

  const rid = crypto.randomUUID();

  // Register in-flight BEFORE awaiting daemon so concurrent requests can find it
  let inFlightResolve: () => void;
  const inFlightPromise = new Promise<void>((resolve) => { inFlightResolve = resolve; });
  inFlightTranslations.set(videoId, { promise: inFlightPromise, resolve: inFlightResolve! });

  try {
    await ensureDaemon();
  } catch (err) {
    activeTranslations = Math.max(0, activeTranslations - 1);
    inFlightTranslations.delete(videoId);
    inFlightResolve!();
    res.write(`data: ${JSON.stringify({ error: 'Failed to start translation daemon' })}\n\n`);
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
    return;
  }

  // Register this SSE response and start collecting segments for caching
  pendingStreams.set(rid, res);
  pendingSegments.set(rid, { videoId, mediaId, segments: [], cache: startSec === 0 });

  // Send translate command to daemon
  sendCommand({ cmd: 'translate', rid, videoId, start: startSec });

  // Client disconnected: cancel the request in the daemon
  req.on('close', () => {
    if (pendingStreams.has(rid)) {
      pendingStreams.delete(rid);
      pendingSegments.delete(rid);
      activeTranslations = Math.max(0, activeTranslations - 1);
      sendCommand({ cmd: 'cancel', rid });
      // Resolve in-flight waiters (they'll find no cache and fall through)
      const flight = inFlightTranslations.get(videoId);
      if (flight) {
        inFlightTranslations.delete(videoId);
        flight.resolve();
      }
    }
  });
});

/**
 * DELETE /cache?videoId=xxx
 * Remove a cached translation (e.g. if it's wrong or corrupt). Admin only.
 * The next play will re-translate on demand.
 */
// Gated by `requireAdmin` (the `User.isAdmin` column), not by an inline
// comparison against ADMIN_USER_ID: an id comparison is wrong in both
// directions once accounts can be promoted and demoted - a promoted admin gets
// 403 and a demoted one still passes. `/admin/subtitles`' delete button calls
// this. Every admin route in this file now goes through the same middleware;
// there are no inline id comparisons left.
router.delete('/cache', requireAuth, requireAdmin, async (req: AuthRequest, res: Response) => {
  const videoId = req.query.videoId as string;
  if (!videoId || !VIDEO_ID_RE.test(videoId)) {
    return res.status(400).json({ error: 'Invalid videoId', code: 'BAD_REQUEST' });
  }
  try {
    await prisma.$executeRawUnsafe(
      `DELETE FROM "SubtitleCache" WHERE "videoId" = ?`,
      videoId
    );
    return res.json({ ok: true, deleted: videoId });
  } catch (err) {
    console.error('[translate/cache]', err);
    return res.status(500).json({ error: 'Failed to delete cache entry', code: 'SERVER_ERROR' });
  }
});

/**
 * PATCH /dismiss?videoId=xxx
 * Mark a video's subtitles as dismissed (e.g. burned-in subs make ours redundant).
 * Persists for all users - if anyone dismisses, future opens default to off.
 */
router.patch('/dismiss', express.json(), async (req: Request, res: Response) => {
  const videoId = req.query.videoId as string;
  if (!videoId || !VIDEO_ID_RE.test(videoId)) {
    return res.status(400).json({ error: 'Invalid videoId', code: 'BAD_REQUEST' });
  }
  const disabled = req.body?.disabled !== false; // default true

  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "SubtitleCache" ("videoId", "subtitlesDisabled")
       VALUES (?, ?)
       ON CONFLICT("videoId") DO UPDATE SET "subtitlesDisabled" = excluded."subtitlesDisabled"`,
      videoId,
      disabled ? 1 : 0
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error('[translate/dismiss]', err);
    return res.status(500).json({ error: 'Failed to save preference', code: 'SERVER_ERROR' });
  }
});

/**
 * POST /upload
 * Upload pre-translated subtitles from a local machine (e.g. GPU translation).
 * Admin only. Upserts into SubtitleCache - upgrades if new model is higher rank.
 * Body: { videoId, mediaId?, modelName, segments: [{start, end, text}, ...] }
 */
// MODEL_RANK lives in lib/subtitleReport.ts - the one TypeScript copy, shared
// with the /report route below. Its Python twin is translate_stream.MODEL_RANK
// (both batch scripts import it) and tools/tests/test_run_verdict.py fails when
// the two disagree; the reasoning is at the constant.

router.post('/upload', express.json({ limit: '5mb' }), requireAuth, requireAdmin, async (req: AuthRequest, res: Response) => {
  const { videoId, mediaId, modelName, segments, hasBurnedInSubs, force } = req.body || {};
  if (!videoId || !VIDEO_ID_RE.test(videoId)) {
    return res.status(400).json({ error: 'Invalid videoId', code: 'BAD_REQUEST' });
  }
  if (!modelName || !segments || !Array.isArray(segments)) {
    return res.status(400).json({ error: 'Missing modelName or segments', code: 'BAD_REQUEST' });
  }

  const newRank = MODEL_RANK[modelName] ?? 0;

  try {
    // Check existing cache entry
    const existing: any[] = await prisma.$queryRawUnsafe(
      `SELECT "modelName" FROM "SubtitleCache" WHERE "videoId" = ? LIMIT 1`,
      videoId
    );

    if (existing.length > 0 && !force) {
      const existingRank = MODEL_RANK[existing[0].modelName] ?? 0;
      if (newRank <= existingRank) {
        return res.json({ ok: true, action: 'skipped', reason: `existing ${existing[0].modelName} >= ${modelName}` });
      }
    }

    const segJson = JSON.stringify(segments);
    const action = existing.length > 0 ? 'upgraded' : 'inserted';

    await prisma.$executeRawUnsafe(
      `INSERT INTO "SubtitleCache" ("videoId", "mediaId", "modelName", "segments", "hasBurnedInSubs")
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT("videoId") DO UPDATE SET
         "mediaId" = COALESCE(excluded."mediaId", "SubtitleCache"."mediaId"),
         "modelName" = excluded."modelName",
         "segments" = excluded."segments",
         "hasBurnedInSubs" = excluded."hasBurnedInSubs"`,
      videoId,
      mediaId ?? null,
      modelName,
      segJson,
      hasBurnedInSubs ? 1 : 0
    );

    return res.json({ ok: true, action });
  } catch (err) {
    console.error('[translate/upload]', err);
    return res.status(500).json({ error: 'Failed to save subtitles', code: 'SERVER_ERROR' });
  }
});

// ---------------------------------------------------------------------------
// Batch pre-translation (admin only)
// ---------------------------------------------------------------------------

// Exported so the scheduler in index.ts can check if a batch is already running
export let batchProcess: ChildProcess | null = null;
export let batchStatus: { running: boolean; season?: string; year?: number; startedAt?: string; log: string[] } = {
  running: false,
  log: [],
};

function getBatchScriptPath(): string {
  return path.resolve(__dirname, '../../scripts/batch_translate.py');
}

/**
 * POST /batch
 * Trigger batch pre-translation for a season. Admin only (user ID 1 by default).
 * Body: { season?: string, year?: number, dryRun?: boolean }
 */
router.post('/batch', express.json(), requireAuth, requireAdmin, async (req: AuthRequest, res: Response) => {
  if (batchProcess && batchStatus.running) {
    return res.status(409).json({ error: 'Batch already running', code: 'BATCH_RUNNING', status: batchStatus });
  }

  const { season, year, dryRun } = req.body || {};
  const args: string[] = [];
  if (season) args.push('--season', String(season).toUpperCase());
  if (year) args.push('--year', String(year));
  if (dryRun) args.push('--dry-run');
  args.push('--cutoff', '23'); // no cutoff when triggered manually (effectively)

  startBatch(args, { season: season || undefined, year: year || undefined });

  return res.json({ ok: true, message: 'Batch started', status: batchStatus });
});

/**
 * Spawn the batch pre-translation script and wire up status tracking. Shared by
 * POST /batch and the auto-scheduler (index.ts) so BOTH paths flip
 * batchStatus.running - otherwise a scheduler-spawned run is invisible to the
 * 409 guard and /batch/status, allowing a concurrent double-run. Callers must
 * check the 409 guard / batchStatus.running first. `args` are the batch script
 * flags after the script path (e.g. ['--cutoff','10']).
 */
export function startBatch(args: string[], meta: { season?: string; year?: number } = {}): void {
  const fullArgs = ['-u', getBatchScriptPath(), ...args]; // -u = unbuffered stdout

  batchStatus = {
    running: true,
    season: meta.season || 'auto',
    year: meta.year || 0,
    startedAt: new Date().toISOString(),
    log: [],
  };

  console.log(`[translate/batch] Starting batch: ${fullArgs.join(' ')}`);

  batchProcess = spawn(PYTHON, fullArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  batchProcess.stdout!.on('data', (chunk: Buffer) => {
    const lines = chunk.toString().split('\n').filter(Boolean);
    for (const line of lines) {
      batchStatus.log.push(line);
      // Keep last 2000 lines - a full 8-hour batch produces ~500-1000 lines
      if (batchStatus.log.length > 2000) batchStatus.log.shift();
    }
  });

  batchProcess.stderr!.on('data', (chunk: Buffer) => {
    console.error('[translate/batch]', chunk.toString());
  });

  batchProcess.on('close', (code) => {
    console.log(`[translate/batch] Batch exited with code ${code}`);
    batchStatus.running = false;
    batchProcess = null;
    void persistBatchRun(code);
  });
}

/** `AppConfig` key holding the last completed batch run. */
const BATCH_RUN_KEY = 'subtitleBatchStatus';

export interface PersistedBatchRun {
  startedAt: string | null;
  finishedAt: string;
  exitCode: number | null;
  season: string | null;
  year: number | null;
  /** Last few log lines. The full 2000-line log stays in memory only. */
  tail: string[];
}

/**
 * Record that a batch finished, so `/admin/subtitles` can still say so later.
 *
 * `batchStatus` is in-memory and a deploy is a restart, which is exactly when
 * someone opens the page wondering whether the job ran - so without this the
 * schedule panel would read "never run" essentially always. Same reason
 * `remoteSweepStatus` is persisted.
 *
 * **Written at both exits, success and failure.** "Ran and failed" must stay
 * distinguishable from "never ran"; recording only clean exits would make a
 * crash-looping batch look like a batch that was never scheduled.
 */
async function persistBatchRun(code: number | null): Promise<void> {
  const run: PersistedBatchRun = {
    startedAt: batchStatus.startedAt ?? null,
    finishedAt: new Date().toISOString(),
    exitCode: code,
    season: batchStatus.season ?? null,
    year: batchStatus.year || null,
    tail: batchStatus.log.slice(-20),
  };
  try {
    await prisma.appConfig.upsert({
      where: { key: BATCH_RUN_KEY },
      update: { value: JSON.stringify(run) },
      create: { key: BATCH_RUN_KEY, value: JSON.stringify(run) },
    });
  } catch (err) {
    // Losing the record must never take the process down - the batch itself
    // already succeeded or failed on its own terms.
    console.error('[translate/batch] could not persist run status:', err);
  }
  // A non-zero exit is the batch's own verdict (run_verdict in
  // translate_stream.py): most downloads failed, or a bot-wall abort. `null`
  // means killed by a signal, which is a failure too. Fires once per child
  // exit by construction, so a restart cannot re-send it.
  if (code !== 0) {
    void alertAdmins(
      `server subtitle batch failed (exit ${code ?? 'signal'})`,
      `The Wednesday medium batch for ${run.season ?? '?'} ${run.year ?? ''} exited ${code ?? 'by signal'} ` +
      `at ${run.finishedAt}.\n\nLast lines:\n${run.tail.join('\n')}\n\n/admin/subtitles has the run record.`,
    );
  }
}

/** The last completed run, or null. A corrupt row parses to null, never throws. */
async function readPersistedBatchRun(): Promise<PersistedBatchRun | null> {
  try {
    const row = await prisma.appConfig.findUnique({ where: { key: BATCH_RUN_KEY } });
    if (!row?.value) return null;
    const parsed = JSON.parse(row.value);
    return parsed && typeof parsed === 'object' ? (parsed as PersistedBatchRun) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The Sunday GPU run reports its own verdict.
//
// The server cannot observe that job - it is a Windows Scheduled Task on the
// owner's PC - so /admin/subtitles could only show "last upload seen", the
// newest champion row. That made a run which produced NOTHING indistinguishable
// from a quiet week: four Sundays running, 46 of 49 downloads failed on a stale
// yt-dlp, the task reported lastResult=0x0, and no surface anywhere said so.
// The script now ends by POSTing here whatever run_verdict decided.
// ---------------------------------------------------------------------------
const LOCAL_RUN_KEY = 'subtitleLocalRunStatus';

export interface PersistedLocalRun {
  reportedAt: string;
  startedAt: string | null;
  exitCode: number;
  line: string;
  attempted: number;
  errors: number;
  kinds: Record<string, number>;
  aborted: boolean;
  /**
   * Set by checkLocalRunSilence() when the silence alert has been sent for THIS
   * report, so it fires once per silence. A new report is written without it
   * (the POST route never sets it), which re-arms the check. Optional so rows
   * stored before the field existed still parse.
   */
  silentAlertedAt?: string | null;
}

function asCount(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1_000_000 ? v : null;
}

/**
 * POST /local-run - admin only. Body: { exitCode, line, attempted, errors, kinds?, aborted?, startedAt? }.
 * Replaces the previous report; there is only ever "the last run".
 */
router.post('/local-run', express.json({ limit: '64kb' }), requireAuth, requireAdmin, async (req: AuthRequest, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const exitCode = asCount(b.exitCode);
  const attempted = asCount(b.attempted);
  const errors = asCount(b.errors);
  const line = typeof b.line === 'string' ? b.line.slice(0, 500) : null;
  if (exitCode === null || exitCode > 255 || attempted === null || errors === null || line === null) {
    return res.status(400).json({ error: 'exitCode (0-255), attempted, errors and line are required', code: 'BAD_REQUEST' });
  }
  const kinds: Record<string, number> = {};
  const kindsIn = b.kinds && typeof b.kinds === 'object' && !Array.isArray(b.kinds) ? (b.kinds as Record<string, unknown>) : {};
  for (const [k, v] of Object.entries(kindsIn).slice(0, 10)) {
    const n = asCount(v);
    if (n !== null) kinds[k.slice(0, 32)] = n;
  }
  const run: PersistedLocalRun = {
    reportedAt: new Date().toISOString(),
    startedAt: typeof b.startedAt === 'string' ? b.startedAt.slice(0, 40) : null,
    exitCode, line, attempted, errors, kinds,
    aborted: b.aborted === true,
  };
  try {
    await prisma.appConfig.upsert({
      where: { key: LOCAL_RUN_KEY },
      update: { value: JSON.stringify(run) },
      create: { key: LOCAL_RUN_KEY, value: JSON.stringify(run) },
    });
  } catch (err) {
    console.error('[translate/local-run] could not persist the run report:', err);
    return res.status(500).json({ error: 'Could not store the run report', code: 'SERVER_ERROR' });
  }
  // One line in the server log either way, loud when it failed: the whole point
  // is that this stops being invisible.
  if (exitCode !== 0) {
    console.warn(`[translate/local-run] the local GPU run reported FAILURE (exit ${exitCode}): ${line}`);
    // Once per report; the script posts once per run.
    void alertAdmins(
      `Sunday subtitle run failed (exit ${exitCode})`,
      `The local large-v3 run reported exit ${exitCode} at ${run.reportedAt}.\n\n${line}\n\n` +
      `${errors} of ${attempted} downloads failed.\n\n/admin/subtitles shows "Last run reported".`,
    );
  } else {
    console.log(`[translate/local-run] ${line}`);
  }
  return res.json({ ok: true });
});

/** The last report, or null. A corrupt row parses to null, never throws. */
async function readPersistedLocalRun(): Promise<PersistedLocalRun | null> {
  try {
    const row = await prisma.appConfig.findUnique({ where: { key: LOCAL_RUN_KEY } });
    if (!row?.value) return null;
    const parsed = JSON.parse(row.value);
    return parsed && typeof parsed === 'object' ? (parsed as PersistedLocalRun) : null;
  } catch {
    return null;
  }
}

/**
 * Daily: has the Sunday GPU run gone quiet?
 *
 * A run that never happens is the failure mode the log showed for a month -
 * the task fired, downloaded nothing, and exited 0 - and now that a run
 * reports itself, NOT reporting is the remaining way to be invisible. So once a
 * day: if the last report is older than LOCAL_RUN_SILENT_DAYS and nobody has
 * been told about this particular silence, mail the admins and stamp the row.
 *
 * Always logs exactly one line (the Sonarr rule: a silent daily job is
 * indistinguishable from one that never ran). Never throws - it runs on a
 * timer and a failure here must not become a second incident.
 */
export async function checkLocalRunSilence(): Promise<void> {
  try {
    const run = await readPersistedLocalRun();
    const state = localRunSilence(run);
    if (state === 'never') {
      console.log('[translate/local-run] no Sunday run has ever reported; silence cannot be judged yet');
      return;
    }
    if (state !== 'silent') {
      console.log(`[translate/local-run] Sunday run last reported ${run!.reportedAt} (${state})`);
      return;
    }
    // Stamp first, then mail: if the mail fails we would rather stay quiet than
    // re-alert every day, and the log line below is loud regardless.
    const stamped: PersistedLocalRun = { ...run!, silentAlertedAt: new Date().toISOString() };
    await prisma.appConfig.upsert({
      where: { key: LOCAL_RUN_KEY },
      update: { value: JSON.stringify(stamped) },
      create: { key: LOCAL_RUN_KEY, value: JSON.stringify(stamped) },
    });
    console.warn(`[translate/local-run] the Sunday GPU run has not reported since ${run!.reportedAt}`);
    void alertAdmins(
      'Sunday subtitle run has not reported',
      `The local large-v3 run last reported at ${run!.reportedAt} (${run!.line}).\n\n` +
      `It runs weekly; more than ${LOCAL_RUN_SILENT_DAYS} days without a report means the Scheduled Task did not ` +
      `fire or could not reach the server. Check Task Scheduler on the PC and tools/logs/translate.log.`,
    );
  } catch (err: any) {
    console.warn(`[translate/local-run] silence check could not run: ${err?.message ?? err}`);
  }
}

/**
 * GET /batch/status
 * Check the status of the current/last batch run. Admin only.
 */
router.get('/batch/status', requireAuth, requireAdmin, async (req: AuthRequest, res: Response) => {
  return res.json(batchStatus);
});

// ---------------------------------------------------------------------------
// GET /report - everything /admin/subtitles renders, in one payload
// ---------------------------------------------------------------------------

/** SQLite COUNT() comes back as BigInt through raw queries. */
function num(v: unknown): number {
  return typeof v === 'bigint' ? Number(v) : Number(v ?? 0);
}

/** null stays null - "we never checked" is not "we checked and it was false". */
function bool(v: unknown): boolean | null {
  return v === null || v === undefined ? null : Boolean(v);
}

function iso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

/**
 * One cached season, and whether it was cached at all.
 *
 * **Reads the `''` format key**, the unfiltered season. The `'TV'` row would
 * silently drop every TV_SHORT - the same trap `routes/sonarr.ts` documents.
 *
 * `cached: false` (no row) is deliberately distinct from a row holding `[]`.
 * The second means "we asked and there is nothing yet"; only the first means we
 * never asked, and the page must not render them the same way.
 */
async function readCachedSeasonEntries(
  ref: SeasonRef
): Promise<{ cached: boolean; entries: SeasonEntry[] }> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT data
       FROM   "SeasonCache"
       WHERE  season = ?
       AND    year   = ?
       AND    format = ?
       LIMIT  1`,
    ref.season,
    ref.year,
    ''
  )) as Array<{ data: string }>;

  if (rows.length === 0) return { cached: false, entries: [] };
  try {
    const parsed = JSON.parse(rows[0].data);
    return { cached: true, entries: Array.isArray(parsed) ? parsed : [] };
  } catch {
    console.warn(`[translate/report] unparseable SeasonCache row for ${ref.season} ${ref.year}`);
    return { cached: true, entries: [] };
  }
}

/** Both or neither, and both valid - the same contract as `/api/sonarr`'s. */
function seasonOverride(
  season: string | undefined,
  year: string | undefined
): { error: string } | { refs: SeasonRef[] | null } {
  if ((season && !year) || (!season && year)) {
    return { error: 'Provide both "season" and "year", or neither' };
  }
  if (season && year) {
    if (!isValidSeason(season) || !isValidYear(year)) return { error: 'Invalid season or year' };
    return { refs: [{ season: season.toUpperCase() as Season, year: Number(year) }] };
  }
  return { refs: null };
}

/**
 * The state of the trailer subtitle pipeline: overall totals, the schedule, and
 * this season plus the next broken down per trailer.
 *
 * **Reads `SeasonCache` only, and never triggers a cold AniList fetch** - the
 * same rule as `/api/sonarr`. It serves a stale row happily; freshness is
 * irrelevant to "what have we translated", and AniList's ~30/min budget is
 * shared with every viewer.
 *
 * Everything the page shows about the *Sunday* local GPU run is inference from
 * uploaded rows, never a claimed run: that job is a Windows Scheduled Task on
 * someone's PC and this server has no record it fired.
 */
router.get('/report', requireAuth, requireAdmin, async (req: AuthRequest, res: Response) => {
  const { season, year } = req.query as { season?: string; year?: string };
  const override = seasonOverride(season, year);
  if ('error' in override) {
    return res.status(400).json({ error: override.error, code: 'BAD_REQUEST' });
  }

  try {
    const now = new Date();
    const refs = override.refs ?? seasonsForSonarr(now);

    // The whole cache is a few hundred rows (423 on this deployment), so it is
    // loaded once and joined in memory. `segments` itself is never selected -
    // it is a JSON blob per video and only its length matters here.
    const cacheRows = (await prisma.$queryRawUnsafe(
      `SELECT "videoId", "modelName", "hasEnglishSubs", "hasBurnedInSubs",
              "subtitlesDisabled", "lastEnCheckAt", "createdAt",
              CASE WHEN "segments" IS NULL THEN NULL
                   ELSE json_array_length("segments") END AS "segmentCount"
         FROM "SubtitleCache"`
    )) as Array<Record<string, unknown>>;

    const byVideoId = new Map<string, SubtitleRow>();
    for (const r of cacheRows) {
      const videoId = String(r.videoId);
      byVideoId.set(videoId, {
        videoId,
        modelName: r.modelName === null || r.modelName === undefined ? null : String(r.modelName),
        hasEnglishSubs: bool(r.hasEnglishSubs),
        hasBurnedInSubs: bool(r.hasBurnedInSubs),
        subtitlesDisabled: bool(r.subtitlesDisabled),
        segmentCount: r.segmentCount === null || r.segmentCount === undefined ? null : num(r.segmentCount),
        lastEnCheckAt: iso(r.lastEnCheckAt),
        createdAt: iso(r.createdAt),
      });
    }

    const seasonInputs: SeasonInput[] = [];
    for (const ref of refs) {
      const { cached, entries } = await readCachedSeasonEntries(ref);
      seasonInputs.push({ season: ref.season, year: ref.year, cached, entries });
    }
    const report = buildSubtitleReport(seasonInputs, byVideoId);

    // Overall totals cover the WHOLE cache, not the two seasons on screen -
    // they are the "is this system healthy" numbers and most of the table is
    // seasons that have long since aired.
    const byModel: Record<string, number> = {};
    let translated = 0;
    let youtubeCc = 0;
    let burnedIn = 0;
    let ourSubsOff = 0;
    let newestAt: string | null = null;
    let lastChampionUploadAt: string | null = null;

    for (const row of byVideoId.values()) {
      const hasSegments = row.segmentCount !== null && row.segmentCount > 0;
      if (hasSegments) {
        translated++;
        const model = row.modelName ?? 'unknown';
        byModel[model] = (byModel[model] ?? 0) + 1;
        if (row.modelName === CHAMPION && row.createdAt && (!lastChampionUploadAt || row.createdAt > lastChampionUploadAt)) {
          lastChampionUploadAt = row.createdAt;
        }
      }
      if (row.hasEnglishSubs) youtubeCc++;
      if (row.hasBurnedInSubs) burnedIn++;
      if (row.subtitlesDisabled) ourSubsOff++;
      if (row.createdAt && (!newestAt || row.createdAt > newestAt)) newestAt = row.createdAt;
    }

    // Derived from the same ladder the upload path uses, so "needs redoing" here
    // and "will be upgraded" there can never disagree.
    const belowChampion = Object.entries(byModel)
      .filter(([model]) => isBelowChampion(model === 'unknown' ? null : model))
      .reduce((sum, [, n]) => sum + n, 0);

    // Is the download path working? Cheap (one AppConfig row) and the whole
    // reason it is on this page: the 2026-09 outage was invisible for months
    // because nothing anywhere reported that downloads had stopped.
    const download = await getDownloadHealth();

    return res.json({
      download,
      overall: {
        tracked: byVideoId.size,
        translated,
        youtubeCc,
        burnedIn,
        ourSubsOff,
        belowChampion,
        byModel,
        newestAt,
      },
      schedule: {
        wednesday: describeBatchSchedule(now),
        live: {
          running: batchStatus.running,
          season: batchStatus.season ?? null,
          year: batchStatus.year || null,
          startedAt: batchStatus.startedAt ?? null,
          tail: batchStatus.log.slice(-20),
        },
        lastRun: await readPersistedBatchRun(),
        // What the Sunday run itself said at its end (POST /local-run), or null
        // if it has never reported. Distinct from lastChampionUploadAt, which is
        // still only "last upload seen".
        lastLocalRun: await readPersistedLocalRun(),
        champion: CHAMPION,
        lastChampionUploadAt,
      },
      seasons: report.seasons,
      rows: report.rows,
    });
  } catch (err) {
    console.error('[translate/report]', err);
    return res.status(500).json({ error: 'Could not build the subtitle report', code: 'SERVER_ERROR' });
  }
});

export default router;
