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
    if (rows.length === 0) {
      console.log('[DB] Creating WatchList table');

      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "WatchList" (
          "id"        INTEGER PRIMARY KEY AUTOINCREMENT,
          "userId"    INTEGER NOT NULL,
          "season"    TEXT    NOT NULL,
          "year"      INTEGER NOT NULL,
          "mediaId"   INTEGER NOT NULL,
          "order"     INTEGER NOT NULL,
          "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE
        );
      `);

      await prisma.$executeRawUnsafe(`
        CREATE UNIQUE INDEX IF NOT EXISTS "WatchList_userId_season_year_mediaId" 
        ON "WatchList" ("userId", "season", "year", "mediaId");
      `);

      console.log('[DB] WatchList table created ✅');
    }
  } catch (err) {
    console.error('[DB] Failed to ensure schema', err);
  } finally {
    await prisma.$disconnect();
  }
}

// Fire-and-forget; Express can start immediately.
ensureDatabaseSchema();

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/health', (_, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/anime', animeRouter);
app.use('/api/auth', authRouter);
app.use('/api/list', listRouter);

app.listen(PORT, () => {
  console.log(`Backend listening on http://localhost:${PORT}`);
});
