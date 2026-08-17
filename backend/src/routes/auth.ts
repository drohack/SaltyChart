/**
 * Accounts: signup, login, password reset, and the email that protects it.
 *
 * **The rule this file implements: an account with a VERIFIED email can only be
 * reset through a code sent to that address. An account without one keeps the
 * old no-questions-asked reset.** The branch is on the address, never on the
 * admin flag - see `resetPathFor` in `lib/authCodes.ts` for why (short version:
 * a role-based branch turns this page into a directory of who the admins are,
 * and lets a promotion silently leave someone on the open path).
 *
 * Admins are the exception in one direction only: an admin with no verified
 * address cannot use the open reset either. Without that, deploying this
 * changes nothing until somebody remembers to configure an email.
 */

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import prisma from '../db';
import { requireAuth, AuthRequest } from '../middleware/auth';
import {
  resetPathFor,
  mayResetOpenly,
  generateCode,
  hashCode,
  verifyCodeHash,
  expiryFrom,
  codeState,
  mayIssueCode,
  maskEmail,
  looksLikeEmail,
  CODE_TTL_MS,
} from '../lib/authCodes';
import {
  getMailer,
  mailErrorInfo,
  resetCodeMail,
  verifyEmailMail,
  SmtpNotConfiguredError,
} from '../lib/mailer';
import { verifySetupCode, clearSetupCode } from '../lib/setupCode';

const router = Router();

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const SALT_ROUNDS = 10;
const CODE_TTL_MINUTES = Math.round(CODE_TTL_MS / 60_000);

type CodePurpose = 'reset' | 'verifyEmail';

/** Sign a session token. `v` pins it to the current password generation. */
function signToken(user: { id: number; tokenVersion: number }): string {
  return jwt.sign({ id: user.id, v: user.tokenVersion }, JWT_SECRET, { expiresIn: '7d' });
}

/**
 * Issue a code, store its hash, and mail it.
 *
 * Supersedes any earlier unconsumed code for the same purpose. Without that,
 * requesting three codes would give fifteen guesses against a shared secret
 * space rather than five, which is the arithmetic the attempt cap depends on.
 *
 * Returns false when the hourly issue cap is already reached. The caller must
 * NOT report that difference to an unauthenticated user - see `/reset-request`.
 */
async function issueCode(
  userId: number,
  purpose: CodePurpose,
  to: string,
  now = new Date(),
  /** Recorded on the row for `verifyEmail`, so the code is bound to the address. */
  bindTo?: string
): Promise<boolean> {
  const recent = await prisma.authCode.findMany({
    where: { userId, purpose, createdAt: { gte: new Date(now.getTime() - 60 * 60 * 1000) } },
  });
  if (!mayIssueCode(recent, now)) return false;

  await prisma.authCode.updateMany({
    where: { userId, purpose, consumedAt: null },
    data: { consumedAt: now },
  });

  const code = generateCode();
  await prisma.authCode.create({
    data: {
      userId,
      purpose,
      codeHash: await hashCode(code),
      expiresAt: expiryFrom(now),
      sentTo: bindTo ?? null,
    },
  });

  const mail =
    purpose === 'reset'
      ? resetCodeMail(to, code, CODE_TTL_MINUTES)
      : verifyEmailMail(to, code, CODE_TTL_MINUTES);
  await getMailer().send(mail);
  return true;
}

/**
 * Check a submitted code and consume it on success.
 *
 * A wrong guess increments `attempts` on the stored row - that write is the
 * attempt cap. Skipping it on any path makes the cap decorative and hands an
 * attacker unlimited guesses against a six-digit secret.
 */
async function consumeCode(
  userId: number,
  purpose: CodePurpose,
  submitted: string,
  now = new Date()
): Promise<
  { ok: true; sentTo: string | null } | { ok: false; status: number; error: string; code: string }
> {
  const row = await prisma.authCode.findFirst({
    where: { userId, purpose },
    orderBy: { createdAt: 'desc' },
  });
  if (!row) {
    return { ok: false, status: 400, error: 'No code has been requested.', code: 'INVALID_CODE' };
  }

  const state = codeState(row, now);
  if (state === 'expired') {
    return { ok: false, status: 410, error: 'That code has expired.', code: 'CODE_EXPIRED' };
  }
  if (state === 'exhausted') {
    return {
      ok: false,
      status: 429,
      error: 'Too many incorrect attempts. Request a new code.',
      code: 'TOO_MANY_ATTEMPTS',
    };
  }
  if (state === 'consumed') {
    return {
      ok: false,
      status: 400,
      error: 'That code has already been used.',
      code: 'INVALID_CODE',
    };
  }

  if (!(await verifyCodeHash(submitted, row.codeHash))) {
    await prisma.authCode.update({
      where: { id: row.id },
      data: { attempts: { increment: 1 } },
    });
    return { ok: false, status: 400, error: 'That code is not correct.', code: 'INVALID_CODE' };
  }

  await prisma.authCode.update({ where: { id: row.id }, data: { consumedAt: now } });
  return { ok: true, sentTo: row.sentTo };
}

/** Shared reply for a send that could not go out. Never logs the error object. */
function mailFailure(res: any, err: any, where: string) {
  if (err instanceof SmtpNotConfiguredError) {
    return res.status(503).json({
      error: 'Email is not set up on this server, so codes cannot be sent.',
      code: 'SMTP_NOT_CONFIGURED',
    });
  }
  console.warn(`[auth] ${where} mail failed:`, mailErrorInfo(err));
  return res
    .status(502)
    .json({ error: 'Could not send the email. Try again shortly.', code: 'UPSTREAM_ERROR' });
}

// ---------------------------------------------------------------------------
// Signup / login
// ---------------------------------------------------------------------------

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
    res.json({ token: signToken(user), username });
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

  res.json({ token: signToken(user), username });
});

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------

/**
 * Which reset path does this account get, and start it if a code is needed.
 *
 * Always 200 for a known account. The three outcomes are distinguishable on
 * purpose - the page has to render differently for each, and pretending
 * otherwise would strand a protected user at a form that silently does nothing.
 *
 * A 404 for an unknown username matches what `/reset-password` has always done.
 * Hiding it now would mean lying to someone who typed their own name correctly,
 * for an enumeration property the endpoint next door already gives away.
 */
router.post('/reset-request', async (req, res) => {
  const { username } = req.body as { username?: string };
  if (!username) {
    return res.status(400).json({ error: 'Missing fields', code: 'BAD_REQUEST' });
  }

  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) return res.status(404).json({ error: 'User not found', code: 'USER_NOT_FOUND' });

  const path = resetPathFor(user);
  if (path === 'open') return res.json({ codeRequired: false });

  if (path === 'adminNoAddress') {
    // A deliberate dead end. This account is an admin with nowhere to send a
    // code, and the open reset is closed to admins - so there is no
    // self-service route and the page must say so rather than loop.
    return res.json({
      codeRequired: true,
      noAddress: true,
      message:
        'This is an admin account with no verified email address, so it cannot ' +
        'be reset here. Ask another admin to remove its admin access first.',
    });
  }

  try {
    // The hourly cap is deliberately reported as success. Telling an
    // unauthenticated caller "that account has had three codes this hour" is a
    // free oracle on whether someone is mid-reset, and the honest-looking
    // alternative helps nobody: the real user's earlier code still works.
    await issueCode(user.id, 'reset', user.email!);
  } catch (err) {
    return mailFailure(res, err, 'reset');
  }

  return res.json({ codeRequired: true, hint: maskEmail(user.email!) });
});

/** Finish a coded reset. No token is issued - the page sends you to log in. */
router.post('/reset-verify', async (req, res) => {
  const { username, code, newPassword } = req.body as {
    username?: string;
    code?: string;
    newPassword?: string;
  };
  if (!username || !code || !newPassword) {
    return res.status(400).json({ error: 'Missing fields', code: 'BAD_REQUEST' });
  }

  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) return res.status(404).json({ error: 'User not found', code: 'USER_NOT_FOUND' });

  if (resetPathFor(user) !== 'code') {
    return res.status(400).json({
      error: 'This account does not use emailed codes.',
      code: 'BAD_REQUEST',
    });
  }

  const verdict = await consumeCode(user.id, 'reset', code);
  if (!verdict.ok) {
    return res.status(verdict.status).json({ error: verdict.error, code: verdict.code });
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      password: await bcrypt.hash(newPassword, SALT_ROUNDS),
      tokenVersion: { increment: 1 },
    },
  });
  return res.json({ message: 'Password reset successfully' });
});

/**
 * The original open reset - now only for accounts that have opted out of
 * protection by never setting an email, and never for an admin.
 *
 * This deliberately stays low-security for ordinary accounts: a tiny trusted
 * friend group, list data that does not matter, and signup that must stay
 * frictionless. What changed is that there are now admin pages behind a door
 * this endpoint used to open for anyone on the internet.
 */
router.post('/reset-password', async (req, res) => {
  const { username, newPassword } = req.body as {
    username?: string;
    newPassword?: string;
  };
  if (!username || !newPassword) {
    return res.status(400).json({ error: 'Missing fields', code: 'BAD_REQUEST' });
  }

  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) return res.status(404).json({ error: 'User not found', code: 'USER_NOT_FOUND' });

  // Order matters: the admin refusal comes first so an admin with no address
  // gets the message that fits, rather than being told to check an inbox that
  // does not exist.
  if (!mayResetOpenly(user)) {
    if (user.isAdmin && !user.emailVerifiedAt) {
      return res.status(403).json({
        error:
          'Admin accounts cannot be reset here. Ask another admin to remove ' +
          'this account\'s admin access first.',
        code: 'ADMIN_RESET_BLOCKED',
      });
    }
    return res.status(409).json({
      error: 'This account needs a code emailed to it before the password can be reset.',
      code: 'CODE_REQUIRED',
    });
  }

  try {
    const hashed = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await prisma.user.update({
      where: { username },
      data: { password: hashed, tokenVersion: { increment: 1 } },
    });
    res.json({ message: 'Password reset successfully' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error', code: 'SERVER_ERROR' });
  }
});

// ---------------------------------------------------------------------------
// The signed-in account
// ---------------------------------------------------------------------------

router.get('/account', requireAuth, async (req: AuthRequest, res) => {
  const u = req.user!;
  // One indexed count over a tiny table, and it is what tells the admin shell
  // whether to render the first-run claim form instead of the tabs. A non-admin
  // has to be able to see that state, which is why it rides here rather than on
  // an admin-gated route nobody in that situation could call.
  const admins = await prisma.user.count({ where: { isAdmin: true } });
  // An address entered but not yet confirmed lives on the code row, so the
  // "enter your code" state survives closing the modal - which is exactly what
  // someone does when nothing on screen says a step is outstanding.
  const outstanding = await prisma.authCode.findFirst({
    where: { userId: u.id, purpose: 'verifyEmail', consumedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
  res.json({
    username: u.username,
    email: u.email,
    emailVerified: !!u.emailVerifiedAt,
    isAdmin: u.isAdmin,
    /** Address awaiting a code, masked. Null when there is no change in flight. */
    pendingEmail: outstanding?.sentTo ? maskEmail(outstanding.sentTo) : null,
    /** Drives the admin nag: an admin here has no way back into their account. */
    needsEmail: u.isAdmin && !u.emailVerifiedAt,
    /** No admin exists at all - offer the claim form. */
    setupNeeded: admins === 0,
  });
});

router.post('/change-password', requireAuth, async (req: AuthRequest, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body as {
    currentPassword?: string;
    newPassword?: string;
    confirmPassword?: string;
  };
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Missing fields', code: 'BAD_REQUEST' });
  }
  // Checked server-side as well as in the form. A typo here signs you out of
  // every other device and leaves you with a password you never meant to set -
  // and for an admin with no verified email there is no way to undo it.
  if (confirmPassword !== undefined && confirmPassword !== newPassword) {
    return res
      .status(400)
      .json({ error: 'The two new passwords do not match.', code: 'BAD_REQUEST' });
  }

  const user = req.user!;
  if (!(await bcrypt.compare(currentPassword, user.password))) {
    return res
      .status(401)
      .json({ error: 'Current password is not correct', code: 'INVALID_CREDENTIALS' });
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      password: await bcrypt.hash(newPassword, SALT_ROUNDS),
      tokenVersion: { increment: 1 },
    },
  });
  // The caller's own token is now stale by design. A fresh one keeps them
  // signed in on this device while ending every other session, which is the
  // point of changing a password you think someone else knows.
  const fresh = await prisma.user.findUnique({ where: { id: user.id } });
  res.json({ message: 'Password changed', token: signToken(fresh!) });
});

/**
 * Set (or replace) the recovery address and send a verification code.
 *
 * The current password is required. Without it, anyone who borrows an unlocked
 * laptop can quietly redirect the recovery channel, which is worth more to them
 * than the session they already have.
 *
 * `emailVerifiedAt` is cleared here and only restored by `/email/verify`. An
 * unverified address must never count as protection: a typo would otherwise
 * make the account permanently unresettable, which is worse than the hole this
 * feature closes.
 */
router.post('/email', requireAuth, async (req: AuthRequest, res) => {
  const { email, currentPassword } = req.body as { email?: string; currentPassword?: string };
  if (!email || !currentPassword) {
    return res.status(400).json({ error: 'Missing fields', code: 'BAD_REQUEST' });
  }
  if (!looksLikeEmail(email)) {
    return res.status(400).json({ error: 'That does not look like an email address.', code: 'BAD_REQUEST' });
  }

  const user = req.user!;
  if (!(await bcrypt.compare(currentPassword, user.password))) {
    return res
      .status(401)
      .json({ error: 'Current password is not correct', code: 'INVALID_CREDENTIALS' });
  }

  const clean = email.trim();
  // The account is NOT touched here. The new address rides on the code row and
  // only lands on the user once a code sent to it comes back - so a change that
  // is started and abandoned leaves the current verified address, and its
  // protection, exactly as they were.
  try {
    await issueCode(user.id, 'verifyEmail', clean, new Date(), clean);
  } catch (err) {
    return mailFailure(res, err, 'verify');
  }
  res.json({ sent: true, hint: maskEmail(clean) });
});

router.post('/email/verify', requireAuth, async (req: AuthRequest, res) => {
  const { code } = req.body as { code?: string };
  if (!code) return res.status(400).json({ error: 'Missing fields', code: 'BAD_REQUEST' });

  const user = req.user!;
  const verdict = await consumeCode(user.id, 'verifyEmail', code);
  if (!verdict.ok) {
    return res.status(verdict.status).json({ error: verdict.error, code: verdict.code });
  }
  if (!verdict.sentTo) {
    // A code with no bound address predates this shape. Refusing is right: we
    // cannot say which address it proved control of.
    return res.status(400).json({
      error: 'That code is no longer usable. Request a new one.',
      code: 'INVALID_CODE',
    });
  }

  // The address comes off the CODE ROW, never off the request. That is what
  // makes the code evidence about this specific address.
  await prisma.user.update({
    where: { id: user.id },
    data: { email: verdict.sentTo, emailVerifiedAt: new Date() },
  });
  res.json({ verified: true, email: verdict.sentTo });
});

router.delete('/email', requireAuth, async (req: AuthRequest, res) => {
  const { currentPassword } = req.body as { currentPassword?: string };
  if (!currentPassword) {
    return res.status(400).json({ error: 'Missing fields', code: 'BAD_REQUEST' });
  }

  const user = req.user!;
  // An admin without an address has no self-service recovery at all, so this
  // would be a way to lock yourself out with one click.
  if (user.isAdmin) {
    return res.status(409).json({
      error: 'An admin account must keep a verified email address.',
      code: 'EMAIL_REQUIRED_FOR_ADMIN',
    });
  }
  if (!(await bcrypt.compare(currentPassword, user.password))) {
    return res
      .status(401)
      .json({ error: 'Current password is not correct', code: 'INVALID_CREDENTIALS' });
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { email: null, emailVerifiedAt: null },
  });
  await prisma.authCode.deleteMany({ where: { userId: user.id, purpose: 'verifyEmail' } });
  res.json({ removed: true });
});

// ---------------------------------------------------------------------------
// First run
// ---------------------------------------------------------------------------

/**
 * Claim admin on a database that has none, using the code printed to the
 * server log at startup. See `lib/setupCode.ts` for why this exists at all.
 */
router.post('/claim-admin', requireAuth, async (req: AuthRequest, res) => {
  const { code } = req.body as { code?: string };

  const admins = await prisma.user.count({ where: { isAdmin: true } });
  if (admins > 0) {
    clearSetupCode();
    return res
      .status(409)
      .json({ error: 'This server already has an admin.', code: 'ALREADY_INITIALIZED' });
  }

  if (!code || !verifySetupCode(code)) {
    return res
      .status(403)
      .json({ error: 'That setup code is not correct.', code: 'SETUP_CODE_INVALID' });
  }

  await prisma.user.update({ where: { id: req.userId! }, data: { isAdmin: true } });
  clearSetupCode();
  res.json({ claimed: true });
});

export default router;
