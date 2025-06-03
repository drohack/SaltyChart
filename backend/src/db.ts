import { PrismaClient } from '@prisma/client';

// ---------------------------------------------------------------------------
// Centralised Prisma instance.  Import this module anywhere you need database
// access so the entire application shares **one** connection pool instead of
// opening a new connection per route file.
// ---------------------------------------------------------------------------

const prisma = new PrismaClient();

export default prisma;
