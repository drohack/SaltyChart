/**
 * Who can sign in, and who can administer - `/api/admin/users`.
 *
 * **Every route here is `requireAuth` + `requireAdmin`**, like `routes/sonarr.ts`.
 *
 * Two invariants live in this file and nowhere else, and both are guarded by a
 * mutation row because both fail silently:
 *
 * 1. **The site never runs out of admins.** Demote and delete refuse when they
 *    would leave zero. Admins are otherwise symmetric peers - there is no root
 *    account - so this floor is the only thing standing between a mis-click and
 *    an admin panel nobody can open. It **counts inside the transaction**; a
 *    cached or pre-read number is a check against a stale world.
 *
 * 2. **Nothing here ever SETS a credential - it only clears one.** An admin who
 *    set a password would have to relay it and would know it afterwards, which
 *    is a takeover primitive. Clearing gives the admin nothing: the owner sets
 *    the next one themselves. That is also why an admin may clear another
 *    admin's password, and why the only refusals are the two that would strand
 *    an account with no route back in - clearing the password of an admin with
 *    no verified email, and clearing an admin's email at all.
 *
 *    The redundancy is deliberate too: an ordinary account with no email can
 *    already reset itself at `/reset-password` with just a username, so these
 *    buttons exist for the one case self-service cannot reach - an address whose
 *    inbox its owner has lost.
 *
 * Promotion additionally requires a **verified** address on the target. That is
 * what makes "every admin is email-protected" true by construction rather than
 * by someone remembering.
 */

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import prisma from '../db';
import { requireAuth, requireAdmin, AuthRequest } from '../middleware/auth';
import { getMailer, mailErrorInfo, testMail, SmtpNotConfiguredError } from '../lib/mailer';

const router = Router();

const SALT_ROUNDS = 10;

function parseId(raw: string): number | null {
  const id = parseInt(raw, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Everyone, with the two facts that are hard to see anywhere else.
 *
 * `createdAt` because signup is open to the internet and a stranger's account
 * is otherwise indistinguishable from a friend's. The list count because an
 * account with data in it is a different deletion decision from an empty one.
 */
router.get('/', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: { id: 'asc' },
      select: {
        id: true,
        username: true,
        email: true,
        emailVerifiedAt: true,
        isAdmin: true,
        createdAt: true,
        _count: { select: { lists: true } },
      },
    });

    res.json({
      mailer: { configured: getMailer().configured(), describe: getMailer().describe() },
      users: users.map((u) => ({
        id: u.id,
        username: u.username,
        email: u.email,
        emailVerified: !!u.emailVerifiedAt,
        isAdmin: u.isAdmin,
        createdAt: u.createdAt,
        listCount: u._count.lists,
        /** An admin who cannot recover their own account. Rendered as a warning. */
        needsEmail: u.isAdmin && !u.emailVerifiedAt,
      })),
    });
  } catch (err) {
    console.error('[adminUsers] list failed', err);
    res.status(500).json({ error: 'Server error', code: 'SERVER_ERROR' });
  }
});

/** Promote or demote. */
router.patch('/:id', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  const id = parseId(req.params.id);
  const { isAdmin } = req.body as { isAdmin?: boolean };
  if (id === null || typeof isAdmin !== 'boolean') {
    return res
      .status(400)
      .json({ error: 'Expected { isAdmin: boolean }', code: 'BAD_REQUEST' });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const target = await tx.user.findUnique({ where: { id } });
      if (!target) return { status: 404, body: { error: 'User not found', code: 'USER_NOT_FOUND' } };
      if (target.isAdmin === isAdmin) return { status: 200, body: { ok: true, unchanged: true } };

      if (isAdmin) {
        // The one rule that makes every admin recoverable. A promotion without
        // it produces an admin who cannot reset their own password and cannot
        // use the open endpoint either.
        if (!target.emailVerifiedAt) {
          return {
            status: 409,
            body: {
              error:
                `${target.username} needs a verified email address before they ` +
                `can be made an admin.`,
              code: 'EMAIL_NOT_VERIFIED',
            },
          };
        }
      } else {
        // Counted here, inside the transaction, against the live table.
        const admins = await tx.user.count({ where: { isAdmin: true } });
        if (admins <= 1) {
          return {
            status: 409,
            body: {
              error: 'This is the only admin account. Promote someone else first.',
              code: 'LAST_ADMIN',
            },
          };
        }
      }

      await tx.user.update({ where: { id }, data: { isAdmin } });
      return { status: 200, body: { ok: true, isAdmin } };
    });

    res.status(result.status).json(result.body);
  } catch (err) {
    console.error('[adminUsers] patch failed', err);
    res.status(500).json({ error: 'Server error', code: 'SERVER_ERROR' });
  }
});

/**
 * Clear a password, rather than setting one.
 *
 * **Why clear and not set.** An admin who *sets* a password has to relay it -
 * read it aloud, paste it into a chat - and knows it afterwards. Clearing needs
 * no relay and gives the admin nothing: the account simply becomes
 * unloggable-into until its owner sets a new one at `/reset-password`, which for
 * an ordinary account needs only their username. It is therefore not a takeover
 * primitive, which is precisely why an admin may use it on another admin.
 *
 * The stored hash is replaced with one of a random secret nobody has ever seen,
 * rather than emptied: every login path does a bcrypt compare, and a null or
 * blank hash is the kind of thing that ends up matching an empty string after
 * some future refactor.
 *
 * **Refused when the target is an admin with no verified email**, because such
 * an account has no reset path at all - admins are blocked from the open one -
 * so clearing its password locks it out permanently.
 */
router.post('/:id/clear-password', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: 'Bad id', code: 'BAD_REQUEST' });

  try {
    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) return res.status(404).json({ error: 'User not found', code: 'USER_NOT_FOUND' });

    if (target.isAdmin && !target.emailVerifiedAt) {
      return res.status(409).json({
        error:
          `${target.username} is an admin with no verified email, so there would ` +
          `be no way back into the account. Remove their admin access first, or ` +
          `have them add an email.`,
        code: 'ADMIN_RESET_BLOCKED',
      });
    }

    const unusable = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), SALT_ROUNDS);
    await prisma.user.update({
      where: { id },
      // The bump signs them out everywhere. Clearing a password is usually done
      // because someone else may have had it.
      data: { password: unusable, tokenVersion: { increment: 1 } },
    });
    res.json({ ok: true, username: target.username, needsCode: !!target.emailVerifiedAt });
  } catch (err) {
    console.error('[adminUsers] clear password failed', err);
    res.status(500).json({ error: 'Server error', code: 'SERVER_ERROR' });
  }
});

/**
 * Clear a recovery address, handing the account back to the username-only reset.
 *
 * This is the *only* fix for the one lockout an admin cannot otherwise solve:
 * someone set an email and then lost access to that inbox, so they are pinned to
 * a coded path they can never complete. Removing the address removes the
 * protection, which is the whole point.
 *
 * **Refused on an admin**, for the same reason `DELETE /api/auth/email` is: an
 * admin is blocked from the open reset, so an admin with no address has no way
 * in at all. Demote first.
 */
router.post('/:id/clear-email', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: 'Bad id', code: 'BAD_REQUEST' });

  try {
    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) return res.status(404).json({ error: 'User not found', code: 'USER_NOT_FOUND' });

    if (target.isAdmin) {
      return res.status(409).json({
        error:
          `${target.username} is an admin, and an admin with no email address ` +
          `cannot recover their account at all. Remove their admin access first.`,
        code: 'EMAIL_REQUIRED_FOR_ADMIN',
      });
    }
    if (!target.email) {
      return res.json({ ok: true, unchanged: true, username: target.username });
    }

    await prisma.user.update({
      where: { id },
      data: { email: null, emailVerifiedAt: null },
    });
    // Any outstanding codes belong to an address this account no longer has.
    await prisma.authCode.deleteMany({ where: { userId: id } });
    res.json({ ok: true, username: target.username });
  } catch (err) {
    console.error('[adminUsers] clear email failed', err);
    res.status(500).json({ error: 'Server error', code: 'SERVER_ERROR' });
  }
});

/**
 * Delete an account and everything hanging off it.
 *
 * The children are cleared explicitly rather than by a cascade: `WatchList` has
 * no `onDelete: Cascade`, SQLite cannot add one to an existing foreign key
 * without rebuilding the table, and rebuilding a live table is not worth it for
 * an operation that runs a handful of times ever.
 */
router.delete('/:id', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: 'Bad id', code: 'BAD_REQUEST' });

  // Deleting the account you are signed in as is never what you meant, and it
  // would 401 every subsequent request on the page.
  if (id === req.userId) {
    return res
      .status(409)
      .json({ error: 'You cannot delete your own account here.', code: 'BAD_REQUEST' });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const target = await tx.user.findUnique({ where: { id } });
      if (!target) return { status: 404, body: { error: 'User not found', code: 'USER_NOT_FOUND' } };

      if (target.isAdmin) {
        const admins = await tx.user.count({ where: { isAdmin: true } });
        if (admins <= 1) {
          return {
            status: 409,
            body: {
              error: 'This is the only admin account and cannot be deleted.',
              code: 'LAST_ADMIN',
            },
          };
        }
      }

      await tx.watchList.deleteMany({ where: { userId: id } });
      await tx.settings.deleteMany({ where: { userId: id } });
      await tx.authCode.deleteMany({ where: { userId: id } });
      await tx.user.delete({ where: { id } });
      return { status: 200, body: { ok: true, username: target.username } };
    });

    res.status(result.status).json(result.body);
  } catch (err) {
    console.error('[adminUsers] delete failed', err);
    res.status(500).json({ error: 'Server error', code: 'SERVER_ERROR' });
  }
});

/**
 * Send a test message.
 *
 * Mirrors `POST /config/test` on the Jellyfin and Sonarr routers: green here
 * proves the App Password actually authenticates, not merely that five env vars
 * are non-empty. Always 200 so the failure renders inline, same as those two.
 */
router.post('/test-email', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  const { to } = req.body as { to?: string };
  const target = (to || req.user?.email || '').trim();
  if (!target) {
    return res.json({
      ok: false,
      error: 'No address to send to. Set one on your account first.',
    });
  }

  try {
    await getMailer().send(testMail(target));
    res.json({ ok: true, sentTo: target });
  } catch (err: any) {
    if (err instanceof SmtpNotConfiguredError) {
      return res.json({ ok: false, error: 'SMTP is not configured on the server.' });
    }
    // mailErrorInfo, never the error object: a nodemailer error carries
    // `auth.pass`, which is the Gmail App Password in plain text.
    const info = mailErrorInfo(err);
    console.warn('[adminUsers] test email failed:', info);
    res.json({ ok: false, error: info });
  }
});

export default router;
