import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

export interface AuthRequest extends Request {
  userId?: number;
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token' });
  }

  const token = auth.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { id: number };
    req.userId = payload.id;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}
