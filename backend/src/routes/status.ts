/**
 * `/api/status` - what every upstream service is doing, and who hears about it.
 *
 * Admin-only throughout. There is no viewer-facing half: the page names the
 * services this deployment depends on, their failure text, and the addresses
 * that get alerted, none of which a viewer has any business reading.
 *
 * THE ONE RULE THIS ROUTE ENFORCES FOR THE PAGE: the verdict is decided here,
 * not in Svelte. `stateOf` distinguishes `ok` / `failing` / `down` / `unknown`
 * / `notConfigured`, and the two that exist purely to stop a reader being
 * misled - "we have not asked yet" and "nobody set this up" - must never arrive
 * at the browser as a healthy zero. The page renders a verdict; it does not
 * compute one. Same division as `/admin/subtitles`, where `broken` and
 * `staleYtDlp` are decided in `lib/downloadHealth.ts`.
 */
import express, { Response, Router } from 'express';
import { AuthRequest, requireAdmin, requireAuth } from '../middleware/auth';
import { getDownloadHealth } from '../lib/downloadHealth';
import { getMailer } from '../lib/mailer';
import { ownerEmail } from '../lib/subtitleAlerts';
import prisma from '../db';
import {
  EMPTY_RECORD,
  UPSTREAMS,
  readAll,
  stateOf,
  type UpstreamRecord,
} from '../lib/upstreamHealth';
import { PROBES, runDueProbes } from '../lib/upstreamProbes';
import {
  alertsEnabledFor,
  readAlertSettings,
  sanitizeSettings,
  writeAlertSettings,
} from '../lib/alertSettings';

const router: Router = express.Router();

/**
 * YouTube's record lives in `lib/downloadHealth.ts`, which owns the bot-wall
 * hold and the stale-yt-dlp hint and is pinned by mutation rows. Rather than
 * duplicate it, the page composes it - so the status page and
 * `/admin/subtitles` can never disagree about whether downloads are working.
 */
async function youtubeRecord(): Promise<UpstreamRecord> {
  const h = await getDownloadHealth();
  return {
    lastOkAt: h.lastOkAt,
    lastFailAt: h.lastFailAt,
    lastFailReason: h.lastFailReason,
    lastFailStatus: null,
    consecutiveFailures: h.consecutiveFailures,
    okCount: h.okCount,
    failCount: h.failCount,
    lastCheckedAt: h.lastOkAt ?? h.lastFailAt,
    lastSkipped: null,
    // downloadHealth keeps its own once-only logging, so this composed view
    // never drives an alert and has nothing to remember.
    downAlertedAt: null,
  };
}

/**
 * GET /api/status/report - every service, its verdict, and the alert settings.
 */
router.get('/report', requireAuth, requireAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    const [records, settings] = await Promise.all([readAll(), readAlertSettings()]);
    const yt = await youtubeRecord();

    // One instant for every row: `stateOf` is now time-dependent, and grading
    // two services in the same response against different clocks would be a
    // quiet way for the page to disagree with itself.
    const now = new Date().toISOString();
    const services = UPSTREAMS.map((spec) => {
      const rec = spec.recordSource === 'downloadHealth'
        ? yt
        : records[spec.id] ?? { ...EMPTY_RECORD };
      return {
        id: spec.id,
        label: spec.label,
        impact: spec.impact,
        adminPath: spec.adminPath ?? null,
        brokenAfter: spec.brokenAfter,
        // `probed: false` is why a row may sit at `unknown` for ever without
        // anything being wrong - the page has to be able to say so.
        probed: !spec.passiveOnly && !!PROBES[spec.id],
        passiveOnly: !!spec.passiveOnly,
        alertsEnabled: alertsEnabledFor(settings, spec.id, 'down'),
        // Separate switch, and off unless asked for - see `perServiceRecovery`.
        recoveryAlertsEnabled: alertsEnabledFor(settings, spec.id, 'recovered'),
        state: stateOf(rec, spec.brokenAfter, now),
        ...rec,
      };
    });

    // Who alerts actually reach. Shown because "it is configured" and "it will
    // reach a person" are different claims, and only the second one matters.
    const owner = ownerEmail(
      await prisma.user.findMany({
        where: { isAdmin: true },
        select: { id: true, email: true, emailVerifiedAt: true },
      }),
    );

    res.json({
      services,
      settings,
      owner,
      // The circular case, stated rather than implied: with SMTP down nothing
      // can mail to say so, which is why the page shows this directly.
      smtpConfigured: getMailer().configured(),
      generatedAt: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error('[status/report] could not build the report:', err?.message ?? err);
    res.status(500).json({ error: 'Could not read service status', code: 'SERVER_ERROR' });
  }
});

/**
 * PUT /api/status/alerts - save the alert settings.
 *
 * The body is coerced by `sanitizeSettings` rather than validated-and-rejected:
 * these are preferences, not a transaction, and silently dropping a malformed
 * address is friendlier than refusing the whole save. The response echoes what
 * was actually stored so the page cannot believe it saved something it didn't.
 */
router.put('/alerts', express.json({ limit: '16kb' }), requireAuth, requireAdmin,
  async (req: AuthRequest, res: Response) => {
    try {
      const settings = sanitizeSettings(req.body);
      await writeAlertSettings(settings);
      const off = Object.keys(settings.perService).length;
      const rec = Object.keys(settings.perServiceRecovery).length;
      console.log(
        `[status] alert settings saved: master ${settings.masterEnabled ? 'on' : 'OFF'}, ` +
        `${off} service(s) silenced, ${rec} announcing recovery, ` +
        `${settings.extraRecipients.length} extra recipient(s)`,
      );
      res.json({ ok: true, settings });
    } catch (err: any) {
      console.error('[status/alerts] could not save:', err?.message ?? err);
      res.status(500).json({ error: 'Could not save alert settings', code: 'SERVER_ERROR' });
    }
  });

/**
 * POST /api/status/probe - check now.
 *
 * `force` runs every probeable service regardless of when it last ran; the
 * passive-only ones stay unprobed even here, because a hand-fired YouTube or
 * AniList request would compete with the very thing being measured.
 */
router.post('/probe', express.json({ limit: '1kb' }), requireAuth, requireAdmin,
  async (_req: AuthRequest, res: Response) => {
    try {
      const summary = await runDueProbes(true);
      console.log(summary);
      res.json({ ok: true, summary });
    } catch (err: any) {
      console.error('[status/probe] probe run failed:', err?.message ?? err);
      res.status(500).json({ error: 'Could not run the checks', code: 'SERVER_ERROR' });
    }
  });

export default router;
