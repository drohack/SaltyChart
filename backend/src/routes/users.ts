import { Router } from 'express';
import prisma from '../db';

/**
 * Lightweight public endpoint that returns a list of usernames. Optional
 * `q` query parameter filters usernames that *start with* the provided prefix
 * (case-insensitive).  The result set is capped to 20 items so it can be used
 * directly as an auto-complete list in the frontend.
 */

const router = Router();

router.get('/', async (req, res) => {
  const q = (req.query.q as string | undefined)?.trim() ?? '';

  try {
    // Exclude users who opted to hide from compare (keep defaults if no settings)
    const baseFilter = {
      OR: [
        { settings: { hideFromCompare: false } },
        { settings: null }
      ]
    };
    const users = await prisma.user.findMany({
      where: q
        ? {
            AND: [
              { username: { startsWith: q } },
              baseFilter
            ]
          }
        : baseFilter,
      select: { username: true },
      take: 20,
      orderBy: { username: 'asc' }
    });

    res.json(users.map((u) => u.username));
  } catch (err) {
    console.error('[users] failed', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
