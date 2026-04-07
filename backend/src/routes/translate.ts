import { Router, Request, Response } from 'express';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import crypto from 'crypto';

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

  if (payload.done || payload.error) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    if (payload.done) {
      pendingStreams.delete(rid);
      activeTranslations = Math.max(0, activeTranslations - 1);
      res.end();
    }
    return;
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
 * GET /check?videoId=xxx
 * Quick check whether a YouTube video has English subtitles.
 * Uses the daemon if already running; otherwise spawns a standalone check
 * and warms up the daemon in the background for the next request.
 */
router.get('/check', async (req: Request, res: Response) => {
  const videoId = req.query.videoId as string;
  if (!videoId || !VIDEO_ID_RE.test(videoId)) {
    return res.status(400).json({ error: 'Invalid videoId' });
  }

  // If daemon is running, use it
  if (daemon && daemonReady) {
    const rid = crypto.randomUUID();
    const result = await new Promise<any>((resolve) => {
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
    return res.json(result);
  }

  // Fallback: standalone spawn (also warms up daemon for next request)
  ensureDaemon().catch(() => {}); // fire and forget

  const py = spawn(PYTHON, [getStreamScriptPath(), 'check', videoId], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  py.stdout!.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });

  py.stderr!.on('data', (chunk: Buffer) => {
    console.error('[translate/check]', chunk.toString());
  });

  py.on('close', () => {
    try {
      const data = JSON.parse(output.trim());
      res.json(data);
    } catch {
      res.status(500).json({ error: 'Failed to check subtitles' });
    }
  });

  py.on('error', (err) => {
    console.error('[translate/check] spawn error:', err.message);
    res.status(500).json({ error: 'Python is not available' });
  });
});

/**
 * GET /stream?videoId=xxx
 * SSE endpoint that streams translated subtitle segments via persistent daemon.
 */
router.get('/stream', async (req: Request, res: Response) => {
  const videoId = req.query.videoId as string;
  if (!videoId || !VIDEO_ID_RE.test(videoId)) {
    return res.status(400).json({ error: 'Invalid videoId' });
  }

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write(':ok\n\n');

  // Concurrency limit
  if (activeTranslations >= MAX_CONCURRENT) {
    res.write(`data: ${JSON.stringify({ error: 'Server busy, try again shortly' })}\n\n`);
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
    return;
  }
  activeTranslations++;

  const rid = crypto.randomUUID();

  try {
    await ensureDaemon();
  } catch (err) {
    activeTranslations = Math.max(0, activeTranslations - 1);
    res.write(`data: ${JSON.stringify({ error: 'Failed to start translation daemon' })}\n\n`);
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
    return;
  }

  // Register this SSE response
  pendingStreams.set(rid, res);

  // Send translate command to daemon
  sendCommand({ cmd: 'translate', rid, videoId });

  // Client disconnected: cancel the request in the daemon
  req.on('close', () => {
    if (pendingStreams.has(rid)) {
      pendingStreams.delete(rid);
      activeTranslations = Math.max(0, activeTranslations - 1);
      sendCommand({ cmd: 'cancel', rid });
    }
  });
});

export default router;
