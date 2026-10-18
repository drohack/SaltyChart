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
  /** When our own boxes are stopped on purpose - see `MaintenanceWindow`. */
  maintenance: MaintenanceWindow;
}

/**
 * A scheduled job that stops our own containers, so their outage mail waits.
 *
 * The Unraid Appdata Backup plugin stops every container in turn while it
 * archives its appdata. On 2026-10-18 it took Jellyfin down 05:52-06:30 and the
 * owner was mailed "Jellyfin is not responding" for a stop that was planned.
 * The fix is to know the schedule, not to widen `MIN_OUTAGE_MS`: a window long
 * enough to sit out a 40-minute stop would hide every real crash for as long.
 *
 * `cron` is the plugin's own line, copied as-is (Settings -> Appdata Backup,
 * or `/boot/config/plugins/appdata.backup/config.json`), so there is one
 * schedule and no translation of it to drift. It is read in `timeZone`, not
 * the container's clock: the server's crontab runs in local time while the
 * backend container runs in UTC.
 *
 * Mail is HELD, never dropped. A failure inside the window does not cross into
 * an outage (`failureTransition`), so if the service is still failing when the
 * window closes, the next failure crosses and mails - a real crash during a
 * backup is reported late, not lost. A schedule that changes without this one
 * following costs one unnecessary mail, never a missed one.
 */
export interface MaintenanceWindow {
  enabled: boolean;
  /** What runs, for the page and the mail. */
  label: string;
  /** Five-field cron: minute hour day-of-month month day-of-week. */
  cron: string;
  /** How long after each start the window stays open. */
  durationMinutes: number;
  /** IANA zone the cron is written in. */
  timeZone: string;
}

/**
 * Measured, not guessed: `cron` below is the plugin's line on this server
 * (05:00 on the 18th of Jan/Apr/Jul/Oct). The two runs in the syslog took 84
 * and 96 minutes, and Jellyfin was answering again 90 minutes after the start;
 * 150 leaves room for a run that grows with the appdata it archives.
 */
export const DEFAULT_MAINTENANCE: MaintenanceWindow = {
  enabled: true,
  label: 'Unraid appdata backup',
  cron: '0 5 18 */3 *',
  durationMinutes: 150,
  timeZone: 'America/Chicago',
};

export const DEFAULT_ALERT_SETTINGS: AlertSettings = {
  masterEnabled: true,
  perService: {},
  perServiceRecovery: {},
  extraRecipients: [],
  maintenance: { ...DEFAULT_MAINTENANCE },
};

const MAX_MAINTENANCE_MINUTES = 24 * 60;

// --- Maintenance schedule ------------------------------------------------------

/** One cron field as the set of values it allows, or null if it does not parse. */
function parseCronField(field: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part.trim());
    if (!m) return null;
    let lo = min;
    let hi = max;
    if (m[1] !== '*') {
      lo = Number(m[2]);
      // `5/10` is "from 5, every 10" - the range runs to the field's maximum.
      hi = m[3] !== undefined ? Number(m[3]) : m[4] !== undefined ? max : lo;
    }
    const step = m[4] !== undefined ? Number(m[4]) : 1;
    if (lo < min || hi > max || lo > hi || step < 1) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

interface CronSpec {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domAny: boolean;
  dowAny: boolean;
}

/** Parse a five-field cron line. Null for anything cron itself would refuse. */
export function parseCron(expr: string): CronSpec | null {
  const f = String(expr ?? '').trim().split(/\s+/);
  if (f.length !== 5) return null;
  const minute = parseCronField(f[0], 0, 59);
  const hour = parseCronField(f[1], 0, 23);
  const dom = parseCronField(f[2], 1, 31);
  const month = parseCronField(f[3], 1, 12);
  const dow = parseCronField(f[4], 0, 7);
  if (!minute || !hour || !dom || !month || !dow) return null;
  // 7 is Sunday too, in every cron that matters.
  if (dow.has(7)) dow.add(0);
  return { minute, hour, dom, month, dow, domAny: f[2] === '*', dowAny: f[4] === '*' };
}

interface WallClock { minute: number; hour: number; dom: number; month: number; dow: number }

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** A formatter per zone; building one costs far more than using it. */
const formatters = new Map<string, Intl.DateTimeFormat>();
function wallClock(at: Date, timeZone: string): WallClock {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', weekday: 'short',
      month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
    });
    formatters.set(timeZone, fmt);
  }
  const p: Record<string, string> = {};
  for (const { type, value } of fmt.formatToParts(at)) p[type] = value;
  return { minute: +p.minute, hour: +p.hour, dom: +p.day, month: +p.month, dow: WEEKDAY[p.weekday] ?? -1 };
}

/**
 * Does the cron fire in this wall-clock minute? Day-of-month and day-of-week
 * follow cron's own rule: when BOTH are restricted, either one matching is
 * enough - `0 5 1 * 1` is "the 1st, and every Monday", not "a Monday the 1st".
 */
function cronFires(c: CronSpec, w: WallClock): boolean {
  if (!c.minute.has(w.minute) || !c.hour.has(w.hour) || !c.month.has(w.month)) return false;
  const domOk = c.dom.has(w.dom);
  const dowOk = c.dow.has(w.dow);
  if (!c.domAny && !c.dowAny) return domOk || dowOk;
  return domOk && dowOk;
}

/** Is `timeZone` a zone this runtime can actually format in? */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The start of the maintenance window `now` falls in, or null. Walks back a
 * minute at a time across the window, so a run that started before midnight or
 * across a DST change is still found. Pure apart from the formatter cache.
 */
export function maintenanceStartedAt(w: MaintenanceWindow, now: Date): Date | null {
  if (!w.enabled) return null;
  const c = parseCron(w.cron);
  if (!c || !isValidTimeZone(w.timeZone)) return null;
  const top = Math.floor(now.getTime() / 60_000) * 60_000;
  for (let back = 0; back < w.durationMinutes; back++) {
    const at = new Date(top - back * 60_000);
    if (cronFires(c, wallClock(at, w.timeZone))) return at;
  }
  return null;
}

export function inMaintenance(w: MaintenanceWindow, now: Date): boolean {
  return maintenanceStartedAt(w, now) !== null;
}

/**
 * The next start after `now`, within `horizonDays`, or null. Shown on the page
 * so a mistyped cron is visible as a wrong date rather than discovered as an
 * unexpected email. Steps an hour at a time and only drops to minutes inside a
 * matching hour, so a quarterly schedule costs ~2,000 formats, not ~130,000.
 */
export function nextMaintenance(w: MaintenanceWindow, now: Date, horizonDays = 400): Date | null {
  if (!w.enabled) return null;
  const c = parseCron(w.cron);
  if (!c || !isValidTimeZone(w.timeZone)) return null;
  const HOUR = 3_600_000;
  const start = Math.floor(now.getTime() / 60_000) * 60_000 + 60_000;
  const end = start + horizonDays * 24 * HOUR;
  for (let h = Math.floor(start / HOUR) * HOUR; h < end; h += HOUR) {
    const w0 = wallClock(new Date(h), w.timeZone);
    if (!c.hour.has(w0.hour) || !c.month.has(w0.month)) continue;
    for (let m = 0; m < 60; m++) {
      const at = h + m * 60_000;
      if (at < start) continue;
      if (cronFires(c, wallClock(new Date(at), w.timeZone))) return new Date(at);
    }
  }
  return null;
}

function sanitizeMaintenance(raw: unknown): MaintenanceWindow {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_MAINTENANCE };
  const src = raw as Record<string, unknown>;
  const cron = typeof src.cron === 'string' && parseCron(src.cron) ? src.cron.trim().replace(/\s+/g, ' ') : DEFAULT_MAINTENANCE.cron;
  const tz = typeof src.timeZone === 'string' && isValidTimeZone(src.timeZone.trim())
    ? src.timeZone.trim() : DEFAULT_MAINTENANCE.timeZone;
  const mins = Math.round(Number(src.durationMinutes));
  return {
    enabled: src.enabled !== false,
    label: typeof src.label === 'string' && src.label.trim() ? src.label.trim().slice(0, 80) : DEFAULT_MAINTENANCE.label,
    cron,
    durationMinutes: Number.isFinite(mins) && mins >= 1 ? Math.min(mins, MAX_MAINTENANCE_MINUTES) : DEFAULT_MAINTENANCE.durationMinutes,
    timeZone: tz,
  };
}

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
    // A row saved before this field existed has none, and reads as the
    // default schedule - which is ON, because it was written from this
    // server's own crontab.
    maintenance: sanitizeMaintenance(src.maintenance),
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
