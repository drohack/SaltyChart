"use strict";
// ---------------------------------------------------------------------------
// Ensure the DATABASE_URL environment variable is valid *before* the Prisma
// client is loaded. Prisma caches the connection string during its initial
// `require`, so correcting an invalid value afterwards has no effect and leads
// to errors like:
//     "Error parsing connection string: /app/prisma/data.db"
// ---------------------------------------------------------------------------
Object.defineProperty(exports, "__esModule", { value: true });
if (!process.env.DATABASE_URL ||
    !process.env.DATABASE_URL.startsWith('file:')) {
    process.env.DATABASE_URL = 'file:/app/prisma/data.db';
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({
    datasources: {
        db: {
            url: process.env.DATABASE_URL ?? 'file:/app/prisma/data.db'
        }
    }
});
console.info('[DB] Using SQLite file', (process.env.DATABASE_URL ?? 'file:/app/prisma/data.db'));
exports.default = prisma;
