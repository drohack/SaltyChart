/**
 * One-time codes for password reset and email verification, and the predicate
 * that decides which reset path an account gets.
 *
 * **Pure by construction**: nothing here reads the clock, the database or the
 * environment. Every function takes the row it needs plus an explicit `now`, so
 * the whole decision surface unit-tests without a database and without faking
 * timers - the same shape as `sonarrSelect.ts` and `seriesIdentity.ts`. The
 * route layer owns the Prisma calls and hands the rows in.
 *
 * The types below are structural on purpose. Importing Prisma's generated types
 * would couple this module to a client regeneration, and everything it needs is
 * four fields.
 */

import crypto from 'crypto';
import bcrypt from 'bcryptjs';

/** Ten minutes. Long enough to switch to a phone, short enough to be worthless if seen. */
export const CODE_TTL_MS = 10 * 60 * 1000;

/**
 * Wrong guesses before the code dies.
 *
 * This is the number that makes a 6-digit code defensible at all. Six digits is
 * a million values, so unlimited guessing breaks it in an afternoon; at five
 * attempts per issued code, an attacker needs 200,000 *requests* rather than
 * 200,000 guesses, and `MAX_CODES_PER_HOUR` caps those too.
 */
export const MAX_ATTEMPTS = 5;

/** Issued codes per account per hour. Bounds the attempt budget above. */
export const MAX_CODES_PER_HOUR = 3;

/** bcrypt cost. Matches `SALT_ROUNDS` in routes/auth.ts - one hash per verify. */
const SALT_ROUNDS = 10;

/** What a stored code row must expose. Structural, not Prisma's type. */
export interface StoredCode {
  expiresAt: Date;
  attempts: number;
  consumedAt: Date | null;
  createdAt: Date;
}

/** What deciding a reset path needs to know about an account. */
export interface ResetSubject {
  isAdmin: boolean;
  emailVerifiedAt: Date | null;
}

/**
 * Which reset path an account gets.
 *
 * - `open`     - today's no-questions-asked reset. Unchanged behaviour.
 * - `code`     - a code goes to the verified address.
 * - `adminNoAddress` - an admin who has not set an address yet. A deliberate
 *   dead end: they must ask another admin to demote them. Without this branch
 *   the deploy would change nothing until someone remembered to configure an
 *   email, which is exactly the failure this whole feature exists to remove.
 *
 * Note the order. A **verified address wins over the admin flag**, so an admin
 * who has set one takes the ordinary coded path rather than a special case -
 * that is what keeps the reset page from being an admin directory.
 */
export function resetPathFor(user: ResetSubject): 'open' | 'code' | 'adminNoAddress' {
  if (user.emailVerifiedAt) return 'code';
  if (user.isAdmin) return 'adminNoAddress';
  return 'open';
}

/**
 * May this account still be reset through the unauthenticated endpoint?
 *
 * The one question `POST /reset-password` asks. Kept as its own export so the
 * endpoint cannot drift from `resetPathFor` by re-deriving the answer.
 */
export function mayResetOpenly(user: ResetSubject): boolean {
  return resetPathFor(user) === 'open';
}

/**
 * A fresh 6-digit code.
 *
 * `crypto.randomInt`, never `Math.random` - the latter is seeded predictably
 * enough that a code becomes guessable from other codes, which is the whole
 * ballgame here. Padded rather than range-shifted so every value from 000000 to
 * 999999 is equally likely; starting at 100000 would silently drop a tenth of
 * the space.
 */
export function generateCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * Hash a code for storage.
 *
 * **bcrypt, not sha256.** Six digits is a million values, so a fast digest makes
 * a leaked database equivalent to a leaked code - the entire keyspace falls in
 * under a second. bcrypt at cost 10 makes that days of work, and we pay one
 * comparison per verification.
 */
export function hashCode(code: string): Promise<string> {
  return bcrypt.hash(code, SALT_ROUNDS);
}

/** Constant-time-ish compare via bcrypt. */
export function verifyCodeHash(code: string, hash: string): Promise<boolean> {
  return bcrypt.compare(code, hash);
}

/** When a code issued at `now` stops being valid. */
export function expiryFrom(now: Date): Date {
  return new Date(now.getTime() + CODE_TTL_MS);
}

/**
 * Is this stored row still usable, and if not, why not?
 *
 * The caller needs the reason, not a boolean: "that code expired" and "too many
 * wrong guesses" are different things to tell someone, and collapsing them
 * sends people round the loop re-requesting a code that was never the problem.
 *
 * Expiry is measured against the row's own `expiresAt` rather than
 * `createdAt + CODE_TTL_MS`, so changing the TTL can never retroactively
 * lengthen the life of a code already in the database.
 */
export function codeState(
  row: StoredCode,
  now: Date
): 'live' | 'consumed' | 'expired' | 'exhausted' {
  if (row.consumedAt) return 'consumed';
  if (row.attempts >= MAX_ATTEMPTS) return 'exhausted';
  if (now.getTime() >= row.expiresAt.getTime()) return 'expired';
  return 'live';
}

/**
 * May another code be issued, given what this account has been sent recently?
 *
 * Counts only the last hour, and counts *issued* codes rather than live ones -
 * consuming a code must not buy a fresh allowance, or the cap is bypassed by
 * using each code once.
 */
export function mayIssueCode(recent: StoredCode[], now: Date): boolean {
  const cutoff = now.getTime() - 60 * 60 * 1000;
  const issuedThisHour = recent.filter((r) => r.createdAt.getTime() >= cutoff).length;
  return issuedThisHour < MAX_CODES_PER_HOUR;
}

/**
 * A display hint for an address we will not show in full.
 *
 * `grayson@example.com` -> `g*****n@example.com`. Enough for the owner to
 * recognise which inbox to open, not enough to hand a stranger the address.
 * A short local part degrades to all stars rather than leaking its only letters.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at);
  if (local.length <= 2) return '*'.repeat(local.length) + domain;
  return `${local[0]}${'*'.repeat(local.length - 2)}${local[local.length - 1]}${domain}`;
}

/**
 * Is this a plausible email address?
 *
 * Deliberately loose - one `@`, something either side, no whitespace, a dot in
 * the domain. Strict RFC validation rejects addresses that genuinely work, and
 * the real check is that a code sent to it comes back, which no regex can do.
 */
export function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
