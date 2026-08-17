/**
 * The first-run admin claim code.
 *
 * On a database with no admin at all, something has to decide who becomes one.
 * Today that is `ADMIN_USER_ID` defaulting to 1, which means **whoever signs up
 * first** - fine on a LAN, a land-grab on a public domain, and reachable for
 * real if the DB is ever restored empty.
 *
 * So: when no admin exists, the server prints a code at startup and `/admin`
 * asks for it. Being able to read `docker logs saltychart-backend` proves you
 * own the box, which is the right bar for claiming it.
 *
 * **In memory only, regenerated every boot.** Never written to the database, so
 * it cannot leak from a backup, and a restart invalidates any code someone
 * scrolled past. It also doubles as break-glass recovery: if every admin
 * account is somehow lost, restart the backend and claim it back.
 */

import crypto from 'crypto';

let code: string | null = null;

/**
 * Create the code if there isn't one, and return it.
 *
 * 8 hex characters from `crypto.randomBytes` - not a 6-digit code, because this
 * one has no attempt cap behind it and no rate limit worth the name; it is
 * guarded by being unguessable rather than by being short-lived.
 */
export function ensureSetupCode(): string {
  if (!code) code = crypto.randomBytes(4).toString('hex');
  return code;
}

export function getSetupCode(): string | null {
  return code;
}

/** Called once an admin exists, so a stale code cannot be replayed. */
export function clearSetupCode(): void {
  code = null;
}

/**
 * Constant-time comparison against the live code.
 *
 * `timingSafeEqual` throws on a length mismatch, so the lengths are checked
 * first - and returning early on that is fine, since the length is not secret.
 */
export function verifySetupCode(input: string): boolean {
  if (!code || !input) return false;
  const a = Buffer.from(input);
  const b = Buffer.from(code);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
