"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = __importDefault(require("../db"));
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
// Get list for season/year
router.get('/', auth_1.requireAuth, async (req, res) => {
    const { season, year } = req.query;
    if (!season || !year)
        return res.status(400).json({ error: 'Missing params' });
    const list = await db_1.default.watchList.findMany({
        where: { userId: req.userId, season, year: Number(year) },
        orderBy: { order: 'asc' }
    });
    res.json(list);
});
// Mark a list entry as watched/unwatched
router.patch('/watched', auth_1.requireAuth, async (req, res) => {
    const { season, year, mediaId, watched } = req.body;
    if (!season || !year || typeof mediaId !== 'number') {
        return res.status(400).json({ error: 'Bad body' });
    }
    try {
        const updated = await db_1.default.watchList.updateMany({
            where: { userId: req.userId, season, year, mediaId },
            data: {
                watched: watched ?? true,
                watchedAt: watched ? new Date() : null,
                watchedRank: watched ? null : undefined // null on unwatch
            }
        });
        // updated.count indicates how many rows modified
        return res.json({ updated: updated.count });
    }
    catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Failed to update' });
    }
});
// Reorder watched items (separate ranking); body: { season, year, ids: number[] }
router.patch('/rank', auth_1.requireAuth, async (req, res) => {
    const { season, year, ids } = req.body;
    if (!season || !year || !Array.isArray(ids)) {
        return res.status(400).json({ error: 'Bad body' });
    }
    // Build update promises assigning watchedRank based on position
    const tx = ids.map((mediaId, idx) => db_1.default.watchList.updateMany({
        where: { userId: req.userId, season, year, mediaId, watched: true },
        data: { watchedRank: idx }
    }));
    try {
        await db_1.default.$transaction(tx);
        return res.json({ ok: true });
    }
    catch (e) {
        console.error(e);
        return res.status(500).json({ error: 'Failed to update rank' });
    }
});
// Replace list (send array of mediaIds in desired order)
router.put('/', auth_1.requireAuth, async (req, res) => {
    const { season, year, items } = req.body;
    if (!season || !year || !Array.isArray(items)) {
        return res.status(400).json({ error: 'Bad body' });
    }
    // delete existing then recreate
    // Normalize items into objects with mediaId + optional customName
    const normalized = items.map((it) => {
        if (typeof it === 'number')
            return { mediaId: it, watched: false, watchedAt: null };
        return {
            mediaId: it.mediaId,
            customName: it.customName ?? null,
            watched: it.watched ?? Boolean(it.watchedAt),
            watchedAt: it.watchedAt ?? (it.watched ? new Date() : null)
        };
    });
    await db_1.default.$transaction([
        db_1.default.watchList.deleteMany({ where: { userId: req.userId, season, year } }),
        ...normalized.map((entry, idx) => db_1.default.watchList.create({
            data: {
                userId: req.userId,
                season,
                year,
                mediaId: entry.mediaId,
                customName: entry.customName ?? null,
                watched: entry.watched ?? false,
                watchedAt: entry.watchedAt ?? null,
                order: idx
            }
        }))
    ]);
    res.json({ ok: true });
});
exports.default = router;
// ---------------------------------------------------------------------------
// New endpoints for nickname feature
// ---------------------------------------------------------------------------
// Returns array of user names that have at least one customName in any watch
// list entry.  Used by Randomize page to populate the "nickname picker" UI.
router.get('/users-with-nicknames', async (_req, res) => {
    try {
        // Query watchList for rows with customName, then collect unique userIds
        const rows = await db_1.default.watchList.findMany({
            where: { customName: { not: null } },
            select: { userId: true }
        });
        const userIds = Array.from(new Set(rows.map((r) => r.userId)));
        if (userIds.length === 0)
            return res.json([]);
        const users = await db_1.default.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, username: true }
        });
        const names = users.map((u) => u.username ?? `User-${String(u.id).slice(0, 6)}`).sort();
        return res.json(names);
    }
    catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Failed to fetch users' });
    }
});
// Returns nickname list for a given mediaId: [{ userName, nickname }]
router.get('/nicknames', async (req, res) => {
    const mediaId = Number(req.query.mediaId);
    if (!mediaId)
        return res.status(400).json({ error: 'Missing mediaId' });
    try {
        const rows = await db_1.default.watchList.findMany({
            where: { mediaId, customName: { not: null } },
            select: { customName: true, userId: true }
        });
        if (rows.length === 0)
            return res.json([]);
        const userIds = Array.from(new Set(rows.map((r) => r.userId)));
        const users = await db_1.default.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, username: true }
        });
        // Map userId → display name for quick lookup
        const idToName = new Map();
        users.forEach((u) => {
            const display = u.username ?? `User-${String(u.id).slice(0, 6)}`;
            idToName.set(u.id, display);
        });
        const data = rows.map((r) => ({
            userName: idToName.get(r.userId) ?? 'Unknown',
            nickname: r.customName
        }));
        return res.json(data);
    }
    catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Failed to fetch nicknames' });
    }
});
