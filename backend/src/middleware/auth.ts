import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import type { User } from '@prisma/client';
import prisma from '../db';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

export interface AuthRequest extends Request {
  userId?: number;
  /**
   * The authenticated user's row, loaded by `requireAuth`.
   *
   * `requireAuth` already fetches it to confirm the account still exists, so
   * hanging it here makes `requireAdmin` free - before this, adding a DB-backed
   * admin check would have meant a second query on every admin request.
   */
  user?: User;
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
  let payload: { id: number; v?: number };
  try {
    payload = jwt.verify(token, JWT_SECRET) as { id: number; v?: number };
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

  // Password changes bump `tokenVersion`, which is what makes a reset actually
  // end an attacker's session - tokens live 7 days in localStorage and there is
  // no revocation list, so without this a stolen session outlives the password
  // that was changed to stop it.
  //
  // **A missing `v` claim reads as 0**, the column default. Five scripts in
  // `tools/` mint admin tokens by signing `{ id }` directly (test_jellyfin.py,
  // test_sonarr.py, test_ui_interactions.py, sonarr_dryrun.py,
  // sonarr_tag_backlog.py); requiring the claim would break all of them for no
  // security gain, since a forged token needs the secret either way.
  if ((payload.v ?? 0) !== user.tokenVersion) {
    return res.status(401).json({ error: 'Session expired', code: 'INVALID_TOKEN' });
  }

  req.userId = payload.id;
  req.user = user;
  return next();
}

/**
 * The account that becomes admin on a database that has none yet.
 *
 * **This is a bootstrap value, not the policy.** Admin-ness lives on
 * `User.isAdmin`; `ensureDatabaseSchema()` sets it on this id once, when no
 * admin exists at all. It also stays the id the five scripts in `tools/` sign
 * tokens for, so demoting that account would break them.
 */
export const ADMIN_USER_ID = parseInt(process.env.ADMIN_USER_ID || '1', 10);

/**
 * Require an admin account. Always used *after* `requireAuth`, which is what
 * loads `req.user` - on its own this would let an anonymous request through.
 *
 * Reads the column rather than comparing against `ADMIN_USER_ID`, so promoting
 * and demoting from `/admin/users` actually takes effect. Any inline copy of
 * this check that still compares ids is wrong in both directions: a promoted
 * admin gets 403, and a demoted one still passes.
 */
export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  if (!req.user?.isAdmin) {
    return res.status(403).json({ error: 'Admin access required', code: 'ADMIN_REQUIRED' });
  }
  return next();
}
