/**
 * When the server-side batch translation runs, and whether it would run next.
 *
 * Extracted from the scheduler IIFE in `index.ts` so the scheduler and
 * `/admin/subtitles` describe the **same** schedule. A second copy of "Wednesday
 * 2-4 am, within 50 days" would eventually drift, and the page would confidently
 * name a night the job does not run - the `MODEL_RANK`-in-three-places mistake
 * in miniature.
 *
 * **Everything here is LOCAL time**, matching the scheduler's own `getDay()` /
 * `getHours()` gates. Describing the schedule in UTC would name a different
 * night west of UTC, four times a year at the season boundaries and every week
 * for the window itself.
 *
 * Pure: every function takes `now` rather than reading the clock, so the
 * behaviour is testable without waiting for a Wednesday.
 */

export const BATCH_SCHEDULER_HOUR_START = 2; // Start window (2am)
export const BATCH_SCHEDULER_HOUR_END = 4;   // End window (4am) - only starts new batches in this range
export const BATCH_DAYS_BEFORE_SEASON = 50;  // How many days before season start to begin batching
export const BATCH_DAY_OF_WEEK = 3;          // Wednesday (0=Sun, 3=Wed)

export const SEASON_STARTS: Array<{ season: string; month: number; day: number }> = [
  { season: 'WINTER', month: 0, day: 1 }, // Jan 1
  { season: 'SPRING', month: 3, day: 1 }, // Apr 1
  { season: 'SUMMER', month: 6, day: 1 }, // Jul 1
  { season: 'FALL', month: 9, day: 1 },   // Oct 1
];

export interface NextSeason {
  season: string;
  year: number;
  daysUntil: number;
}

/** The next season start after `now`, however far away. Never null. */
export function upcomingSeason(now: Date): NextSeason {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  for (let yearOffset = 0; yearOffset <= 1; yearOffset++) {
    for (const { season, month, day } of SEASON_STARTS) {
      const start = new Date(now.getFullYear() + yearOffset, month, day);
      const daysUntil = Math.ceil((start.getTime() - today.getTime()) / 86_400_000);
      if (daysUntil > 0) return { season, year: start.getFullYear(), daysUntil };
    }
  }
  // Unreachable: Jan 1 of next year is always ahead of any date in this year.
  throw new Error('no upcoming season start found');
}

/**
 * The next season start, but **only if it is inside the batching threshold**.
 *
 * Null is the scheduler's "do not run": 50 days gives the local GPU run first
 * crack at a season, so the medium batch only picks up what it missed.
 */
export function getNextSeasonInfo(now: Date): NextSeason | null {
  const next = upcomingSeason(now);
  return next.daysUntil <= BATCH_DAYS_BEFORE_SEASON ? next : null;
}

export interface BatchWindow {
  /** When the next window opens. Today, if today's window has not closed yet. */
  at: Date;
  /** Is the window open right now? */
  inWindowNow: boolean;
}

/**
 * The next Wednesday 2 am, or today's if it has not closed.
 *
 * A window that is currently open reports today rather than next week - the
 * scheduler checks hourly, so an open window is a run that may still happen in
 * the next few minutes.
 */
export function nextBatchWindow(now: Date): BatchWindow {
  const isBatchDay = now.getDay() === BATCH_DAY_OF_WEEK;
  const hour = now.getHours();
  const inWindowNow =
    isBatchDay && hour >= BATCH_SCHEDULER_HOUR_START && hour < BATCH_SCHEDULER_HOUR_END;

  // Today still counts while the window is open or has not opened yet.
  const todayStillValid = isBatchDay && hour < BATCH_SCHEDULER_HOUR_END;
  const daysAhead = todayStillValid ? 0 : ((BATCH_DAY_OF_WEEK - now.getDay() + 7) % 7) || 7;

  const at = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + daysAhead,
    BATCH_SCHEDULER_HOUR_START,
    0,
    0,
    0
  );
  return { at, inWindowNow };
}

export interface BatchScheduleDescription {
  dayOfWeek: number;
  hourStart: number;
  hourEnd: number;
  daysBeforeSeason: number;
  /** The next season start, named whether or not it is close enough to batch. */
  nextSeason: string;
  nextSeasonYear: number;
  daysUntilNextSeason: number;
  nextWindowAt: string;
  inWindowNow: boolean;
  /**
   * Would the batch actually start at that window?
   *
   * Evaluated **at the window**, not at `now`: a page that says "next run
   * Wednesday" without re-checking the threshold promises a run the scheduler is
   * going to decline.
   */
  wouldFireAtNextWindow: boolean;
}

export function describeBatchSchedule(now: Date): BatchScheduleDescription {
  const next = upcomingSeason(now);
  const window = nextBatchWindow(now);
  return {
    dayOfWeek: BATCH_DAY_OF_WEEK,
    hourStart: BATCH_SCHEDULER_HOUR_START,
    hourEnd: BATCH_SCHEDULER_HOUR_END,
    daysBeforeSeason: BATCH_DAYS_BEFORE_SEASON,
    nextSeason: next.season,
    nextSeasonYear: next.year,
    daysUntilNextSeason: next.daysUntil,
    nextWindowAt: window.at.toISOString(),
    inWindowNow: window.inWindowNow,
    wouldFireAtNextWindow: getNextSeasonInfo(window.at) !== null,
  };
}
