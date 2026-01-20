import { Router } from 'express';
import prisma from '../db';
import { requireAuth, AuthRequest } from '../middleware/auth';

const router = Router();

// Default preferences for new or unauthenticated users
const DEFAULT_OPTIONS = {
  theme: 'SYSTEM',
  titleLanguage: 'ENGLISH',
  videoAutoplay: true,
  hideFromCompare: false,
  nicknameUserSel: [],
  addWatchedTo: 'BOTTOM'
}; 

/**
 * GET /api/options
 * Fetch user-specific display options.
 */
router.get('/', requireAuth, async (req: AuthRequest, res) => {
  const userId = req.userId!;
  // Use raw SELECT so we always retrieve every column even if Prisma client
  // types are out-of-sync with the actual DB schema (e.g. missing future
  // columns).
  const rows: any[] = await prisma.$queryRaw`
    SELECT * FROM "Settings" WHERE userId = ${userId} LIMIT 1;
  `;
  if (!rows || rows.length === 0) {
    // Return defaults if no record exists
    console.log('[OPTIONS] GET no settings found, returning defaults');
    return res.json({ userId, ...DEFAULT_OPTIONS });
  }
  const s = rows[0];
  console.log('[OPTIONS] GET raw from DB:', s);
  const opts = {
    ...s,
    nicknameUserSel: s.nicknameUserSel ? JSON.parse(s.nicknameUserSel) : []
  };
  console.log('[OPTIONS] GET returning:', opts);
  return res.json(opts);
});

/**
 * PUT /api/options
 * Update or create user-specific display options.
 */
router.put('/', requireAuth, async (req: AuthRequest, res) => {
  const userId = req.userId!;
  let { theme, titleLanguage, videoAutoplay, hideFromCompare, nicknameUserSel, addWatchedTo } = req.body as {
    theme?: string;
    titleLanguage?: string;
    videoAutoplay?: boolean;
    hideFromCompare?: boolean;
    nicknameUserSel?: string[];
    addWatchedTo?: string;
  };

  if (!Array.isArray(nicknameUserSel)) nicknameUserSel = [];
  if (!addWatchedTo) addWatchedTo = 'BOTTOM';

  console.log('[OPTIONS] PUT received:', { theme, titleLanguage, videoAutoplay, hideFromCompare, addWatchedTo });

  // Basic validation
  if (!theme || !titleLanguage || typeof videoAutoplay !== 'boolean' || typeof hideFromCompare !== 'boolean') {
    return res.status(400).json({ error: 'Invalid options payload' });
  }
  try {
    // Upsert *known* columns using Prisma, then update the nickname JSON
    // and addWatchedTo separately via raw SQL to avoid client validation mismatches.
    const createData: any = { userId, theme, titleLanguage, videoAutoplay, hideFromCompare };
    const updateData: any = { theme, titleLanguage, videoAutoplay, hideFromCompare };

    await prisma.settings.upsert({
      where: { userId },
      create: createData,
      update: updateData
    } as any);

    // Persist nicknameUserSel and addWatchedTo via raw UPDATE
    await prisma.$executeRawUnsafe(
      `UPDATE "Settings" SET "nicknameUserSel" = ?, "addWatchedTo" = ? WHERE "userId" = ?`,
      JSON.stringify(nicknameUserSel),
      addWatchedTo,
      userId
    );

    console.log('[OPTIONS] Saved addWatchedTo:', addWatchedTo);

    // Fetch fresh row to return
    const rows: any[] = await prisma.$queryRaw`
      SELECT * FROM "Settings" WHERE userId = ${userId} LIMIT 1;
    `;
    const s = rows[0];
    console.log('[OPTIONS] Returning:', { ...s, nicknameUserSel });
    return res.json({ ...s, nicknameUserSel });
  } catch (err) {
    console.error('[options] failed to upsert settings', err);
    return res.status(500).json({ error: 'Failed to save options' });
  }
});

export default router;
