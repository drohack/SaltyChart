/**
 * Keep yt-dlp current at runtime.
 *
 * WHY THIS EXISTS AT ALL, given the Dockerfile already upgrades yt-dlp on every
 * deploy: the thing that breaks it is YouTube's release schedule, not ours.
 * YouTube periodically changes what request shapes its media servers will
 * serve, and an aged yt-dlp keeps asking the old way - the download comes back
 * `403 Forbidden` *after* extraction has already succeeded. So the failure
 * arrives during a quiet week with no deploy to carry a fix, and it is close to
 * invisible: already-translated trailers keep serving from `SubtitleCache`, so
 * it reads as "some videos are broken" rather than "downloads are dead".
 *
 * A deploy-time pin fixes today and starts ageing tomorrow. This closes the gap
 * between deploys, so the site heals itself within a day instead of waiting for
 * someone to notice and push.
 *
 * Deliberately best-effort. Anything here failing - no network, PyPI down, a
 * read-only filesystem - must leave the server exactly as it was, still serving
 * whatever yt-dlp it already had.
 *
 * **Is auto-upgrading a library we call by API safe?** The fair worry is that a
 * new yt-dlp renames or drops an option `download_audio` passes. Measured
 * 2026-09-20: `YoutubeDL(...)` **silently ignores options it does not know** -
 * `2026.03.17` accepts both `js_runtimes` (which postdates it) and an invented
 * key, and extracts normally. So the realistic failure is an option quietly
 * becoming a no-op, not a crash - which is why nothing here depends on one for
 * correctness (`js_runtimes` only avoids a deprecation warning). Keep it that
 * way: if an option ever becomes load-bearing, assert its effect rather than
 * assuming the version in the container honours it.
 *
 * Verified end to end 2026-09-20: from a deliberately downgraded `2026.03.17`
 * this logged `updated 2026.03.17 -> 2026.08.19; daemon recycled` and the
 * recycle callback fired exactly once; on an already-current install it logs
 * `up to date` and does not recycle.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { recordUpstream } from './upstreamHealth';

const execFileAsync = promisify(execFile);

const PYTHON = process.platform === 'win32' ? 'python' : 'python3';

/** Installed version, or null if yt-dlp isn't importable at all. */
async function installedVersion(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      PYTHON,
      ['-c', 'import yt_dlp, sys; sys.stdout.write(yt_dlp.version.__version__)'],
      { timeout: 30_000 },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Upgrade yt-dlp in place. Resolves with the before/after versions so the
 * caller can decide whether the daemon needs recycling.
 *
 * `--break-system-packages` matches how the base image installs it (Debian
 * marks the system Python externally-managed); without it pip refuses outright.
 */
export async function updateYtDlp(): Promise<{ before: string | null; after: string | null; changed: boolean; error?: string }> {
  const before = await installedVersion();
  try {
    await execFileAsync(
      PYTHON,
      ['-m', 'pip', 'install', '--no-cache-dir', '--break-system-packages', '--upgrade', 'yt-dlp'],
      // Generous: this competes with Plex and Jellyfin for the box, and a slow
      // PyPI is not a reason to leave a half-applied install behind.
      { timeout: 300_000, maxBuffer: 8 * 1024 * 1024 },
    );
  } catch (err: any) {
    // The upgrade path IS the mechanism that keeps yt-dlp current, so its
    // failure is how the 2026-09 outage aged in unnoticed. Record it.
    void recordUpstream('pypi', false, { reason: err?.message ?? String(err) });
    return { before, after: before, changed: false, error: err?.message ?? String(err) };
  }
  void recordUpstream('pypi', true);
  const after = await installedVersion();
  return { before, after, changed: !!after && after !== before };
}

/**
 * What happened to the running daemon after an upgrade. Three states, because
 * two of them look alike from the outside and mean opposite things for the
 * operator: `busy` = the OLD version is still serving and will be until the
 * daemon respawns; `none` = nothing was running, so the very next spawn already
 * imports the new one.
 */
export type RecycleOutcome = 'recycled' | 'busy' | 'none';

/** The one line the log gets. Pure, so the wording is unit-tested. */
export function recycleOutcomeLine(outcome: RecycleOutcome): string {
  switch (outcome) {
    case 'recycled': return 'daemon recycled, next translation uses it';
    case 'busy': return 'daemon busy with a translation, it keeps the old version until its next respawn';
    case 'none': return 'no daemon was running (not running is the idle norm), the next spawn imports it';
  }
}

/**
 * Run the update and log exactly one line, including when nothing changed.
 *
 * One line a day is not noise: a scheduled job that stays silent unless it acts
 * is indistinguishable from a job that never ran, which makes the timer itself
 * unverifiable. That is the same rule the Sonarr push follows.
 *
 * `recycle` is injected rather than imported so this module stays free of the
 * route layer (and so a test can watch it being called). It is called inside a
 * try: it kills a child process, and a throw there would otherwise escape as an
 * unhandled rejection from the timer that calls this.
 */
export async function runScheduledYtDlpUpdate(recycle: () => RecycleOutcome): Promise<void> {
  const result = await updateYtDlp();

  if (result.error) {
    console.warn(`[yt-dlp] update failed (still on ${result.before ?? 'unknown'}): ${result.error}`);
    return;
  }
  if (!result.changed) {
    console.log(`[yt-dlp] up to date (${result.after ?? 'unknown'})`);
    return;
  }

  let outcome: RecycleOutcome = 'busy';
  try {
    outcome = recycle();
  } catch (err: any) {
    console.warn(`[yt-dlp] recycle failed: ${err?.message ?? String(err)}`);
  }
  console.log(`[yt-dlp] updated ${result.before ?? 'unknown'} -> ${result.after}; ${recycleOutcomeLine(outcome)}`);
}
