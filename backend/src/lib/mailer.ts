/**
 * Outbound mail - the one thing in this codebase that sends email.
 *
 * Deliberately plain SMTP with the server named in the environment, not an
 * API-shaped provider. Gmail with an App Password costs nothing and needs no
 * domain; Namecheap Private Email would send from `noreply@saltychart.net` for
 * about $1/month. Both are host/port/user/pass, so switching is four env vars
 * and a restart, and nothing about that choice is encoded here.
 *
 * **Unset SMTP does not fail startup.** `JWT_SECRET` does, and rightly - a
 * server that cannot sign tokens cannot work at all. Mail is different: local
 * dev never needs it, and any deploy made before the values are set would
 * refuse to boot for a feature nobody had configured yet. It fails at the point
 * of use, loudly, with `SMTP_NOT_CONFIGURED`.
 *
 * The transport is injectable so tests capture instead of sending. A mocked
 * mailer passing proves nothing about a real App Password, which is why one
 * live send is verified by hand rather than inferred from a green suite.
 */

import nodemailer, { type Transporter } from 'nodemailer';

export interface OutboundMail {
  to: string;
  subject: string;
  text: string;
}

/** What the routes depend on. A test substitutes this; production gets SMTP. */
export interface Mailer {
  send(mail: OutboundMail): Promise<void>;
  /** False when the environment is incomplete, so callers can refuse early. */
  configured(): boolean;
  /** Human-readable description of where mail goes, for the admin page. */
  describe(): string;
}

export class SmtpNotConfiguredError extends Error {
  readonly code = 'SMTP_NOT_CONFIGURED';
  constructor() {
    super('Email is not configured on the server.');
  }
}

/**
 * A loggable summary of a failed send - **never the error object**.
 *
 * A nodemailer error carries the transport options, and those carry
 * `auth.pass`: the Gmail App Password, in plain text, into the Docker logs and
 * into anything anyone pastes from them. This is the same bug the Jellyfin key
 * had - see `jellyfinErrorInfo` in `lib/jellyfinApi.ts`, where an axios error's
 * `config` printed `Token="..."` into the backend log on a timeout.
 *
 * Use this at every `catch` that logs a mail failure.
 */
export function mailErrorInfo(err: any): string {
  const parts = [err?.code, err?.responseCode ? `SMTP ${err.responseCode}` : null, err?.message]
    .filter(Boolean)
    .map(String);
  return parts.length ? parts.join(' ') : String(err);
}

function envConfig() {
  const host = process.env.SMTP_HOST?.trim() || '';
  const user = process.env.SMTP_USER?.trim() || '';
  const pass = process.env.SMTP_PASS || '';
  const port = parseInt(process.env.SMTP_PORT || '465', 10);
  // Falling back to the username keeps a half-filled .env working: for Gmail
  // the From address is the account anyway, and a missing SMTP_FROM would
  // otherwise fail sends for a purely cosmetic reason.
  const from = process.env.SMTP_FROM?.trim() || user;
  return { host, user, pass, port, from };
}

/**
 * The real SMTP mailer.
 *
 * `secure` is derived from the port rather than configured separately: 465 is
 * implicit TLS and 587 is STARTTLS, and getting that pair inconsistent is the
 * classic way to produce a connection that hangs instead of failing.
 */
export function smtpMailer(): Mailer {
  let cached: Transporter | null = null;

  function transport(): Transporter {
    const cfg = envConfig();
    if (!cfg.host || !cfg.user || !cfg.pass) throw new SmtpNotConfiguredError();
    if (!cached) {
      cached = nodemailer.createTransport({
        host: cfg.host,
        port: cfg.port,
        secure: cfg.port === 465,
        auth: { user: cfg.user, pass: cfg.pass },
      });
    }
    return cached;
  }

  return {
    configured() {
      const cfg = envConfig();
      return !!(cfg.host && cfg.user && cfg.pass);
    },
    describe() {
      const cfg = envConfig();
      if (!cfg.host) return 'not configured';
      return `${cfg.from || cfg.user} via ${cfg.host}:${cfg.port}`;
    },
    async send(mail) {
      const cfg = envConfig();
      await transport().sendMail({
        from: cfg.from,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
      });
    },
  };
}

/** A capturing mailer for tests. Never reaches the network. */
export function captureMailer(): Mailer & { sent: OutboundMail[] } {
  const sent: OutboundMail[] = [];
  return {
    sent,
    configured: () => true,
    describe: () => 'capture (test)',
    async send(mail) {
      sent.push(mail);
    },
  };
}

let active: Mailer = smtpMailer();

/** Swap the mailer. Tests use this; production never calls it. */
export function setMailer(m: Mailer): void {
  active = m;
}

export function getMailer(): Mailer {
  return active;
}

// ---------------------------------------------------------------------------
// Message bodies
//
// Plain text on purpose. HTML mail buys nothing for a six-digit code and gives
// a spam filter more to dislike; a code that lands in Junk is a feature that
// does not work.
// ---------------------------------------------------------------------------

export function resetCodeMail(to: string, code: string, minutes: number): OutboundMail {
  return {
    to,
    subject: `SaltyChart password reset code: ${code}`,
    text:
      `Your SaltyChart password reset code is ${code}\n\n` +
      `It expires in ${minutes} minutes and can be used once.\n\n` +
      `If you did not ask to reset your password, you can ignore this email - ` +
      `nothing has changed on your account.\n`,
  };
}

export function verifyEmailMail(to: string, code: string, minutes: number): OutboundMail {
  return {
    to,
    subject: `SaltyChart email verification code: ${code}`,
    text:
      `Your SaltyChart verification code is ${code}\n\n` +
      `Enter it on the site to confirm this address. It expires in ${minutes} minutes.\n\n` +
      `Until you confirm it, this address is not used for anything.\n`,
  };
}

export function testMail(to: string): OutboundMail {
  return {
    to,
    subject: 'SaltyChart test email',
    text:
      `This is a test message from SaltyChart.\n\n` +
      `If you are reading it, the server's SMTP settings work and password ` +
      `reset codes will be delivered.\n`,
  };
}
