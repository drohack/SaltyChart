import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

import animeRouter from './routes/anime';
import authRouter from './routes/auth';

dotenv.config();

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

const app = express();

app.use(cors());
app.use(express.json());

app.get('/api/health', (_, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/anime', animeRouter);
app.use('/api/auth', authRouter);

app.listen(PORT, () => {
  console.log(`Backend listening on http://localhost:${PORT}`);
});
