/**
 * Which upstream alerts are allowed to leave the building, and to whom.
 *
 * Deliberately NOT the SMTP connection. Host, user and password stay in `.env`
 * (see `lib/mailer.ts`): a mail password in `AppConfig` is a mail password in
 * every database backup, and the backups are the one artefact that gets copied
 * around. This file owns only the *policy* - is alerting on, is this service's
 * alerting on, and who else besides the admins should hear about it.
 *
 * Everything that decides is a pure function, so the rules are unit-testable
 * without a mailer and a mutation row can watch each one fail.
 */
import prisma from '../db';

export const ALERT_SETTINGS_KEY = 'alertSettings';

export interface AlertSettings {
  /** The one switch that silences everything. */
  masterEnabled: boolean;
  /**
   * Per service, by registry id. **An absent key means enabled**, which is the
   * load-bearing default: a service added to the registry next year must start
   * out alerting. Storing "off" explicitly and treating absence as off would
   * mean every new dependency arrives silent - the exact failure this whole
   * feature exists to end.
   */
  perService: Record<string, boolean>;
  /**
   * Per service: may it announce that it RECOVERED?
   *
   * **An absent key means disabled** - deliberately the opposite default to
   * `perService` above, and the asymmetry is the point rather than an
   * oversight. That rule protects against a real cost: a dependency added next
   * year breaking silently. Missing a recovery notice costs nothing - you find
   * out it is fine the next time you look.
   *
   * Eight of the nine registered services describe their own outage as some
   * version of "the cache keeps serving", so nothing is waiting on the news.
   * Mail that tells the reader what they already know is precisely what trains
   * them to ignore the sender, which is the failure this feature exists to
   * avoid, one step round.
   */
  perServiceRecovery: Record<string, boolean>;
  /** Addresses beyond the verified admins. */
  extraRecipients: string[];
}

export const DEFAULT_ALERT_SETTINGS: AlertSettings = {
  masterEnabled: true,
  perService: {},
  perServiceRecovery: {},
  extraRecipients: [],
};

/** Bounds, because this is written from a browser and read on a timer. */
const MAX_EXTRA_RECIPIENTS = 20;
const MAX_ADDRESS_LEN = 254; // RFC 5321 path limit
const MAX_SERVICE_KEYS = 50;

/** Is this service allowed to send this KIND of alert? Pure. */
export function alertsEnabledFor(
  settings: AlertSettings,
  id: string,
  /**
   * Required on purpose. The gate itself is pure and unit-tested, but the thing
   * that can silently go wrong is a CALLER forgetting which kind it is asking
   * about - and `announce()` is not exported, so no test can watch that. With
   * no default, omitting it is a compile error instead of a quiet reversion to
   * mailing every recovery.
   */
  kind: 'down' | 'recovered',
): boolean {
  if (!settings.masterEnabled) return false;
  // Outage alerts come first in both senses. A recovery for a service whose
  // outage alerts are off would be "working again" for something the reader was
  // never told had broken - `downAlertedAt` is stamped when the streak crosses
  // whether or not the mail went out, so nothing further down would catch it.
  if (settings.perService[id] === false) return false;
  if (kind === 'recovered') return settings.perServiceRecovery[id] === true;
  return true;
}

/**
 * Who hears about it: whatever the caller resolved as the base set - in
 * practice the owner alone - plus the extras, de-duplicated
 * case-insensitively so adding your own admin address as an "extra" does not
 * send you two copies of everything. Pure - the admin list is passed in.
 */
export function resolveRecipients(settings: AlertSettings, adminEmails: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const addr of [...adminEmails, ...settings.extraRecipients]) {
    const trimmed = (addr ?? '').trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/** A plausible address. Deliberately loose - the mail server is the real judge. */
export function looksLikeEmail(value: string): boolean {
  const v = value.trim();
  if (!v || v.length > MAX_ADDRESS_LEN) return false;
  if (/\s/.test(v)) return false;
  const at = v.indexOf('@');
  return at > 0 && at === v.lastIndexOf('@') && at < v.length - 1 && v.includes('.', at);
}

/**
 * Coerce whatever the PUT route was handed into settings we are willing to
 * store. Pure, total, and never throws: unknown shapes degrade to the defaults
 * rather than persisting something the reader will choke on later.
 */
export function sanitizeSettings(raw: unknown): AlertSettings {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  const perService: Record<string, boolean> = {};
  const rawPer = src.perService;
  if (rawPer && typeof rawPer === 'object') {
    for (const [k, v] of Object.entries(rawPer as Record<string, unknown>).slice(0, MAX_SERVICE_KEYS)) {
      // Only `false` is worth storing; `true` is the default and writing it
      // would pin today's answer over tomorrow's default.
      if (v === false) perService[String(k).slice(0, 64)] = false;
    }
  }

  const perServiceRecovery: Record<string, boolean> = {};
  const rawRecovery = src.perServiceRecovery;
  if (rawRecovery && typeof rawRecovery === 'object') {
    for (const [k, v] of Object.entries(rawRecovery as Record<string, unknown>).slice(0, MAX_SERVICE_KEYS)) {
      // Mirror of the `perService` rule, inverted: only `true` is worth
      // storing, because the default here is off.
      if (v === true) perServiceRecovery[String(k).slice(0, 64)] = true;
    }
  }

  const extras: string[] = [];
  const rawExtras = src.extraRecipients;
  if (Array.isArray(rawExtras)) {
    const seen = new Set<string>();
    for (const e of rawExtras) {
      if (extras.length >= MAX_EXTRA_RECIPIENTS) break;
      if (typeof e !== 'string') continue;
      const v = e.trim();
      if (!looksLikeEmail(v)) continue;
      const key = v.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      extras.push(v);
    }
  }

  return {
    masterEnabled: src.masterEnabled !== false,
    perService,
    perServiceRecovery,
    extraRecipients: extras,
  };
}

/** Stored settings, or the defaults. Never throws - a corrupt row reads as default. */
export async function readAlertSettings(): Promise<AlertSettings> {
  try {
    const row = await prisma.appConfig.findUnique({ where: { key: ALERT_SETTINGS_KEY } });
    if (!row?.value) return { ...DEFAULT_ALERT_SETTINGS };
    return sanitizeSettings(JSON.parse(row.value));
  } catch {
    return { ...DEFAULT_ALERT_SETTINGS };
  }
}

export async function writeAlertSettings(settings: AlertSettings): Promise<void> {
  const value = JSON.stringify(settings);
  await prisma.appConfig.upsert({
    where: { key: ALERT_SETTINGS_KEY },
    update: { value },
    create: { key: ALERT_SETTINGS_KEY, value },
  });
}
