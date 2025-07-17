"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = __importDefault(require("../db"));
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
// Default preferences for new or unauthenticated users
const DEFAULT_OPTIONS = {
    theme: 'SYSTEM',
    titleLanguage: 'ENGLISH',
    videoAutoplay: true,
    hideFromCompare: false,
    nicknameUserSel: []
};
/**
 * GET /api/options
 * Fetch user-specific display options.
 */
router.get('/', auth_1.requireAuth, async (req, res) => {
    const userId = req.userId;
    // Use raw SELECT so we always retrieve every column even if Prisma client
    // types are out-of-sync with the actual DB schema (e.g. missing future
    // columns).
    const rows = await db_1.default.$queryRaw `
    SELECT * FROM "Settings" WHERE userId = ${userId} LIMIT 1;
  `;
    if (!rows || rows.length === 0) {
        // Return defaults if no record exists
        return res.json({ userId, ...DEFAULT_OPTIONS });
    }
    const s = rows[0];
    const opts = {
        ...s,
        nicknameUserSel: s.nicknameUserSel ? JSON.parse(s.nicknameUserSel) : []
    };
    return res.json(opts);
});
/**
 * PUT /api/options
 * Update or create user-specific display options.
 */
router.put('/', auth_1.requireAuth, async (req, res) => {
    const userId = req.userId;
    let { theme, titleLanguage, videoAutoplay, hideFromCompare, nicknameUserSel } = req.body;
    if (!Array.isArray(nicknameUserSel))
        nicknameUserSel = [];
    // Basic validation
    if (!theme || !titleLanguage || typeof videoAutoplay !== 'boolean' || typeof hideFromCompare !== 'boolean') {
        return res.status(400).json({ error: 'Invalid options payload' });
    }
    try {
        // Upsert *known* columns using Prisma, then update the nickname JSON
        // separately via raw SQL to avoid client validation mismatches.
        const createData = { userId, theme, titleLanguage, videoAutoplay, hideFromCompare };
        const updateData = { theme, titleLanguage, videoAutoplay, hideFromCompare };
        await db_1.default.settings.upsert({
            where: { userId },
            create: createData,
            update: updateData
        });
        // Persist nicknameUserSel via raw UPDATE (stringified JSON)
        await db_1.default.$executeRawUnsafe(`UPDATE "Settings" SET "nicknameUserSel" = ? WHERE "userId" = ?`, JSON.stringify(nicknameUserSel), userId);
        // Fetch fresh row to return
        const rows = await db_1.default.$queryRaw `
      SELECT * FROM "Settings" WHERE userId = ${userId} LIMIT 1;
    `;
        const s = rows[0];
        return res.json({ ...s, nicknameUserSel });
    }
    catch (err) {
        console.error('[options] failed to upsert settings', err);
        return res.status(500).json({ error: 'Failed to save options' });
    }
});
exports.default = router;
