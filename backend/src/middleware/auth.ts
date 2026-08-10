import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../db';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

export interface AuthRequest extends Request {
  userId?: number;
}

/**
 * Middleware to require a valid JWT and ensure the user exists in the database.
 */
export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token', code: 'UNAUTHORIZED' });
  }

  const token = auth.slice(7);
  let payload: { id: number };
  try {
    payload = jwt.verify(token, JWT_SECRET) as { id: number };
  } catch {
    return res.status(401).json({ error: 'Invalid token', code: 'INVALID_TOKEN' });
  }

  // A correctly signed token still need not carry an id, and Prisma rejects on
  // `{ id: undefined }` rather than returning null - inside an async middleware
  // with no catch that means Express never answers and the request hangs
  // forever instead of returning 401.
  if (typeof payload?.id !== 'number') {
    return res.status(401).json({ error: 'Invalid token', code: 'INVALID_TOKEN' });
  }

  // Verify the user still exists
  const user = await prisma.user.findUnique({ where: { id: payload.id } });
  if (!user) {
    return res.status(401).json({ error: 'User not found', code: 'USER_NOT_FOUND' });
  }
  req.userId = payload.id;
  return next();
}

/**
 * Which account is the admin. Single-admin app; the id is the whole policy.
 *
 * Lives here rather than in a route file because more than one router gates on
 * it, and a security constant with several copies is a security constant that
 * can disagree with itself. (`routes/translate.ts` still parses its own copy
 * inline in two places - worth folding in, but changing a working auth gate is
 * not something to do as a side effect of unrelated work.)
 */
export const ADMIN_USER_ID = parseInt(process.env.ADMIN_USER_ID || '1', 10);

/**
 * Require the admin account. Always used *after* `requireAuth`, which is what
 * populates `req.userId` - on its own this would let an anonymous request
 * through whenever ADMIN_USER_ID happened to be undefined.
 */
export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  if (req.userId !== ADMIN_USER_ID) {
    return res.status(403).json({ error: 'Admin access required', code: 'ADMIN_REQUIRED' });
  }
  return next();
}
