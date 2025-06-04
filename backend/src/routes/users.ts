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
    const users = await prisma.user.findMany({
      // Filter usernames starting with the query prefix
      // SQLite's LIKE is case-insensitive by default
      where: q ? { username: { startsWith: q } } : undefined,
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
