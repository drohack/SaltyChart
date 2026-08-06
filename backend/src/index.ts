import dotenv from 'dotenv';
// Load env variables FIRST so later imports (Prisma client) see final value.
// backend/.env provides DATABASE_URL for local dev; Docker injects it via env.
dotenv.config();

if (!process.env.DATABASE_URL) {
  console.error('[FATAL] DATABASE_URL is not set.');
  console.error('[FATAL] Create backend/.env containing: DATABASE_URL=file:./prisma/prisma/data.db');
  process.exit(1);
}

// In production, refuse to boot on a missing or insecure default JWT_SECRET -
// otherwise tokens would be signed with the publicly-known 'dev-secret' and
// anyone could forge an admin token. Dev keeps the fallback for convenience.
if (
  process.env.NODE_ENV === 'production' &&
  (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'dev-secret')
) {
  console.error('[FATAL] JWT_SECRET is unset or the insecure dev default in production.');
  console.error('[FATAL] Set a strong, secret JWT_SECRET in the environment before starting.');
  process.exit(1);
}

// Backstop: a single rejected promise or thrown async error (e.g. a bad request
// body reaching Prisma) must not hard-kill the whole process for every user.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

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
  // @ts-ignore - `setDefaultResultOrder` is available at runtime.
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
import translateRouter, { startBatch, batchStatus } from './routes/translate';
import jellyfinRouter from './routes/jellyfin';
import { ensureAnilistTvdbMap } from './lib/anilistTvdbMap';
import { loadIdentityOverrides } from './lib/seriesIdentity';
import { getJellyfinConfig, triggerSweep } from './routes/jellyfin';
import { getFilmIndex } from './lib/jellyfinFilmIndex';
import { jellyfinApi } from './lib/jellyfinApi';
import prisma from './db';

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

const app = express();

// Trust only loopback proxies (our internal Nginx). This prevents forged
// X-Forwarded-For headers from external requests while still allowing the
// rate-limit middleware to see the real client IP.
app.set('trust proxy', 'loopback');

app.use(cors());
app.use(helmet());

// ----------------------------------------------------------------------------
// Rate limiting
// ----------------------------------------------------------------------------

// General limiter: 120 requests per minute per IP. Disabled in dev so the
// parallel pre-deploy test suite doesn't trip it. Defined before the translate
// mount below so those routes are covered too.
const _isDev = process.env.NODE_ENV === 'development' || !process.env.NODE_ENV;
const generalLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  message: { error: 'Too many requests, please slow down.', code: 'RATE_LIMITED' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => _isDev,
});

// Register SSE translate route BEFORE compression middleware.
// compression() wraps response streams and buffers them internally,
// which prevents SSE from streaming in real-time to the browser. The rate
// limiter doesn't buffer responses, so it's safe (and necessary) here - the
// unthrottled /check-batch loop otherwise lets a client fan out YouTube hits.
app.use('/api/translate', generalLimiter, translateRouter);

// The Jellyfin router is also registered BEFORE compression(): its /stream/*
// proxy pipes HLS segments, which compression() would buffer. It carries its
// own limiters (120/min JSON endpoints, 600/min stream) and JSON parser
// because the global ones below don't apply to this early mount.
app.use('/api/jellyfin', jellyfinRouter);

app.use(compression());

app.use(generalLimiter);
app.use(express.json());

// -----------------------------------------------------------------------------
// Runtime schema bootstrap - all environments. Production does NOT run
// `prisma migrate`; this raw-SQL path creates tables, adds missing columns,
// builds indexes and drops retired tables idempotently on every startup.
// -----------------------------------------------------------------------------
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

      await prisma.$executeRawUnsafe(`
        CREATE UNIQUE INDEX IF NOT EXISTS "WatchList_userId_season_year_mediaId" 
        ON "WatchList" ("userId", "season", "year", "mediaId");
      `);

      console.log('[DB] WatchList table created ✅');
    }
    // SeasonCache is created in its own standalone block below so fresh
    // and existing DBs take the same path.

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

      // Seed existing watched rows so oldest watched gets rank 0,1,... per season/year
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
          "addWatchedTo" TEXT NOT NULL DEFAULT 'BOTTOM',
          "subtitlePrefs" TEXT,
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

      // Column migration for Settings: addWatchedTo
      const hasAddWatchedTo = settingCols.some((c) => c.name === 'addWatchedTo');
      if (!hasAddWatchedTo) {
        console.log('[DB] Adding addWatchedTo column');
        await prisma.$executeRawUnsafe(`ALTER TABLE "Settings" ADD COLUMN "addWatchedTo" TEXT NOT NULL DEFAULT 'BOTTOM'`);
      }

      // Column migration for Settings: subtitlePrefs
      const hasSubtitlePrefs = settingCols.some((c) => c.name === 'subtitlePrefs');
      if (!hasSubtitlePrefs) {
        console.log('[DB] Adding subtitlePrefs column');
        await prisma.$executeRawUnsafe(`ALTER TABLE "Settings" ADD COLUMN "subtitlePrefs" TEXT`);
      }
    }

    // ----------------------------------------------------------------
    // Seed missing Settings rows for existing users
    // ----------------------------------------------------------------
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
    // ----------------------- SubtitleCache table -------------------------
    // Caches translated subtitles and English-subtitle check results per YouTube video.
    // - hasEnglishSubs: cached result of /check (null = not checked); negatives
    //   re-checked after 7 days via lastEnCheckAt (added below)
    // - segments: JSON array of {start, end, text} objects (null = not translated)
    // - modelName: Whisper model that produced the segments - drives the
    //   rank-based upgrade in routes/translate.ts (uploads only ever upgrade)
    // - subtitlesDisabled: true if a user dismissed our subtitles
    // - hasBurnedInSubs: OCR-detected burned-in subs (added below); frontend
    //   defaults the overlay off for those
    const subtitleCacheRows: Array<{ name: string }> = await prisma.$queryRaw`
      SELECT name FROM sqlite_master WHERE type='table' AND name='SubtitleCache' LIMIT 1;
    `;
    if (subtitleCacheRows.length === 0) {
      console.log('[DB] Creating SubtitleCache table');
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "SubtitleCache" (
          "id"              INTEGER PRIMARY KEY AUTOINCREMENT,
          "videoId"         TEXT NOT NULL,
          "mediaId"         INTEGER,
          "modelName"       TEXT NOT NULL DEFAULT 'small',
          "hasEnglishSubs"  BOOLEAN,
          "hasBurnedInSubs" BOOLEAN,
          "segments"        TEXT,
          "createdAt"       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
      await prisma.$executeRawUnsafe(`
        CREATE UNIQUE INDEX IF NOT EXISTS "idx_subtitlecache_videoid"
        ON "SubtitleCache" ("videoId");
      `);
    }

    // Add subtitlesDisabled column if missing (non-destructive migration)
    try {
      const scCols: Array<{ name: string }> = await prisma.$queryRaw`
        PRAGMA table_info('SubtitleCache');
      `;
      if (!scCols.some((c) => c.name === 'subtitlesDisabled')) {
        console.log('[DB] Adding subtitlesDisabled column to SubtitleCache');
        await prisma.$executeRawUnsafe(
          `ALTER TABLE "SubtitleCache" ADD COLUMN "subtitlesDisabled" BOOLEAN DEFAULT 0`
        );
      }
      if (!scCols.some((c) => c.name === 'hasBurnedInSubs')) {
        console.log('[DB] Adding hasBurnedInSubs column to SubtitleCache');
        await prisma.$executeRawUnsafe(
          `ALTER TABLE "SubtitleCache" ADD COLUMN "hasBurnedInSubs" BOOLEAN`
        );
      }
      // lastEnCheckAt: when /check last asked YouTube. Used to decide when to
      // re-check a cached "no English CC" result so newly-added YouTube CC
      // gets picked up without re-checking on every play.
      if (!scCols.some((c) => c.name === 'lastEnCheckAt')) {
        console.log('[DB] Adding lastEnCheckAt column to SubtitleCache');
        await prisma.$executeRawUnsafe(
          `ALTER TABLE "SubtitleCache" ADD COLUMN "lastEnCheckAt" DATETIME`
        );
      }
    } catch (err) {
      console.warn('[DB] Failed to add SubtitleCache columns', err);
    }

    // --------------------- AppConfig table ---------------------
    // Server-wide key/value config (Jellyfin URL + API key set via the admin
    // page, plus the cached AniList->TVDB map). Mirrored in schema.prisma like
    // the other runtime-created tables.
    try {
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "AppConfig" (
          "key"   TEXT NOT NULL PRIMARY KEY,
          "value" TEXT NOT NULL
        );
      `);
    } catch (err) {
      console.warn('[DB] Failed to create AppConfig table', err);
    }

    // --------------------- SeriesIdentity table ---------------------
    // Our own AniList -> TVDB/TMDB overrides. Deliberately an override *layer*,
    // not a copy of the community map: that map already answers 94% of TV
    // correctly, so duplicating its 7,179 rows would add a staleness problem and
    // no reach. Rows exist only for corrections, confirmations of title-only
    // matches, and entries the map has never covered.
    try {
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "SeriesIdentity" (
          "anilistId" INTEGER NOT NULL PRIMARY KEY,
          "tvdbId"    TEXT,
          "tmdbId"    TEXT,
          "tmdbKind"  TEXT,
          "source"    TEXT NOT NULL DEFAULT 'manual',
          "confirmed" BOOLEAN NOT NULL DEFAULT false,
          "rejected"  BOOLEAN NOT NULL DEFAULT false,
          "pending"   BOOLEAN NOT NULL DEFAULT false,
          "matchedTitle" TEXT,
          "candidates" TEXT,
          "note"      TEXT,
          "year"      INTEGER,
          "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
    } catch (err) {
      console.warn('[DB] Failed to create SeriesIdentity table', err);
    }
    // `rejected` must be its own column, not inferred from "confirmed with no
    // ids": confirming a good title match also leaves the id boxes empty, so the
    // two states are indistinguishable without it - and guessing wrong means the
    // Reject button silently does nothing while looking like it worked.
    try {
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "SeriesIdentity" ADD COLUMN "rejected" BOOLEAN NOT NULL DEFAULT false`
      );
    } catch {
      /* already present */
    }
    // `pending` marks a row whose ids are a *suggestion* - written by the remote
    // resolver when it wasn't confident enough to act. The ids are recorded so a
    // human can approve them in one click, but they are NOT used for matching:
    // an id here is authoritative in both directions, so a fuzzy search writing
    // one unreviewed could both invent a Watch button and hide a show you own.
    try {
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "SeriesIdentity" ADD COLUMN "pending" BOOLEAN NOT NULL DEFAULT false`
      );
    } catch {
      /* already present */
    }
    // The identity's release year, from the source that named it (TMDB via the
    // sweep, or the admin lookup). Display only - matching never reads it. It
    // exists because unheld gap entries have no other local source of a date,
    // and a match control reading "Title TMDB 128386" with no year made the
    // admin look the show up elsewhere to know what they were confirming.
    try {
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "SeriesIdentity" ADD COLUMN "year" INTEGER`
      );
    } catch {
      /* already present */
    }
    // Which resolver decided the row. Rows stamped below RESOLVER_VERSION are
    // re-resolved by the sweep's regrade pass, which is how a matcher change
    // reaches rows already stored: the main sweep never re-asks an entry that
    // already carries an id, so before this a better ladder fixed only NEW
    // lookups and left every old suggestion exactly as it was.
    try {
      await prisma.$executeRawUnsafe(
        `ALTER TABLE "SeriesIdentity" ADD COLUMN "resolverVersion" INTEGER`
      );
    } catch {
      /* already present */
    }
    // What the resolver saw, so a reviewer can judge without re-searching.
    try {
      await prisma.$executeRawUnsafe(`ALTER TABLE "SeriesIdentity" ADD COLUMN "matchedTitle" TEXT`);
    } catch {
      /* already present */
    }
    // Every candidate the lookup returned, as JSON, so the review page can offer
    // a picker. A search returns one result most of the time and up to twenty for
    // a franchise name - and those are precisely the rows a human needs to
    // disambiguate, so throwing away all but the winner made review harder
    // exactly where it mattered.
    try {
      await prisma.$executeRawUnsafe(`ALTER TABLE "SeriesIdentity" ADD COLUMN "candidates" TEXT`);
    } catch {
      /* already present */
    }

    // --------------------- Drop the Plex subtitle cache ---------------------
    // Held WebVTT extracted from Plex media parts, which existed only because
    // Plex had no endpoint to serve a subtitle track - Jellyfin does, so the
    // extraction and its cache are gone. Purely derived data: dropping it
    // reclaims the space and loses nothing.
    try {
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "PlexSubtitle";`);
    } catch (err) {
      console.warn('[DB] Failed to drop PlexSubtitle table', err);
    }

    // --------------------- Performance indexes ---------------------
    // CREATE INDEX IF NOT EXISTS is idempotent - runs on every startup, only
    // actually builds the index on first boot after deploy. Indexes match the
    // Prisma schema declarations.
    try {
      await prisma.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS "WatchList_userId_idx" ON "WatchList" ("userId");`
      );
      await prisma.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS "WatchList_season_year_idx" ON "WatchList" ("season", "year");`
      );
      await prisma.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS "Settings_hideFromCompare_idx" ON "Settings" ("hideFromCompare");`
      );
    } catch (err) {
      console.warn('[DB] Failed to create performance indexes', err);
    }
  } catch (err) {
    console.error('[DB] Failed to ensure schema', err);
  }
}

// Ensure DB schema first, then start server
ensureDatabaseSchema().then(() => {
  // ----------------------------------------------------------------------------
  // Routes
  // ----------------------------------------------------------------------------

  app.get('/api/health', (_, res) => {
    res.json({ status: 'ok' });
  });

  app.use('/api/anime', animeRouter);
  // Auth limiter: 20 req/min on /api/auth in prod (brute-force protection).
  // Disabled in dev so smoke tests / rapid signups don't trip it.
  const isDev = process.env.NODE_ENV === 'development' || !process.env.NODE_ENV;
  const authLimiter = rateLimit({
    windowMs: 60_000,
    max: 20,
    message: { error: 'Too many requests, please slow down.', code: 'RATE_LIMITED' },
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => isDev,
  });

  app.use('/api/auth', authLimiter, authRouter);
  app.use('/api/list', listRouter);
  app.use('/api/public-list', publicListRouter);
  app.use('/api/users', usersRouter);
  // User-specific UI preferences
  app.use('/api/options', optionsRouter);
  // Note: /api/translate and /api/jellyfin are registered before compression()
  // middleware (see above)

  app.listen(PORT, () => {
    console.log(`Backend listening on http://localhost:${PORT}`);
    // Warm the AniList->TVDB map after the server is up, never during a
    // request: it's a 7.5MB download and availability lookups must not wait
    // on it. Failure is fine - matching falls back to titles alone.
    //
    // This was already the intent, but `resolveAvailability` awaited the same
    // function, so a viewer's request joined this download whenever the stored
    // copy had gone stale. It doesn't any more; the refresh lives entirely
    // here.
    void ensureAnilistTvdbMap();
    // ...and on a timer, so a long-running process doesn't rely on a restart to
    // pick up new entries. The check is conditional (If-None-Match), so an
    // unchanged file costs a 304.
    setInterval(() => void ensureAnilistTvdbMap(true), 24 * 60 * 60 * 1000).unref();
    // Our own overrides - a handful of rows, read on every availability lookup,
    // so they load once here rather than being queried per show.
    void loadIdentityOverrides();
    // Warm the film index NOW, not on the sweep's 90-second delay and never on
    // a viewer's request. On a restart the persisted copy answers anyway; the
    // case this covers is a genuinely fresh deployment (no AppConfig row yet),
    // where any movie lookup inside the sweep delay paid for the whole
    // 6,638-item fetch - the "first person pays" window, narrowed to first-ever
    // boot and now closed.
    void (async () => {
      try {
        const cfg = await getJellyfinConfig();
        if (cfg) await getFilmIndex(await jellyfinApi(cfg));
      } catch {
        /* degraded, not broken: films report as not held until it loads */
      }
    })();

    // Fill in the ids no community map has, by asking Jellyfin's own metadata
    // providers. On a timer for the same reason as the map refresh: an id is a
    // permanent fact, so finding one shouldn't wait for someone to press a
    // button (though /admin/matching now HAS the button, for draining a
    // backlog - triggerSweep in routes/jellyfin.ts is the shared entry).
    // Delayed at boot so it never competes with the first page load, and
    // bounded per run - see `runRemoteIdentitySweep`.
    const sweep = async () => {
      try {
        const cfg = await getJellyfinConfig();
        if (!cfg) return;
        // Re-warm the film index daily (6h TTL, so the sweep's run refreshes
        // it off the request path). The boot-time warm above covers a fresh
        // process; this keeps a long-running one from ever refreshing under a
        // viewer's request.
        await getFilmIndex(await jellyfinApi(cfg)).catch(() => undefined);
        await triggerSweep('scheduled');
      } catch (err: any) {
        console.warn('[identity] sweep could not start:', err?.message ?? err);
      }
    };
    setTimeout(() => void sweep(), 90_000).unref();
    setInterval(() => void sweep(), 24 * 60 * 60 * 1000).unref();
  });

  // ----------------------------------------------------------------------------
  // Batch translation scheduler (medium model, server-side fallback)
  // Runs on Wednesdays 2am-4am, within 50 days of the next season start.
  // The local GPU large-v3 script (Sunday 5am, no window gate) runs first
  // and covers all 3 seasons - this batch only translates what large-v3
  // hasn't cached yet. 50 days gives medium a chance to catch up on anything
  // the local script missed without starting too aggressively early.
  // ----------------------------------------------------------------------------
  const BATCH_SCHEDULER_HOUR_START = 2;  // Start window (2am)
  const BATCH_SCHEDULER_HOUR_END = 4;    // End window (4am) - only starts new batches in this range
  const BATCH_DAYS_BEFORE_SEASON = 50;   // How many days before season start to begin batching
  const BATCH_DAY_OF_WEEK = 3;           // Wednesday (0=Sun, 3=Wed)

  const SEASON_STARTS: Array<{ season: string; month: number; day: number }> = [
    { season: 'WINTER', month: 0, day: 1 },   // Jan 1
    { season: 'SPRING', month: 3, day: 1 },   // Apr 1
    { season: 'SUMMER', month: 6, day: 1 },   // Jul 1
    { season: 'FALL',   month: 9, day: 1 },   // Oct 1
  ];

  function getNextSeasonInfo(): { season: string; year: number; daysUntil: number } | null {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    for (let yearOffset = 0; yearOffset <= 1; yearOffset++) {
      for (const { season, month, day } of SEASON_STARTS) {
        const start = new Date(now.getFullYear() + yearOffset, month, day);
        const daysUntil = Math.ceil((start.getTime() - today.getTime()) / 86_400_000);
        if (daysUntil > 0 && daysUntil <= BATCH_DAYS_BEFORE_SEASON) {
          return { season, year: start.getFullYear(), daysUntil };
        }
      }
    }
    return null;
  }

  let lastBatchDate = '';

  function checkBatchSchedule() {
    const now = new Date();
    const hour = now.getHours();

    // Only start new batches on the right day of week, between 2am-4am
    if (now.getDay() !== BATCH_DAY_OF_WEEK) return;
    if (hour < BATCH_SCHEDULER_HOUR_START || hour >= BATCH_SCHEDULER_HOUR_END) return;

    // Already ran today? Build the key from the same local clock the day/hour
    // gates above use - mixing a UTC date key with local gates could flip the
    // key mid-window in a non-UTC zone and allow a second run the same night.
    const todayStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    if (lastBatchDate === todayStr) return;

    // Batch already running (from the Options modal or a previous scheduler
    // spawn)? startBatch() flips batchStatus.running for BOTH paths, so this
    // now also catches the scheduler's own in-flight run.
    if (batchStatus.running) {
      console.log('[batch-scheduler] Batch already running, skipping');
      return;
    }

    // Is the next season within range?
    const next = getNextSeasonInfo();
    if (!next) return;

    // Start the batch via the shared helper so batchStatus is set (keeps the
    // 409 guard and /batch/status honest). Output is captured into batchStatus.log.
    console.log(`[batch-scheduler] Starting batch for ${next.season} ${next.year} (${next.daysUntil} days until season)`);
    lastBatchDate = todayStr;
    startBatch(['--cutoff', '10'], { season: next.season, year: next.year });
  }

  // Run the check immediately on startup (in case server starts during batch window)
  // then hourly after that.
  setTimeout(checkBatchSchedule, 10_000); // 10s after startup
  setInterval(checkBatchSchedule, 60 * 60 * 1000); // every hour
  console.log('[batch-scheduler] Scheduled hourly check (Wed 2am-4am, within 50 days of the NEXT season; batch covers the displayed season)');

  // Graceful shutdown so Prisma disconnects cleanly and no zombie handles.
  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];
  signals.forEach((sig) =>
    process.on(sig, async () => {
      console.log(`\n[Server] ${sig} received - shutting down`);
      await prisma.$disconnect();
      process.exit(0);
    })
  );
});
