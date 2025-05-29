import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const router = Router();

const JWT_SECRET = process.env.JWT_SECRET || 'CHANGE_ME';

router.post('/register', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required' });
  }

  try {
    const existing = await prisma.user.findUnique({ where: { username } });
    if (existing) {
      return res.status(409).json({ error: 'username already exists' });
    }

    const hashed = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({ data: { username, password: hashed } });

    const token = jwt.sign({ sub: user.id, username: user.username }, JWT_SECRET, {
      expiresIn: '7d'
    });

    res.status(201).json({ token });
  } catch (error) {
    console.error('Register error', error);
    res.status(500).json({ error: 'internal server error' });
  }
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required' });
  }

  try {
    const user = await prisma.user.findUnique({ where: { username } });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ sub: user.id, username: user.username }, JWT_SECRET, {
      expiresIn: '7d'
    });

    res.json({ token });
  } catch (error) {
    console.error('Login error', error);
    res.status(500).json({ error: 'internal server error' });
  }
});

export default router;
