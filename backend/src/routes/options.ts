import { Router } from 'express';
import { Prisma } from '@prisma/client';
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
    return res.json({ userId, ...DEFAULT_OPTIONS });
  }
  const s = rows[0];
  return res.json({
    ...s,
    nicknameUserSel: s.nicknameUserSel ? JSON.parse(s.nicknameUserSel) : [],
    subtitlePrefs: s.subtitlePrefs ? JSON.parse(s.subtitlePrefs) : undefined,
  });
});

/**
 * PUT /api/options
 * Update or create user-specific display options.
 */
router.put('/', requireAuth, async (req: AuthRequest, res) => {
  const userId = req.userId!;
  let { theme, titleLanguage, videoAutoplay, hideFromCompare, nicknameUserSel, addWatchedTo, subtitlePrefs } = req.body as {
    theme?: string;
    titleLanguage?: string;
    videoAutoplay?: boolean;
    hideFromCompare?: boolean;
    nicknameUserSel?: string[];
    addWatchedTo?: string;
    subtitlePrefs?: object;
  };

  if (!Array.isArray(nicknameUserSel)) nicknameUserSel = [];
  if (!addWatchedTo) addWatchedTo = 'BOTTOM';

  // Basic validation
  if (!theme || !titleLanguage || typeof videoAutoplay !== 'boolean' || typeof hideFromCompare !== 'boolean') {
    return res.status(400).json({ error: 'Invalid options payload', code: 'BAD_REQUEST' });
  }
  try {
    // Upsert *known* columns using Prisma, then update the nickname JSON,
    // addWatchedTo, and subtitlePrefs separately via raw SQL — those columns
    // exist in the DB but are not in the Prisma schema.
    const createData: Prisma.SettingsCreateInput = {
      theme, titleLanguage, videoAutoplay, hideFromCompare,
      user: { connect: { id: userId } }
    };
    const updateData: Prisma.SettingsUpdateInput = { theme, titleLanguage, videoAutoplay, hideFromCompare };

    await prisma.settings.upsert({
      where: { userId },
      create: createData,
      update: updateData
    });

    // Persist nicknameUserSel, addWatchedTo, subtitlePrefs via raw UPDATE
    await prisma.$executeRawUnsafe(
      `UPDATE "Settings" SET "nicknameUserSel" = ?, "addWatchedTo" = ?, "subtitlePrefs" = ? WHERE "userId" = ?`,
      JSON.stringify(nicknameUserSel),
      addWatchedTo,
      subtitlePrefs ? JSON.stringify(subtitlePrefs) : null,
      userId
    );

    // Fetch fresh row to return
    const rows: any[] = await prisma.$queryRaw`
      SELECT * FROM "Settings" WHERE userId = ${userId} LIMIT 1;
    `;
    const s = rows[0];
    return res.json({
      ...s,
      nicknameUserSel,
      subtitlePrefs: s.subtitlePrefs ? JSON.parse(s.subtitlePrefs) : undefined,
    });
  } catch (err) {
    console.error('[options] failed to upsert settings', err);
    return res.status(500).json({ error: 'Failed to save options', code: 'SERVER_ERROR' });
  }
});

export default router;
