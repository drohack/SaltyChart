import dotenv from 'dotenv';
// Load env variables FIRST so later imports (Prisma client) see final value.
dotenv.config();

// ---------------------------------------------------------------------------
// Networking tweaks
// ---------------------------------------------------------------------------
// In certain production environments (e.g. Docker on hosts with broken or
// fire-walled IPv6 connectivity) Node may resolve an IPv6 address for a remote
// service, attempt to connect, then fall back to IPv4 after several seconds.
// This manifests as a ~6-7 s delay on the first outgoing HTTP request even
// though the target service (AniList API in our case) is fast and reachable.
//
// To avoid the stall we instruct Node’s DNS resolver to prefer IPv4 addresses
// while still returning IPv6 when no v4 is available.  The same behaviour can
// be achieved via the environment variable:
//   NODE_OPTIONS=--dns-result-order=ipv4first
// Adding it programmatically here keeps the container self-contained and
// requires no additional deployment changes.
//
// Reference: https://nodejs.org/api/dns.html#dnspromisessetdefaultresultorderorder
import dns from 'node:dns';

try {
  // Supported since Node 18.  Guarded so local older runtimes don’t crash.
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore – `setDefaultResultOrder` is available at runtime.
  if (typeof dns.setDefaultResultOrder === 'function') {
    dns.setDefaultResultOrder('ipv4first');
  }
} catch {
  /* noop */
}

import express from 'express';
import cors from 'cors';
import compression from 'compression';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

import animeRouter from './routes/anime';
import authRouter from './routes/auth';
import listRouter from './routes/list';
import publicListRouter from './routes/publicList';
import usersRouter from './routes/users';
import optionsRouter from './routes/options';
import prisma from './db';

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

const app = express();

// Trust only loopback proxies (our internal Nginx). This prevents forged
// X-Forwarded-For headers from external requests while still allowing the
// rate-limit middleware to see the real client IP.
app.set('trust proxy', 'loopback');

app.use(cors());
app.use(helmet());
app.use(compression());

// ────────────────────────────────────────────────────────────────────────────
// Rate limiting
// ────────────────────────────────────────────────────────────────────────────

// General limiter: 120 requests per minute per IP
const generalLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false
});

app.use(generalLimiter);
app.use(express.json());

// ─────────────────────────────────────────────────────────────────────────────
// Dev-only helper: ensure `WatchList` table exists.
// ─────────────────────────────────────────────────────────────────────────────
async function ensureDatabaseSchema() {
  // Re-use the singleton Prisma instance so we keep a single connection pool
  // across the entire application.
  try {
    // Increase SQLite in-memory page cache (~8 MB) to reduce disk I/O on slow
    // volumes.  Negative value expresses size in kibibytes.
    try {
      await prisma.$queryRawUnsafe('PRAGMA cache_size = -8000;'); // 8 MiB (returns new size)
    } catch (e) {
      console.warn('[DB] Failed to set PRAGMA cache_size', e);
    }

    // Switch to WAL journal for concurrent reads while a write is in progress
    // and relax fsync guarantees from FULL (default) to NORMAL.  On typical
    // home-server HDDs this cuts small write transactions from >3 s down to
    // a few milliseconds without risking corruption in practice.
    try {
      // Some PRAGMA statements (e.g., journal_mode) *return* the resulting mode
      // which makes Prisma complain when called via `$executeRaw*`.  We switch
      // to `$queryRawUnsafe` and simply ignore the returned rows so the call
      // works both locally and in production.
      await prisma.$queryRawUnsafe("PRAGMA journal_mode = WAL;");
      await prisma.$queryRawUnsafe("PRAGMA synchronous = NORMAL;");
    } catch (e) {
      console.warn('[DB] Failed to tune SQLite performance', e);
    }
    // -------------------------- User table ---------------------------
    const userRows: Array<{ name: string }> =
      await prisma.$queryRaw`SELECT name FROM sqlite_master WHERE type='table' AND name='User' LIMIT 1;`;
    if (userRows.length === 0) {
      console.log('[DB] Creating User table');
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "User" (
          "id"        INTEGER PRIMARY KEY AUTOINCREMENT,
          "username"  TEXT    NOT NULL UNIQUE,
          "password"  TEXT    NOT NULL,
          "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
      console.log('[DB] User table created ✅');
    }

    const rows: Array<{ name: string }> = await prisma.$queryRaw`SELECT name FROM sqlite_master WHERE type='table' AND name='WatchList' LIMIT 1;`;
    const tableMissing = rows.length === 0;

    if (tableMissing) {
      console.log('[DB] Creating WatchList table');

      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "WatchList" (
          "id"        INTEGER PRIMARY KEY AUTOINCREMENT,
          "userId"    INTEGER NOT NULL,
          "season"    TEXT    NOT NULL,
          "year"      INTEGER NOT NULL,
          "mediaId"   INTEGER NOT NULL,
          "order"     INTEGER NOT NULL,
          "customName" TEXT,
          "watched"    BOOLEAN NOT NULL DEFAULT 0,
          "hidden"     BOOLEAN NOT NULL DEFAULT 0,
          "watchedAt" DATETIME,
          "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE
        );
      `);

      // ────────────────────────────────────────────────────────────
      // Schema upgrade: add `customName` column if missing
      // ────────────────────────────────────────────────────────────
      // (Column migration handled globally below)

      await prisma.$executeRawUnsafe(`
        CREATE UNIQUE INDEX IF NOT EXISTS "WatchList_userId_season_year_mediaId" 
        ON "WatchList" ("userId", "season", "year", "mediaId");
      `);

      // Cache table for AniList responses (season-level)
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "SeasonCache" (
          "season"  TEXT NOT NULL,
          "year"    INTEGER NOT NULL,
          "format"  TEXT,
          "data"    TEXT NOT NULL,
          "updatedAt" DATETIME NOT NULL,
          PRIMARY KEY ("season", "year", "format")
        );
      `);


      console.log('[DB] WatchList table created ✅');
    }

    // ----------------------- SeasonCache table -----------------------
    const cacheRows: Array<{ name: string }> =
      await prisma.$queryRaw`SELECT name FROM sqlite_master WHERE type='table' AND name='SeasonCache' LIMIT 1;`;
    if (cacheRows.length === 0) {
      console.log('[DB] Creating SeasonCache table');
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "SeasonCache" (
          "season"    TEXT    NOT NULL,
          "year"      INTEGER NOT NULL,
          "format"    TEXT,
          "data"      TEXT    NOT NULL,
          "updatedAt" DATETIME NOT NULL,
          PRIMARY KEY ("season", "year", "format")
        );
      `);
    }

    // Column migrations (run regardless of table creation)
    const columns: Array<{ name: string }> = await prisma.$queryRaw`PRAGMA table_info('WatchList');`;
    const hasCustom = columns.some((c) => c.name === 'customName');
    if (!hasCustom) {
      console.log('[DB] Adding customName column');
      await prisma.$executeRawUnsafe(`ALTER TABLE "WatchList" ADD COLUMN "customName" TEXT`);
    }

    const hasWatched = columns.some((c) => c.name === 'watched');
    if (!hasWatched) {
      console.log('[DB] Adding watched column');
      await prisma.$executeRawUnsafe(`ALTER TABLE "WatchList" ADD COLUMN "watched" BOOLEAN NOT NULL DEFAULT 0`);
    }

    const hasWatchedAt = columns.some((c) => c.name === 'watchedAt');
    if (!hasWatchedAt) {
      console.log('[DB] Adding watchedAt column');
      await prisma.$executeRawUnsafe(`ALTER TABLE "WatchList" ADD COLUMN "watchedAt" DATETIME`);
    }

    const hasWatchedRank = columns.some((c) => c.name === 'watchedRank');
    if (!hasWatchedRank) {
      console.log('[DB] Adding watchedRank column');
      await prisma.$executeRawUnsafe(`ALTER TABLE "WatchList" ADD COLUMN "watchedRank" INTEGER`);

      // Seed existing watched rows so oldest watched gets rank 0,1,… per season/year
      await prisma.$executeRawUnsafe(`
        WITH ranked AS (
          SELECT id,
                 ROW_NUMBER() OVER (PARTITION BY userId, season, year ORDER BY watchedAt) - 1 AS rnk
          FROM   WatchList
          WHERE  watched = 1 AND watchedAt IS NOT NULL
        )
        UPDATE WatchList SET watchedRank = (SELECT rnk FROM ranked WHERE ranked.id = WatchList.id)
        WHERE id IN (SELECT id FROM ranked);
      `);
    }

    const hasHidden = columns.some((c) => c.name === 'hidden');
    if (!hasHidden) {
      console.log('[DB] Adding hidden column');
      await prisma.$executeRawUnsafe(`ALTER TABLE "WatchList" ADD COLUMN "hidden" BOOLEAN NOT NULL DEFAULT 0`);
    }
    // -------------------------- Settings table ---------------------------
    const settingsRows: Array<{ name: string }> =
      await prisma.$queryRaw`SELECT name FROM sqlite_master WHERE type='table' AND name='Settings' LIMIT 1;`;
    if (settingsRows.length === 0) {
      console.log('[DB] Creating Settings table');
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "Settings" (
          "userId" INTEGER NOT NULL PRIMARY KEY,
          "theme" TEXT NOT NULL DEFAULT 'SYSTEM',
          "titleLanguage" TEXT NOT NULL DEFAULT 'ENGLISH',
          "videoAutoplay" BOOLEAN NOT NULL DEFAULT 1,
          "hideFromCompare" BOOLEAN NOT NULL DEFAULT 0,
          "nicknameUserSel" TEXT,
          FOREIGN KEY("userId") REFERENCES "User"("id") ON DELETE CASCADE
        );
      `);
    }

    // Column migration for Settings: nicknameUserSel
    if (settingsRows.length > 0) {
      const settingCols: Array<{ name: string }> = await prisma.$queryRaw`PRAGMA table_info('Settings');`;
      const hasNickSel = settingCols.some((c) => c.name === 'nicknameUserSel');
      if (!hasNickSel) {
        console.log('[DB] Adding nicknameUserSel column');
      await prisma.$executeRawUnsafe(`ALTER TABLE "Settings" ADD COLUMN "nicknameUserSel" TEXT`);
      }
    }

    // ────────────────────────────────────────────────────────────────
    // Seed missing Settings rows for existing users
    // ────────────────────────────────────────────────────────────────
    try {
      const missingUserIds: Array<{ id: number }> = await prisma.$queryRaw`
        SELECT id FROM "User" WHERE id NOT IN (SELECT userId FROM "Settings");
      `;
      if (missingUserIds.length > 0) {
        console.log(`[DB] Inserting default Settings for ${missingUserIds.length} user(s)`);
        for (const { id } of missingUserIds) {
          await prisma.$executeRawUnsafe(
            `INSERT INTO "Settings" ("userId", "theme", "titleLanguage", "videoAutoplay", "hideFromCompare", "nicknameUserSel") VALUES (${id}, 'SYSTEM', 'ENGLISH', 1, 0, '[]');`
          );
        }
      }
    } catch (err) {
      console.warn('[DB] Failed to seed default Settings rows', err);
    }
  } catch (err) {
    console.error('[DB] Failed to ensure schema', err);
  }
}

// Ensure DB schema first, then start server
ensureDatabaseSchema().then(() => {
  // ────────────────────────────────────────────────────────────────────────────
  // Routes
  // ────────────────────────────────────────────────────────────────────────────

  app.get('/api/health', (_, res) => {
    res.json({ status: 'ok' });
  });

  app.use('/api/anime', animeRouter);
  const authLimiter = rateLimit({
    windowMs: 60_000, // 1 minute
    max: 20,
    message: { error: 'Too many requests, please slow down.' },
    standardHeaders: true,
    legacyHeaders: false
  });

  app.use('/api/auth', authLimiter, authRouter);
  app.use('/api/list', listRouter);
  app.use('/api/public-list', publicListRouter);
  app.use('/api/users', usersRouter);
  // User-specific UI preferences
  app.use('/api/options', optionsRouter);

  app.listen(PORT, () => {
    console.log(`Backend listening on http://localhost:${PORT}`);
  });

  // Graceful shutdown so Prisma disconnects cleanly and no zombie handles.
  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];
  signals.forEach((sig) =>
    process.on(sig, async () => {
      console.log(`\n[Server] ${sig} received – shutting down`);
      await prisma.$disconnect();
      process.exit(0);
    })
  );
});
