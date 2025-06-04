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
    return res.status(401).json({ error: 'No token' });
  }

  const token = auth.slice(7);
  let payload: { id: number };
  try {
    payload = jwt.verify(token, JWT_SECRET) as { id: number };
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }

  // Verify the user still exists
  const user = await prisma.user.findUnique({ where: { id: payload.id } });
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }
  req.userId = payload.id;
  return next();
}
