import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import prisma from '../db';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { isValidSeason, isValidYear } from '../lib/validateSeason';
const router = Router();

// Rate-limit the handful of unauthenticated endpoints below (e.g. /nicknames,
// /users-with-ratings) so scrapers can't hammer them. Authenticated endpoints
// above are already covered by the server-wide generalLimiter in index.ts.
const publicListLimiter = rateLimit({
  windowMs: 60_000, // 1 minute
  max: 60,
  message: { error: 'Too many requests, please slow down.', code: 'RATE_LIMITED' },
  standardHeaders: true,
  legacyHeaders: false
});

// Get list for season/year
router.get('/', requireAuth, async (req: AuthRequest, res) => {
  const { season, year } = req.query as { season?: string; year?: string };
  if (!season || !year) return res.status(400).json({ error: 'Missing params', code: 'BAD_REQUEST' });
  if (!isValidSeason(season) || !isValidYear(year)) {
    return res.status(400).json({ error: 'Invalid season or year', code: 'BAD_REQUEST' });
  }

  const list = await prisma.watchList.findMany({
    where: { userId: req.userId!, season, year: Number(year) },
    orderBy: { order: 'asc' }
  });
  res.json(list);
});

// Mark a list entry as watched/unwatched
router.patch('/watched', requireAuth, async (req: AuthRequest, res) => {
  const { season, year, mediaId, watched } = req.body as {
    season?: string;
    year?: number | string;
    mediaId?: number;
    watched?: boolean;
  };

  if (!season || year === undefined || year === null || typeof mediaId !== 'number') {
    return res.status(400).json({ error: 'Bad body', code: 'BAD_REQUEST' });
  }
  if (!isValidSeason(season) || !isValidYear(year)) {
    return res.status(400).json({ error: 'Invalid season or year', code: 'BAD_REQUEST' });
  }

  try {
    const updated = await prisma.watchList.updateMany({
      where: { userId: req.userId!, season, year: Number(year), mediaId },
      data: {
        watched: watched ?? true,
        watchedAt: watched ? new Date() : null
      }
    });

    // If existing row was updated to watched=true we must assign a watchedRank
    if (updated.count > 0 && watched) {
      // Fetch current count of watched items *after* the flag flip so the new
      // item is included in the tally.
      const watchedCount = await prisma.watchList.count({
        where: { userId: req.userId!, season, year: Number(year), watched: true }
      });

      // Only update rank if it is currently null/undefined – keeps manual
      // re-ordering intact when the user toggles back and forth.
      await prisma.watchList.updateMany({
        where: { userId: req.userId!, season, year: Number(year), mediaId, watchedRank: null },
        data: { watchedRank: watchedCount - 1 }
      });
    }

    // If no existing row was updated we interpret the request as "add a new
    // entry that is already watched" so users can mark shows directly from
    // the main grid without first adding them to their unwatched list.

    if (updated.count === 0 && (watched === true || watched === false)) {
      // Determine next order & watchedRank positions so the new entry lands
      // at the bottom of the respective lists.

      const [orderCount, watchedCount] = await Promise.all([
        prisma.watchList.count({ where: { userId: req.userId!, season, year: Number(year) } }),
        prisma.watchList.count({
          where: { userId: req.userId!, season, year: Number(year), watched: true }
        })
      ]);

      await prisma.watchList.create({
        data: {
          userId: req.userId!,
          season,
          year: Number(year),
          mediaId,
          order: orderCount, // append to unwatched list (not relevant once watched)
          watched: watched,
          watchedAt: watched ? new Date() : null,
          watchedRank: watched ? watchedCount : null
        }
      });
      return res.json({ created: true });
    }

    // updated.count indicates how many rows modified
    return res.json({ updated: updated.count });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to update', code: 'SERVER_ERROR' });
  }
});

// Toggle hidden flag on a list entry (excludes from wheel)
router.patch('/hidden', requireAuth, async (req: AuthRequest, res) => {
  const { season, year, mediaId, hidden } = req.body as {
    season?: string;
    year?: number | string;
    mediaId?: number;
    hidden?: boolean;
  };

  if (!season || year === undefined || year === null || typeof mediaId !== 'number') {
    return res.status(400).json({ error: 'Bad body', code: 'BAD_REQUEST' });
  }
  if (!isValidSeason(season) || !isValidYear(year)) {
    return res.status(400).json({ error: 'Invalid season or year', code: 'BAD_REQUEST' });
  }

  try {
    const updated = await prisma.watchList.updateMany({
      where: { userId: req.userId!, season, year: Number(year), mediaId },
      data: { hidden: hidden ?? true }
    });

    return res.json({ updated: updated.count });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to update hidden status', code: 'SERVER_ERROR' });
  }
});

// Reorder watched items (separate ranking); body: { season, year, ids: number[] }
router.patch('/rank', requireAuth, async (req: AuthRequest, res) => {
  const { season, year, ids } = req.body as { season?: string; year?: number | string; ids?: number[] };
  if (!season || year === undefined || year === null || !Array.isArray(ids)) {
    return res.status(400).json({ error: 'Bad body', code: 'BAD_REQUEST' });
  }
  if (!isValidSeason(season) || !isValidYear(year)) {
    return res.status(400).json({ error: 'Invalid season or year', code: 'BAD_REQUEST' });
  }

  // Build update promises assigning watchedRank based on position
  const numericYear = Number(year);

  const tx = ids.map((mediaId, idx) =>
    prisma.watchList.updateMany({
      where: { userId: req.userId!, season, year: numericYear, mediaId, watched: true },
      data: { watchedRank: idx }
    })
  );

  try {
    await prisma.$transaction(tx);
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to update rank', code: 'SERVER_ERROR' });
  }
});

// Replace list (send array of mediaIds in desired order)
router.put('/', requireAuth, async (req: AuthRequest, res) => {
  const { season, year, items } = req.body as {
    season?: string;
    year?: number | string;
    items?: Array<{ mediaId: number; customName?: string; watched?: boolean; watchedAt?: string | Date | null } | number>;
  };
  if (!season || year === undefined || year === null || !Array.isArray(items)) {
    return res.status(400).json({ error: 'Bad body', code: 'BAD_REQUEST' });
  }
  if (!isValidSeason(season) || !isValidYear(year)) {
    return res.status(400).json({ error: 'Invalid season or year', code: 'BAD_REQUEST' });
  }

  // delete existing then recreate
  // Normalize items into objects with mediaId + optional customName
  const normalized = items.map((it) => {
    if (typeof it === 'number') return { mediaId: it, watched: false, watchedAt: null };
    return {
      mediaId: it.mediaId,
      customName: it.customName ?? null,
      watched: it.watched ?? Boolean(it.watchedAt),
      watchedAt: it.watchedAt ?? (it.watched ? new Date() : null)
    };
  });

  await prisma.$transaction([
    prisma.watchList.deleteMany({ where: { userId: req.userId!, season, year: Number(year) } }),
    ...normalized.map((entry, idx) =>
      prisma.watchList.create({
        data: {
          userId: req.userId!,
          season,
          year: Number(year),
          mediaId: entry.mediaId,
          customName: entry.customName ?? null,
          watched: entry.watched ?? false,
          watchedAt: entry.watchedAt ?? null,
          order: idx
        }
      })
    )
  ]);

  res.json({ ok: true });
});

export default router;

// ---------------------------------------------------------------------------
// New endpoints for nickname feature
// ---------------------------------------------------------------------------

// Returns array of user names that have at least one customName in any watch
// list entry.  Used by Randomize page to populate the "nickname picker" UI.
router.get('/users-with-nicknames', publicListLimiter, async (_req, res) => {
  try {
    // Query watchList for rows with customName, then collect unique userIds
    const rows = await prisma.watchList.findMany({
      where: { customName: { not: null } },
      select: { userId: true }
    });

    const userIds = Array.from(new Set(rows.map((r) => r.userId)));

    if (userIds.length === 0) return res.json([]);

    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, username: true }
    });

    const names = users.map((u) => u.username ?? `User-${String(u.id).slice(0, 6)}`).sort();

    return res.json(names);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch users', code: 'SERVER_ERROR' });
  }
});

// Returns array of usernames that have at least one entry in their list for
// the given season/year (watched or not). Used by the Home-page "catch up on
// user's ratings" filter and by the Randomize "Nicknames from" auto-check.
router.get('/users-with-ratings', publicListLimiter, async (req, res) => {
  const { season, year } = req.query as { season?: string; year?: string };
  if (!season || !year) return res.status(400).json({ error: 'Missing season/year', code: 'BAD_REQUEST' });
  if (!isValidSeason(season) || !isValidYear(year)) {
    return res.status(400).json({ error: 'Invalid season or year', code: 'BAD_REQUEST' });
  }
  try {
    // Any entry in "My List" for this season counts (regardless of watched flag)
    const rows = await prisma.watchList.findMany({
      where: { season, year: Number(year) },
      select: { userId: true },
    });
    const userIds = Array.from(new Set(rows.map((r) => r.userId)));
    if (userIds.length === 0) return res.json([]);

    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, username: true },
    });
    const names = users.map((u) => u.username ?? `User-${String(u.id).slice(0, 6)}`).sort();
    return res.json(names);
  } catch (err) {
    console.error('[list] users-with-ratings failed:', err);
    return res.status(500).json({ error: 'Failed to fetch users with ratings', code: 'SERVER_ERROR' });
  }
});

// Returns array of mediaIds that the given user has in their list for
// the given season/year (watched or not).
router.get('/user-ratings', publicListLimiter, async (req, res) => {
  const { username, season, year } = req.query as { username?: string; season?: string; year?: string };
  if (!username || !season || !year) {
    return res.status(400).json({ error: 'Missing username/season/year', code: 'BAD_REQUEST' });
  }
  if (!isValidSeason(season) || !isValidYear(year)) {
    return res.status(400).json({ error: 'Invalid season or year', code: 'BAD_REQUEST' });
  }
  try {
    const user = await prisma.user.findUnique({
      where: { username },
      select: { id: true },
    });
    if (!user) return res.json([]);

    const rows = await prisma.watchList.findMany({
      where: { userId: user.id, season, year: Number(year) },
      select: { mediaId: true },
    });
    return res.json(rows.map((r) => r.mediaId));
  } catch (err) {
    console.error('[list] user-ratings failed:', err);
    return res.status(500).json({ error: 'Failed to fetch user ratings', code: 'SERVER_ERROR' });
  }
});

// Returns nickname list for a given mediaId: [{ userName, nickname, rank }]
router.get('/nicknames', publicListLimiter, async (req, res) => {
  const mediaId = Number(req.query.mediaId);
  if (!Number.isInteger(mediaId) || mediaId <= 0) {
    return res.status(400).json({ error: 'Invalid mediaId', code: 'BAD_REQUEST' });
  }

  try {
    const rows = await prisma.watchList.findMany({
      where: { mediaId },
      select: { customName: true, userId: true, watchedRank: true, order: true }
    });

    if (rows.length === 0) return res.json([]);

    const userIds = Array.from(new Set(rows.map((r) => r.userId)));

    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, username: true }
    });

    // Map userId → display name for quick lookup
    const idToName = new Map<number, string>();
    users.forEach((u) => {
      const display = u.username ?? `User-${String(u.id).slice(0, 6)}`;
      idToName.set(u.id, display);
    });

    const data = rows.map((r) => ({
      userName: idToName.get(r.userId) ?? 'Unknown',
      nickname: r.customName,
      rank:
        typeof r.watchedRank === 'number'
          ? r.watchedRank + 1 // watched rank saved 0-based
          : typeof r.order === 'number'
          ? r.order + 1 // pre-watch list order (also 0-based)
          : null
    }));
    return res.json(data);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch nicknames', code: 'SERVER_ERROR' });
  }
});
