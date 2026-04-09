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

// Map of request ID → SSE response (for stream requests)
const pendingStreams = new Map<string, Response>();
// Map of request ID → { resolve } (for check requests)
const pendingChecks = new Map<string, { resolve: (data: any) => void }>();
// Map of request ID → collected segments (for caching after translation completes)
const pendingSegments = new Map<string, { videoId: string; mediaId: number | null; segments: any[] }>();
// Track in-flight translations by videoId to deduplicate concurrent requests
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

  // Daemon ready signal
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

  // Route to check handler
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
    if (pending && pending.segments.length > 0) {
      pendingSegments.delete(rid);
      const segJson = JSON.stringify(pending.segments);
      prisma.$executeRawUnsafe(
        `INSERT INTO "SubtitleCache" ("videoId", "mediaId", "modelName", "segments")
         VALUES (?, ?, 'small', ?)
         ON CONFLICT("videoId") DO UPDATE SET
           "mediaId" = COALESCE(excluded."mediaId", "SubtitleCache"."mediaId"),
           "segments" = excluded."segments"`,
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
    } else {
      pendingSegments.delete(rid);
      // Resolve in-flight waiters even if no segments (e.g. silent video)
      if (pending) {
        const inFlight = inFlightTranslations.get(pending.videoId);
        if (inFlight) {
          inFlightTranslations.delete(pending.videoId);
          inFlight.resolve();
        }
      }
    }
    return;
  }

  if (payload.error) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
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
  daemon = null;
  daemonReady = false;
  daemonBuffer = '';

  // Reject all pending checks
  for (const [rid, check] of pendingChecks) {
    check.resolve({ error: 'Daemon exited' });
  }
  pendingChecks.clear();

  // End all pending streams
  for (const [rid, res] of pendingStreams) {
    try {
      res.write(`data: ${JSON.stringify({ error: 'Translation daemon exited' })}\n\n`);
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    } catch {}
  }
  pendingStreams.clear();
  pendingSegments.clear();
  activeTranslations = 0;
}

function ensureDaemon(): Promise<void> {
  if (daemon && daemonReady) return Promise.resolve();

  if (daemon && !daemonReady) {
    // Daemon is starting up, wait for ready
    return new Promise<void>((resolve) => readyResolvers.push(resolve));
  }

  // Spawn new daemon
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

// Kill daemon on server shutdown
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
 * GET /check?videoId=xxx&mediaId=yyy
 * Quick check whether a YouTube video has English subtitles.
 * Returns cached result if available; otherwise checks and caches the result.
 */
router.get('/check', async (req: Request, res: Response) => {
  const videoId = req.query.videoId as string;
  if (!videoId || !VIDEO_ID_RE.test(videoId)) {
    return res.status(400).json({ error: 'Invalid videoId' });
  }
  const mediaId = req.query.mediaId ? parseInt(req.query.mediaId as string, 10) : null;

  // Check cache first
  try {
    const cached: any[] = await prisma.$queryRawUnsafe(
      `SELECT "hasEnglishSubs", "subtitlesDisabled", "hasBurnedInSubs", "segments", "modelName" FROM "SubtitleCache" WHERE "videoId" = ? LIMIT 1`,
      videoId
    );
    if (cached.length > 0 && cached[0].hasEnglishSubs !== null) {
      return res.json({
        hasEnglish: Boolean(cached[0].hasEnglishSubs),
        subtitlesDisabled: Boolean(cached[0].subtitlesDisabled),
        hasBurnedInSubs: Boolean(cached[0].hasBurnedInSubs),
        hasCachedSegments: cached[0].segments != null,
        modelName: cached[0].modelName || null,
      });
    }
  } catch (err) {
    console.error('[translate/cache] Check lookup failed:', err);
  }

  // Cache miss — perform the check
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
    ensureDaemon().catch(() => {});

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

  // Cache the result (non-blocking)
  if (result && result.hasEnglish !== undefined) {
    prisma.$executeRawUnsafe(
      `INSERT INTO "SubtitleCache" ("videoId", "mediaId", "hasEnglishSubs")
       VALUES (?, ?, ?)
       ON CONFLICT("videoId") DO UPDATE SET
         "hasEnglishSubs" = excluded."hasEnglishSubs",
         "mediaId" = COALESCE(excluded."mediaId", "SubtitleCache"."mediaId")`,
      videoId,
      mediaId,
      result.hasEnglish ? 1 : 0
    ).catch((err: any) => console.error('[translate/cache] Failed to cache check result:', err));
  }

  return res.json(result);
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
    return res.status(400).json({ error: 'Invalid videoId' });
  }
  const mediaId = req.query.mediaId ? parseInt(req.query.mediaId as string, 10) : null;

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write(':ok\n\n');

  // Check cache first
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
    } catch {}
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
  pendingSegments.set(rid, { videoId, mediaId, segments: [] });

  // Send translate command to daemon
  sendCommand({ cmd: 'translate', rid, videoId });

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
    return res.status(403).json({ error: 'Admin access required' });
  }
  const videoId = req.query.videoId as string;
  if (!videoId || !VIDEO_ID_RE.test(videoId)) {
    return res.status(400).json({ error: 'Invalid videoId' });
  }
  try {
    await prisma.$executeRawUnsafe(
      `DELETE FROM "SubtitleCache" WHERE "videoId" = ?`,
      videoId
    );
    return res.json({ ok: true, deleted: videoId });
  } catch (err) {
    console.error('[translate/cache]', err);
    return res.status(500).json({ error: 'Failed to delete cache entry' });
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
    return res.status(400).json({ error: 'Invalid videoId' });
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
    return res.status(500).json({ error: 'Failed to save preference' });
  }
});

/**
 * POST /upload
 * Upload pre-translated subtitles from a local machine (e.g. GPU translation).
 * Admin only. Upserts into SubtitleCache — upgrades if new model is higher rank.
 * Body: { videoId, mediaId?, modelName, segments: [{start, end, text}, ...] }
 */
const MODEL_RANK: Record<string, number> = { tiny: 0, base: 1, small: 2, medium: 3, 'large-v2': 4, 'large-v3': 5 };

router.post('/upload', express.json({ limit: '5mb' }), requireAuth, async (req: AuthRequest, res: Response) => {
  if (req.userId !== (parseInt(process.env.ADMIN_USER_ID || '1', 10))) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const { videoId, mediaId, modelName, segments, hasBurnedInSubs, force } = req.body || {};
  if (!videoId || !VIDEO_ID_RE.test(videoId)) {
    return res.status(400).json({ error: 'Invalid videoId' });
  }
  if (!modelName || !segments || !Array.isArray(segments)) {
    return res.status(400).json({ error: 'Missing modelName or segments' });
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
    return res.status(500).json({ error: 'Failed to save subtitles' });
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
    return res.status(403).json({ error: 'Admin access required' });
  }

  if (batchProcess && batchStatus.running) {
    return res.status(409).json({ error: 'Batch already running', status: batchStatus });
  }

  const { season, year, dryRun } = req.body || {};
  const args = ['-u', getBatchScriptPath()]; // -u = unbuffered stdout
  if (season) args.push('--season', String(season).toUpperCase());
  if (year) args.push('--year', String(year));
  if (dryRun) args.push('--dry-run');
  args.push('--cutoff', '23'); // no cutoff when triggered manually (effectively)

  batchStatus = {
    running: true,
    season: season || 'auto',
    year: year || 0,
    startedAt: new Date().toISOString(),
    log: [],
  };

  console.log(`[translate/batch] Starting batch: ${args.join(' ')}`);

  batchProcess = spawn(PYTHON, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  batchProcess.stdout!.on('data', (chunk: Buffer) => {
    const lines = chunk.toString().split('\n').filter(Boolean);
    for (const line of lines) {
      batchStatus.log.push(line);
      // Keep only last 200 log lines
      if (batchStatus.log.length > 200) batchStatus.log.shift();
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

  return res.json({ ok: true, message: 'Batch started', status: batchStatus });
});

/**
 * GET /batch/status
 * Check the status of the current/last batch run. Admin only.
 */
router.get('/batch/status', requireAuth, async (req: AuthRequest, res: Response) => {
  if (req.userId !== ADMIN_USER_ID) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  return res.json(batchStatus);
});

export default router;
