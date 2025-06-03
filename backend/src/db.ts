// ---------------------------------------------------------------------------
// Ensure the DATABASE_URL environment variable is valid *before* the Prisma
// client is loaded. Prisma caches the connection string during its initial
// `require`, so correcting an invalid value afterwards has no effect and leads
// to errors like:
//     "Error parsing connection string: /app/prisma/data.db"
// ---------------------------------------------------------------------------

if (!process.env.DATABASE_URL ||
    !process.env.DATABASE_URL.startsWith('file:')) {
  process.env.DATABASE_URL = 'file:/app/prisma/data.db';
}

// Import Prisma only after the URL has been normalised so the client picks up
// the fixed value.
// Load Prisma *after* the DATABASE_URL fix using regular `require`. This avoids
// the `import.meta` restriction when compiling to CommonJS.

import type { PrismaClient as PrismaClientType } from '@prisma/client';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PrismaClient } = require('@prisma/client') as { PrismaClient: typeof PrismaClientType };

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_URL ?? 'file:/app/prisma/data.db'
    }
  }
});

console.info('[DB] Using SQLite file', (process.env.DATABASE_URL ?? 'file:/app/prisma/data.db'));

export default prisma;
