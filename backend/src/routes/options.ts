import { Router } from 'express';
import prisma from '../db';
import { requireAuth, AuthRequest } from '../middleware/auth';

const router = Router();

// Default preferences for new or unauthenticated users
const DEFAULT_OPTIONS = {
  theme: 'SYSTEM',
  titleLanguage: 'ENGLISH',
  videoAutoplay: true,
  hideFromCompare: false
};

/**
 * GET /api/options
 * Fetch user-specific display options.
 */
router.get('/', requireAuth, async (req: AuthRequest, res) => {
  const userId = req.userId!;
  let settings = await prisma.settings.findUnique({ where: { userId } });
  if (!settings) {
    // Return defaults if no record exists
    return res.json({ userId, ...DEFAULT_OPTIONS });
  }
  return res.json(settings);
});

/**
 * PUT /api/options
 * Update or create user-specific display options.
 */
router.put('/', requireAuth, async (req: AuthRequest, res) => {
  const userId = req.userId!;
  const { theme, titleLanguage, videoAutoplay, hideFromCompare } = req.body as {
    theme?: string;
    titleLanguage?: string;
    videoAutoplay?: boolean;
    hideFromCompare?: boolean;
  };
  // Basic validation
  if (!theme || !titleLanguage || typeof videoAutoplay !== 'boolean' || typeof hideFromCompare !== 'boolean') {
    return res.status(400).json({ error: 'Invalid options payload' });
  }
  try {
    const settings = await prisma.settings.upsert({
      where: { userId },
      create: { userId, theme, titleLanguage, videoAutoplay, hideFromCompare },
      update: { theme, titleLanguage, videoAutoplay, hideFromCompare }
    });
    return res.json(settings);
  } catch (err) {
    console.error('[options] failed to upsert settings', err);
    return res.status(500).json({ error: 'Failed to save options' });
  }
});

export default router;