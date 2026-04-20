import { Router } from 'express';
import prisma from '../db';
import { isValidSeason, isValidYear } from '../lib/validateSeason';

/**
 * Public endpoint used by the Compare page to fetch _any_ user's ranked list
 * for a given season/year – no authentication required.
 *
 *   GET /api/public-list?username=foo&season=SPRING&year=2024
 */

const router = Router();

router.get('/', async (req, res) => {
  const { username, season, year, type } = req.query as {
    username?: string;
    season?: string;
    year?: string;
    type?: string;
  };

  if (!username || !season || !year) {
    return res.status(400).json({ error: 'Missing query params', code: 'BAD_REQUEST' });
  }
  if (!isValidSeason(season) || !isValidYear(year)) {
    return res.status(400).json({ error: 'Invalid season or year', code: 'BAD_REQUEST' });
  }

  try {
    const user = await prisma.user.findUnique({ where: { username } });
    if (!user) return res.status(404).json({ error: 'User not found', code: 'USER_NOT_FOUND' });

    const rankType = (type ?? 'pre').toLowerCase();

    const whereBase = {
      userId: user.id,
      season: season.toUpperCase(),
      year: Number(year)
    } as const;

    // Only project fields the Compare page actually reads. Avoids leaking
    // internal columns (userId, createdAt, etc.) to unauthenticated callers
    // and shrinks the payload.
    const select = {
      mediaId: true,
      order: true,
      customName: true,
      watchedRank: true,
      watched: true
    } as const;

    let list;
    if (rankType === 'post') {
      // Only watched items; order by watchedRank if set else watchedAt
      list = await prisma.watchList.findMany({
        where: { ...whereBase, watched: true },
        orderBy: [
          { watchedRank: 'asc' },
          { watchedAt: 'asc' }
        ],
        select
      });
    } else {
      // Pre-watch list (original order)
      list = await prisma.watchList.findMany({
        where: whereBase,
        orderBy: { order: 'asc' },
        select
      });
    }

    return res.json(list);
  } catch (err) {
    console.error('[public-list] failed', err);
    return res.status(500).json({ error: 'Internal server error', code: 'SERVER_ERROR' });
  }
});

export default router;
