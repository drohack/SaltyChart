import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const router = Router();

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const SALT_ROUNDS = 10;

router.post('/signup', async (req, res) => {
  const { username, password } = req.body as {
    username?: string;
    password?: string;
  };

  if (!username || !password) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  try {
    const hashed = await bcrypt.hash(password, SALT_ROUNDS);
    const user = await prisma.user.create({ data: { username, password: hashed } });
    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username });
  } catch (e: any) {
    if (e.code === 'P2002') {
      return res.status(409).json({ error: 'Username already exists' });
    }
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body as {
    username?: string;
    password?: string;
  };
  if (!username || !password) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, username });
});

export default router;
