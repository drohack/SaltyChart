/**
 * Tell the admins when the trailer-subtitle pipeline breaks - by email.
 *
 * Why email at all, when /admin/subtitles already shows every state: that page
 * is only useful to someone who opens it, and this feature is used four times a
 * year. The 2026-09 outage ran for a month with the evidence sitting on a page
 * nobody had a reason to visit. SMTP is already configured for password-reset
 * codes (lib/mailer.ts); this reuses it.
 *
 * Three rules, each the difference between an alert and noise:
 *
 *  1. **Fire on a state change, never per failure.** The callers own the edge -
 *     the health record's streak crossing BROKEN_AFTER, a batch exiting non-zero,
 *     the Sunday run reporting a failure, or the Sunday run going silent - and
 *     each of those is idempotent across restarts because the state it derives
 *     from is persisted. The silence check is the one that needs its own stamp
 *     (`silentAlertedAt` in the local-run row) so it fires once per silence.
 *  2. **Verified addresses only.** The root rule for this codebase: an
 *     unverified email must never count for anything. `verifiedAdminEmails` is
 *     pure so that rule can be watched to fail.
 *  3. **Never throw onto the caller's path, never log the error object.** A
 *     nodemailer error carries `auth.pass`; `mailErrorInfo` is the only thing
 *     allowed to describe one.
 */
import prisma from '../db';
import { getMailer, mailErrorInfo, type Mailer } from './mailer';
import {
  readAlertSettings,
  resolveRecipients,
  type AlertSettings,
} from './alertSettings';

export const SUBJECT_PREFIX = '[SaltyChart] ';

/**
 * How long the Sunday GPU run may go without reporting before we say so. The
 * task is weekly; eight days is one missed week plus slack for a late start.
 */
export const LOCAL_RUN_SILENT_DAYS = 8;

/** Only rows with BOTH an address and a verification stamp. Pure. */
export function verifiedAdminEmails(
  rows: Array<{ email: string | null; emailVerifiedAt: Date | string | null }>,
): string[] {
  const out: string[] = [];
  for (const r of rows) {
    if (!r.email || !r.emailVerifiedAt) continue;
    out.push(r.email);
  }
  return out;
}

/**
 * Has the Sunday run gone quiet? Pure.
 *
 *  - `never`: no report has ever arrived. Silence cannot be judged yet - the
 *    first report arms this. (Residual gap: a task that never fires even once
 *    after deploy is not detected; documented in backend/CLAUDE.md.)
 *  - `fresh`: reported within the window.
 *  - `silent`: older than the window and nobody has been told.
 *  - `alreadyAlerted`: older than the window and the stamp says we have.
 */
export function localRunSilence(
  run: { reportedAt: string; silentAlertedAt?: string | null } | null,
  now: number = Date.now(),
  days: number = LOCAL_RUN_SILENT_DAYS,
): 'never' | 'fresh' | 'silent' | 'alreadyAlerted' {
  if (!run || !run.reportedAt) return 'never';
  const age = now - Date.parse(run.reportedAt);
  if (!(age > days * 24 * 3600 * 1000)) return 'fresh';
  if (run.silentAlertedAt) return 'alreadyAlerted';
  return 'silent';
}

/**
 * The owner: the FIRST admin account that has a verified address.
 *
 * Derived, never configured - there is no owner column, no env var and nothing
 * hardcoded. "First" is the lowest `User.id`, because ids are autoincrement so
 * the earliest account always has the lowest one; `createdAt` would say the
 * same thing but can be null on rows that predate it, and a null sort key is
 * exactly how a "first" lookup silently picks someone else.
 *
 * An UNVERIFIED address can never make someone the owner. That is the same rule
 * the password-reset path follows (`resetPathFor`): a typo in an address would
 * otherwise redirect every alert to nobody, permanently and silently.
 *
 * This does not create a root account - admins remain peers for every
 * permission. It only answers "who is the one person alerts go to by default",
 * which previously had no answer at all. Pure, so it is unit-testable.
 */
export function ownerEmail(
  rows: Array<{ id: number; email: string | null; emailVerifiedAt: Date | string | null }>,
): string | null {
  let best: { id: number; email: string } | null = null;
  for (const r of rows) {
    if (!r.email || !r.emailVerifiedAt) continue;
    if (!best || r.id < best.id) best = { id: r.id, email: r.email };
  }
  return best ? best.email : null;
}

/**
 * Who hears about it by default: the owner, alone.
 *
 * Deliberately NOT every verified admin. A second admin promoted later is a
 * peer for permissions but is not signed up to receive the site's operational
 * mail, and adding them silently would be a decision nobody made. They can be
 * added on /admin/status, which is the place that choice belongs.
 */
async function defaultRecipients(): Promise<string[]> {
  const rows = await prisma.user.findMany({
    where: { isAdmin: true },
    select: { id: true, email: true, emailVerifiedAt: true },
  });
  const owner = ownerEmail(rows);
  // The extras someone typed on /admin/status, folded in and de-duplicated by
  // the one function that owns that rule. Without this the page offered a box
  // that governed nothing - and a setting that silently does nothing is worse
  // than no setting, because it is believed.
  const settings = await readAlertSettings();
  return resolveRecipients(settings, owner ? [owner] : []);
}

/**
 * Send one plain-text mail to every admin with a verified address.
 *
 * Returns what happened rather than throwing: callers are on the translation
 * path or a timer, and an alert failing must never become a second failure.
 * `deps` exists for tests (an injected `Mailer`, a fixed recipient list).
 */
export async function alertAdmins(
  subject: string,
  text: string,
  deps: {
    mailer?: Mailer;
    recipients?: () => Promise<string[]>;
    /** Injected so the OFF path is testable without a database. */
    settings?: () => Promise<AlertSettings>;
  } = {},
): Promise<{ sent: number; skipped: string | null }> {
  const mailer = deps.mailer ?? getMailer();
  const full = SUBJECT_PREFIX + subject;
  try {
    // The master switch on /admin/status, honoured HERE because this is the one
    // funnel every alert in the codebase goes through - the download-path
    // break, the Wednesday batch, the Sunday report and its silence. It was
    // added to the page before anything read it, so "alerts off" kept mailing:
    // a control that lies is worse than no control. Read through `deps` so the
    // OFF path is a unit test rather than a database row - and note the read
    // FAILS OPEN (readAlertSettings returns the default on any error), because
    // a broken settings row must not silence the alerts it governs.
    if (!(await (deps.settings ?? readAlertSettings)()).masterEnabled) {
      console.log(`[alerts] alerts are switched off on /admin/status; not sending: ${full}`);
      return { sent: 0, skipped: 'alerts-disabled' };
    }
    if (!mailer.configured()) {
      console.log(`[alerts] SMTP not configured; would have sent: ${full}`);
      return { sent: 0, skipped: 'smtp-not-configured' };
    }
    const to = await (deps.recipients ?? defaultRecipients)();
    if (to.length === 0) {
      console.warn(`[alerts] no admin has a verified email address; could not send: ${full}`);
      return { sent: 0, skipped: 'no-recipients' };
    }
    let sent = 0;
    for (let i = 0; i < to.length; i++) {
      try {
        await mailer.send({ to: to[i], subject: full, text });
        sent++;
      } catch (err) {
        // Recipient index, not address: an address in the log is one more
        // place it leaks, and the count is what the operator needs.
        console.warn(`[alerts] send to admin #${i + 1} failed: ${mailErrorInfo(err)}`);
      }
    }
    console.log(`[alerts] sent "${full}" to ${sent} of ${to.length} admin(s)`);
    return { sent, skipped: null };
  } catch (err) {
    console.warn(`[alerts] could not send "${full}": ${mailErrorInfo(err)}`);
    return { sent: 0, skipped: 'error' };
  }
}
