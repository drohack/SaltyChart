import { Router } from 'express';
import prisma from '../db';
import { requireAuth, AuthRequest } from '../middleware/auth';
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

// Mark a list entry as watched/unwatched
router.patch('/watched', requireAuth, async (req: AuthRequest, res) => {
  const { season, year, mediaId, watched } = req.body as {
    season?: string;
    year?: number;
    mediaId?: number;
    watched?: boolean;
  };

  if (!season || !year || typeof mediaId !== 'number') {
    return res.status(400).json({ error: 'Bad body' });
  }

  try {
    const updated = await prisma.watchList.updateMany({
      where: { userId: req.userId!, season, year, mediaId },
      data: {
        watched: watched ?? true,
        watchedAt: watched ? new Date() : null,
        watchedRank: watched ? null : undefined // null on unwatch
      }
    });

    // updated.count indicates how many rows modified
    return res.json({ updated: updated.count });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to update' });
  }
});

// Reorder watched items (separate ranking); body: { season, year, ids: number[] }
router.patch('/rank', requireAuth, async (req: AuthRequest, res) => {
  const { season, year, ids } = req.body as { season?: string; year?: number; ids?: number[] };
  if (!season || !year || !Array.isArray(ids)) {
    return res.status(400).json({ error: 'Bad body' });
  }

  // Build update promises assigning watchedRank based on position
  const tx = ids.map((mediaId, idx) =>
    prisma.watchList.updateMany({
      where: { userId: req.userId!, season, year, mediaId, watched: true },
      data: { watchedRank: idx }
    })
  );

  try {
    await prisma.$transaction(tx);
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to update rank' });
  }
});

// Replace list (send array of mediaIds in desired order)
router.put('/', requireAuth, async (req: AuthRequest, res) => {
  const { season, year, items } = req.body as {
    season?: string;
    year?: number;
    items?: Array<{ mediaId: number; customName?: string; watched?: boolean; watchedAt?: string | Date | null } | number>;
  };
  if (!season || !year || !Array.isArray(items)) {
    return res.status(400).json({ error: 'Bad body' });
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
    prisma.watchList.deleteMany({ where: { userId: req.userId!, season, year } }),
    ...normalized.map((entry, idx) =>
      prisma.watchList.create({
        data: {
          userId: req.userId!,
          season,
          year,
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
