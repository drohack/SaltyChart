"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const db_1 = __importDefault(require("../db"));
const router = (0, express_1.Router)();
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const SALT_ROUNDS = 10;
router.post('/signup', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Missing fields' });
    }
    try {
        const hashed = await bcryptjs_1.default.hash(password, SALT_ROUNDS);
        const user = await db_1.default.user.create({ data: { username, password: hashed } });
        // Initialize default Settings row for the new user so downstream
        // requests (e.g. GET /api/options) always have a record to read / update.
        try {
            await db_1.default.settings.create({
                data: {
                    userId: user.id,
                    theme: 'SYSTEM',
                    titleLanguage: 'ENGLISH',
                    videoAutoplay: true,
                    hideFromCompare: false,
                    nicknameUserSel: '[]'
                }
            });
        }
        catch (err) {
            // Ignore duplicate row errors in the unlikely event of a race.
            if (err.code !== 'P2002') {
                console.warn('[auth] Failed to create default Settings row', err);
            }
        }
        const token = jsonwebtoken_1.default.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, username });
    }
    catch (e) {
        if (e.code === 'P2002') {
            return res.status(409).json({ error: 'Username already exists' });
        }
        console.error(e);
        res.status(500).json({ error: 'Server error' });
    }
});
router.post('/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Missing fields' });
    }
    const user = await db_1.default.user.findUnique({ where: { username } });
    if (!user)
        return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await bcryptjs_1.default.compare(password, user.password);
    if (!valid)
        return res.status(401).json({ error: 'Invalid credentials' });
    const token = jsonwebtoken_1.default.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username });
});
exports.default = router;
