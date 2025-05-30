import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth, AuthRequest } from '../middleware/auth';

const prisma = new PrismaClient();
const router = Router();

// Get list for season/year
router.get('/', requireAuth, async (req: AuthRequest, res) => {
  const { season, year } = req.query as { season?: string; year?: string };
  if (!season || !year) return res.status(400).json({ error: 'Missing params' });

  const list = await prisma.watchList.findMany({
    where: { userId: req.userId!, season, year: Number(year) },
    orderBy: { order: 'asc' }
  });
  res.json(list);
});

// Replace list (send array of mediaIds in desired order)
router.put('/', requireAuth, async (req: AuthRequest, res) => {
  const { season, year, items } = req.body as {
    season?: string;
    year?: number;
    items?: number[];
  };
  if (!season || !year || !Array.isArray(items)) {
    return res.status(400).json({ error: 'Bad body' });
  }

  // delete existing then recreate
  await prisma.$transaction([
    prisma.watchList.deleteMany({ where: { userId: req.userId!, season, year } }),
    ...items.map((mediaId, idx) =>
      prisma.watchList.create({
        data: { userId: req.userId!, season, year, mediaId, order: idx }
      })
    )
  ]);

  res.json({ ok: true });
});

export default router;
