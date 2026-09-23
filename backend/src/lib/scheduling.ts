/**
 * May this process run scheduled jobs that ACT on the world?
 *
 * A dev backend is a full copy of the server: same timers, same credentials,
 * same mailer. Left running overnight it will do the server's job on the
 * server's schedule, from someone's desktop.
 *
 * That is not hypothetical. On 2026-09-23 a dev backend left running after a
 * test run reached the Wednesday 2-4am window, started the real FALL 2026
 * subtitle batch (`C:\...\batch_translate.py --cutoff 10`), watched Python fail
 * to initialise on Windows in 644 ms, and mailed the owner
 * `server subtitle batch failed (exit 3221225794)` at 2:21 in the morning.
 * Nothing was harmed - the process died before it reached YouTube - but the
 * alert was indistinguishable from a real production failure, and 0xC0000142 is
 * an NTSTATUS code that cannot come from the Linux container at all.
 *
 * **Production means `NODE_ENV === 'production'`, and nothing else counts.**
 * The rate limiters ask the opposite question (`development` or unset, so an
 * unexpected value keeps the limiter ON) and that asymmetry is deliberate: both
 * fail towards the safe side, which for a limiter is "protect" and for a job
 * that writes to Sonarr and sends mail is "don't".
 *
 * There is no escape hatch on purpose. Every gated job already has a manual
 * trigger a human can press - Run sweep now, POST /push, the Run-now batch
 * button - so the timer itself never needs exercising locally, and a knob for
 * it would be one nobody turns except by accident.
 */
export function scheduledJobsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'production';
}

/**
 * Local-clock `YYYY-MM-DD`.
 *
 * **Local, not UTC**, and that is load-bearing rather than incidental. Every
 * window gate in this codebase is expressed in local time - the batch
 * scheduler's own `getDay()` / `getHours()`, and `lib/batchSchedule.ts` makes
 * the same choice for the same reason. A UTC key against local gates can roll
 * over in the middle of an open window west of UTC, which hands back exactly
 * the second run the key exists to prevent.
 */
export function localDateKey(d: Date): string {
  return (
    `${d.getFullYear()}-` +
    `${String(d.getMonth() + 1).padStart(2, '0')}-` +
    `${String(d.getDate()).padStart(2, '0')}`
  );
}

/**
 * Has this job already run on `now`'s local date?
 *
 * The durable half of "once per day". Callers keep `lastAt` in `AppConfig` so it
 * survives the restart that loses an in-memory flag - and a deploy landing
 * inside the Wednesday 02:00-04:00 batch window is precisely that restart, which
 * used to start a second night's worth of sequential YouTube downloads.
 *
 * **A missing or unparseable stamp reads as "not run"**, so the job still
 * happens. That is the direction `probeDue` and `parseFetchedAt` already take:
 * failing the other way would let one corrupt row disable the job silently and
 * for ever, which is worse than one extra run.
 */
export function alreadyRanToday(now: Date, lastAt: string | null | undefined): boolean {
  if (!lastAt) return false;
  const then = new Date(lastAt);
  if (Number.isNaN(then.getTime())) return false;
  return localDateKey(then) === localDateKey(now);
}
