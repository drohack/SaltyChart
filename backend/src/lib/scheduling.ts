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
