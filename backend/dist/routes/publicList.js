"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = __importDefault(require("../db"));
/**
 * Public endpoint used by the Compare page to fetch _any_ user's ranked list
 * for a given season/year – no authentication required.
 *
 *   GET /api/public-list?username=foo&season=SPRING&year=2024
 */
const router = (0, express_1.Router)();
router.get('/', async (req, res) => {
    const { username, season, year, type } = req.query;
    if (!username || !season || !year) {
        return res.status(400).json({ error: 'Missing query params' });
    }
    try {
        const user = await db_1.default.user.findUnique({ where: { username } });
        if (!user)
            return res.status(404).json({ error: 'User not found' });
        const rankType = (type ?? 'pre').toLowerCase();
        const whereBase = {
            userId: user.id,
            season: season.toUpperCase(),
            year: Number(year)
        };
        let list;
        if (rankType === 'post') {
            // Only watched items; order by watchedRank if set else watchedAt
            list = await db_1.default.watchList.findMany({
                where: { ...whereBase, watched: true },
                orderBy: [
                    { watchedRank: 'asc' },
                    { watchedAt: 'asc' }
                ]
            });
        }
        else {
            // Pre-watch list (original order)
            list = await db_1.default.watchList.findMany({
                where: whereBase,
                orderBy: { order: 'asc' }
            });
        }
        return res.json(list);
    }
    catch (err) {
        console.error('[public-list] failed', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
});
exports.default = router;
