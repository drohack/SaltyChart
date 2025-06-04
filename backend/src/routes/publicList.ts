import { Router } from 'express';
import prisma from '../db';

/**
 * Public endpoint used by the Compare page to fetch _any_ user's ranked list
 * for a given season/year – no authentication required.
 *
 *   GET /api/public-list?username=foo&season=SPRING&year=2024
 */

const router = Router();

router.get('/', async (req, res) => {
  const { username, season, year } = req.query as {
    username?: string;
    season?: string;
    year?: string;
  };

  if (!username || !season || !year) {
    return res.status(400).json({ error: 'Missing query params' });
  }

  try {
    const user = await prisma.user.findUnique({ where: { username } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const list = await prisma.watchList.findMany({
      where: {
        userId: user.id,
        season: season.toUpperCase(),
        year: Number(year)
      },
      orderBy: { order: 'asc' }
    });

    return res.json(list);
  } catch (err) {
    console.error('[public-list] failed', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
