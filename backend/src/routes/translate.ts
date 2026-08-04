import { Router, Request, Response } from 'express';
import express from 'express';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import crypto from 'crypto';
import prisma from '../db';
import { requireAuth, AuthRequest } from '../middleware/auth';

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
// (`cache: false` for partial start>0 runs — the batch makes the full version).
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

  // Strip rid before forwarding to client
  const { rid: _rid, ...payload } = data;

  if (payload.done) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    pendingStreams.delete(rid);
    activeTranslations = Math.max(0, activeTranslations - 1);
    res.end();

    // Save collected segments to cache and resolve in-flight waiters
    const pending = pendingSegments.get(rid);
    if (pending && !pending.cache) {
      // Partial run (started mid-playback at start>0) — don't cache it as if it
      // were the full video; the batch produces the complete cached version.
      // Still resolve any in-flight waiters so they fall through and re-translate.
      pendingSegments.delete(rid);
      const inFlight = inFlightTranslations.get(pending.videoId);
      if (inFlight) {
        inFlightTranslations.delete(pending.videoId);
        inFlight.resolve();
      }
    } else if (pending) {  // cache even 0-segment results — prevents re-translating silent videos
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

  // Pending checks resolve WITH an error (not reject) — callers treat any
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

  const known = new Map<string, number>(rows.map((r: any) => [r.videoId, Number(r.hasEnglishSubs)]));

  // Return confirmed positives immediately
  const result: Record<string, boolean> = {};
  for (const id of ids) {
    if (known.get(id) === 1) result[id] = true;
  }
  res.json(result);

  // Background: queue Python checks for IDs not in DB at all so the cache
  // self-populates while the user browses. Bounded concurrency — a burst of
  // ~80 parallel youtube_transcript_api hits from one IP trips YouTube's bot
  // wall and poisons results with false negatives.
  const uncached = ids.filter(id => !known.has(id));
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
        if (checkResult?.hasEnglish !== undefined) {
          // Stamp lastEnCheckAt so the /check 7-day negative-recheck logic
          // trusts this batch-populated row (it ignores negatives with a null
          // timestamp, otherwise re-hitting YouTube on the first modal open).
          prisma.$executeRawUnsafe(
            `INSERT INTO "SubtitleCache" ("videoId", "hasEnglishSubs", "lastEnCheckAt") VALUES (?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT("videoId") DO UPDATE SET
               "hasEnglishSubs" = CASE WHEN excluded."hasEnglishSubs" = 1 THEN 1 ELSE "SubtitleCache"."hasEnglishSubs" END,
               "lastEnCheckAt" = CURRENT_TIMESTAMP`,
            videoId, checkResult.hasEnglish ? 1 : 0
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
  // "1 per uncached video per week" instead of "every play" — the rate-limit
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
          // Negative is fresh — trust it, skip the YouTube hit
          return res.json({ hasEnglish: false, ...cachedExtra });
        }
        // Otherwise: stale negative, fall through to re-check
      }
    }
  } catch (err) {
    console.error('[translate/cache] Check lookup failed:', err);
  }

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
  // days. Only update hasEnglishSubs when the new value is true — never
  // overwrite a correct true with a potentially wrong false from a transient
  // network failure.
  if (result && result.hasEnglish !== undefined) {
    prisma.$executeRawUnsafe(
      `INSERT INTO "SubtitleCache" ("videoId", "mediaId", "hasEnglishSubs", "lastEnCheckAt")
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT("videoId") DO UPDATE SET
         "hasEnglishSubs" = CASE WHEN excluded."hasEnglishSubs" = 1 THEN 1 ELSE "SubtitleCache"."hasEnglishSubs" END,
         "mediaId" = COALESCE(excluded."mediaId", "SubtitleCache"."mediaId"),
         "lastEnCheckAt" = CURRENT_TIMESTAMP`,
      videoId,
      mediaId,
      result.hasEnglish ? 1 : 0
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
      // Stream cached segments immediately — no daemon needed
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
      // Translation finished — serve from cache
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

  // Cache miss — translate via daemon
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
router.delete('/cache', requireAuth, async (req: AuthRequest, res: Response) => {
  if (req.userId !== (parseInt(process.env.ADMIN_USER_ID || '1', 10))) {
    return res.status(403).json({ error: 'Admin access required', code: 'ADMIN_REQUIRED' });
  }
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
 * Persists for all users — if anyone dismisses, future opens default to off.
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
 * Admin only. Upserts into SubtitleCache — upgrades if new model is higher rank.
 * Body: { videoId, mediaId?, modelName, segments: [{start, end, text}, ...] }
 */
// 'large-v3-split' (6) = local champion pipeline (Demucs vocals + large-v3
// transcribe + qwen3.5 translate); outranks plain 'large-v3' so it auto-upgrades
// existing entries. Keep in sync with MODEL_RANK in tools/local_translate.py.
const MODEL_RANK: Record<string, number> = { tiny: 0, base: 1, small: 2, medium: 3, 'large-v2': 4, 'large-v3': 5, 'large-v3-split': 6 };

router.post('/upload', express.json({ limit: '5mb' }), requireAuth, async (req: AuthRequest, res: Response) => {
  if (req.userId !== (parseInt(process.env.ADMIN_USER_ID || '1', 10))) {
    return res.status(403).json({ error: 'Admin access required', code: 'ADMIN_REQUIRED' });
  }

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

const ADMIN_USER_ID = parseInt(process.env.ADMIN_USER_ID || '1', 10);
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
router.post('/batch', express.json(), requireAuth, async (req: AuthRequest, res: Response) => {
  if (req.userId !== ADMIN_USER_ID) {
    return res.status(403).json({ error: 'Admin access required', code: 'ADMIN_REQUIRED' });
  }

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
 * batchStatus.running — otherwise a scheduler-spawned run is invisible to the
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
      // Keep last 2000 lines — a full 8-hour batch produces ~500-1000 lines
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
  });
}

/**
 * GET /batch/status
 * Check the status of the current/last batch run. Admin only.
 */
router.get('/batch/status', requireAuth, async (req: AuthRequest, res: Response) => {
  if (req.userId !== ADMIN_USER_ID) {
    return res.status(403).json({ error: 'Admin access required', code: 'ADMIN_REQUIRED' });
  }

  return res.json(batchStatus);
});

export default router;
