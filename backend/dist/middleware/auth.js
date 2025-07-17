"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireAuth = requireAuth;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const db_1 = __importDefault(require("../db"));
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
/**
 * Middleware to require a valid JWT and ensure the user exists in the database.
 */
async function requireAuth(req, res, next) {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No token' });
    }
    const token = auth.slice(7);
    let payload;
    try {
        payload = jsonwebtoken_1.default.verify(token, JWT_SECRET);
    }
    catch {
        return res.status(401).json({ error: 'Invalid token' });
    }
    // Verify the user still exists
    const user = await db_1.default.user.findUnique({ where: { id: payload.id } });
    if (!user) {
        return res.status(401).json({ error: 'User not found' });
    }
    req.userId = payload.id;
    return next();
}
