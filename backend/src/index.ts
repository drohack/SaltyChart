import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

import animeRouter from './routes/anime';
import authRouter from './routes/auth';
import listRouter from './routes/list';
import { PrismaClient } from '@prisma/client';

// Load env vars (optional in dev)
dotenv.config();

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

const app = express();

app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────────────────────────────────────
// Dev-only helper: ensure `WatchList` table exists.
// ─────────────────────────────────────────────────────────────────────────────
async function ensureDatabaseSchema() {
  const prisma = new PrismaClient();
  try {
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
  } catch (err) {
    console.error('[DB] Failed to ensure schema', err);
  } finally {
    await prisma.$disconnect();
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
  app.use('/api/auth', authRouter);
  app.use('/api/list', listRouter);

  app.listen(PORT, () => {
    console.log(`Backend listening on http://localhost:${PORT}`);
  });
});
