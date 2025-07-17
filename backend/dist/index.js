"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = __importDefault(require("dotenv"));
// Load env variables FIRST so later imports (Prisma client) see final value.
dotenv_1.default.config();
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const compression_1 = __importDefault(require("compression"));
const helmet_1 = __importDefault(require("helmet"));
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const anime_1 = __importDefault(require("./routes/anime"));
const auth_1 = __importDefault(require("./routes/auth"));
const list_1 = __importDefault(require("./routes/list"));
const publicList_1 = __importDefault(require("./routes/publicList"));
const users_1 = __importDefault(require("./routes/users"));
const options_1 = __importDefault(require("./routes/options"));
const db_1 = __importDefault(require("./db"));
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const app = (0, express_1.default)();
// Trust only loopback proxies (our internal Nginx). This prevents forged
// X-Forwarded-For headers from external requests while still allowing the
// rate-limit middleware to see the real client IP.
app.set('trust proxy', 'loopback');
app.use((0, cors_1.default)());
app.use((0, helmet_1.default)());
app.use((0, compression_1.default)());
// ────────────────────────────────────────────────────────────────────────────
// Rate limiting
// ────────────────────────────────────────────────────────────────────────────
// General limiter: 120 requests per minute per IP
const generalLimiter = (0, express_rate_limit_1.default)({
    windowMs: 60000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false
});
app.use(generalLimiter);
app.use(express_1.default.json());
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
            await db_1.default.$executeRawUnsafe('PRAGMA cache_size = -8000;'); // 8 MiB
        }
        catch (e) {
            console.warn('[DB] Failed to set PRAGMA cache_size', e);
        }
        // -------------------------- User table ---------------------------
        const userRows = await db_1.default.$queryRaw `SELECT name FROM sqlite_master WHERE type='table' AND name='User' LIMIT 1;`;
        if (userRows.length === 0) {
            console.log('[DB] Creating User table');
            await db_1.default.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "User" (
          "id"        INTEGER PRIMARY KEY AUTOINCREMENT,
          "username"  TEXT    NOT NULL UNIQUE,
          "password"  TEXT    NOT NULL,
          "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
            console.log('[DB] User table created ✅');
        }
        const rows = await db_1.default.$queryRaw `SELECT name FROM sqlite_master WHERE type='table' AND name='WatchList' LIMIT 1;`;
        const tableMissing = rows.length === 0;
        if (tableMissing) {
            console.log('[DB] Creating WatchList table');
            await db_1.default.$executeRawUnsafe(`
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
            await db_1.default.$executeRawUnsafe(`
        CREATE UNIQUE INDEX IF NOT EXISTS "WatchList_userId_season_year_mediaId" 
        ON "WatchList" ("userId", "season", "year", "mediaId");
      `);
            // Cache table for AniList responses (season-level)
            await db_1.default.$executeRawUnsafe(`
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
        const cacheRows = await db_1.default.$queryRaw `SELECT name FROM sqlite_master WHERE type='table' AND name='SeasonCache' LIMIT 1;`;
        if (cacheRows.length === 0) {
            console.log('[DB] Creating SeasonCache table');
            await db_1.default.$executeRawUnsafe(`
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
        const columns = await db_1.default.$queryRaw `PRAGMA table_info('WatchList');`;
        const hasCustom = columns.some((c) => c.name === 'customName');
        if (!hasCustom) {
            console.log('[DB] Adding customName column');
            await db_1.default.$executeRawUnsafe(`ALTER TABLE "WatchList" ADD COLUMN "customName" TEXT`);
        }
        const hasWatched = columns.some((c) => c.name === 'watched');
        if (!hasWatched) {
            console.log('[DB] Adding watched column');
            await db_1.default.$executeRawUnsafe(`ALTER TABLE "WatchList" ADD COLUMN "watched" BOOLEAN NOT NULL DEFAULT 0`);
        }
        const hasWatchedAt = columns.some((c) => c.name === 'watchedAt');
        if (!hasWatchedAt) {
            console.log('[DB] Adding watchedAt column');
            await db_1.default.$executeRawUnsafe(`ALTER TABLE "WatchList" ADD COLUMN "watchedAt" DATETIME`);
        }
        const hasWatchedRank = columns.some((c) => c.name === 'watchedRank');
        if (!hasWatchedRank) {
            console.log('[DB] Adding watchedRank column');
            await db_1.default.$executeRawUnsafe(`ALTER TABLE "WatchList" ADD COLUMN "watchedRank" INTEGER`);
            // Seed existing watched rows so oldest watched gets rank 0,1,… per season/year
            await db_1.default.$executeRawUnsafe(`
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
        // -------------------------- Settings table ---------------------------
        const settingsRows = await db_1.default.$queryRaw `SELECT name FROM sqlite_master WHERE type='table' AND name='Settings' LIMIT 1;`;
        if (settingsRows.length === 0) {
            console.log('[DB] Creating Settings table');
            await db_1.default.$executeRawUnsafe(`
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
            const settingCols = await db_1.default.$queryRaw `PRAGMA table_info('Settings');`;
            const hasNickSel = settingCols.some((c) => c.name === 'nicknameUserSel');
            if (!hasNickSel) {
                console.log('[DB] Adding nicknameUserSel column');
                await db_1.default.$executeRawUnsafe(`ALTER TABLE "Settings" ADD COLUMN "nicknameUserSel" TEXT`);
            }
        }
        // ────────────────────────────────────────────────────────────────
        // Seed missing Settings rows for existing users
        // ────────────────────────────────────────────────────────────────
        try {
            const missingUserIds = await db_1.default.$queryRaw `
        SELECT id FROM "User" WHERE id NOT IN (SELECT userId FROM "Settings");
      `;
            if (missingUserIds.length > 0) {
                console.log(`[DB] Inserting default Settings for ${missingUserIds.length} user(s)`);
                for (const { id } of missingUserIds) {
                    await db_1.default.$executeRawUnsafe(`INSERT INTO "Settings" ("userId", "theme", "titleLanguage", "videoAutoplay", "hideFromCompare", "nicknameUserSel") VALUES (${id}, 'SYSTEM', 'ENGLISH', 1, 0, '[]');`);
                }
            }
        }
        catch (err) {
            console.warn('[DB] Failed to seed default Settings rows', err);
        }
    }
    catch (err) {
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
    app.use('/api/anime', anime_1.default);
    const authLimiter = (0, express_rate_limit_1.default)({
        windowMs: 60000, // 1 minute
        max: 20,
        message: { error: 'Too many requests, please slow down.' },
        standardHeaders: true,
        legacyHeaders: false
    });
    app.use('/api/auth', authLimiter, auth_1.default);
    app.use('/api/list', list_1.default);
    app.use('/api/public-list', publicList_1.default);
    app.use('/api/users', users_1.default);
    // User-specific UI preferences
    app.use('/api/options', options_1.default);
    app.listen(PORT, () => {
        console.log(`Backend listening on http://localhost:${PORT}`);
    });
    // Graceful shutdown so Prisma disconnects cleanly and no zombie handles.
    const signals = ['SIGTERM', 'SIGINT'];
    signals.forEach((sig) => process.on(sig, async () => {
        console.log(`\n[Server] ${sig} received – shutting down`);
        await db_1.default.$disconnect();
        process.exit(0);
    }));
});
