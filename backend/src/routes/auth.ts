import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import prisma from '../db';
const router = Router();

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const SALT_ROUNDS = 10;

router.post('/signup', async (req, res) => {
  const { username, password } = req.body as {
    username?: string;
    password?: string;
  };

  if (!username || !password) {
    return res.status(400).json({ error: 'Missing fields', code: 'BAD_REQUEST' });
  }

  try {
    const hashed = await bcrypt.hash(password, SALT_ROUNDS);
    const user = await prisma.user.create({ data: { username, password: hashed } });

    // Initialize default Settings row for the new user so downstream
    // requests (e.g. GET /api/options) always have a record to read / update.
    // nicknameUserSel defaults to NULL at the DB level and is set via the
    // raw-SQL path in /api/options once the user saves preferences.
    try {
      await prisma.settings.create({
        data: {
          user: { connect: { id: user.id } },
          theme: 'SYSTEM',
          titleLanguage: 'ENGLISH',
          videoAutoplay: true,
          hideFromCompare: false
        }
      });
    } catch (err: any) {
      // Ignore duplicate row errors in the unlikely event of a race.
      if (err.code !== 'P2002') {
        console.warn('[auth] Failed to create default Settings row', err);
      }
    }
    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username });
  } catch (e: any) {
    if (e.code === 'P2002') {
      return res.status(409).json({ error: 'Username already exists', code: 'USER_EXISTS' });
    }
    console.error(e);
    res.status(500).json({ error: 'Server error', code: 'SERVER_ERROR' });
  }
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body as {
    username?: string;
    password?: string;
  };
  if (!username || !password) {
    return res.status(400).json({ error: 'Missing fields', code: 'BAD_REQUEST' });
  }

  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) return res.status(401).json({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' });

  const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, username });
});

export default router;
