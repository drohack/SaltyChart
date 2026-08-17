import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getNextSeasonInfo,
  nextBatchWindow,
  describeBatchSchedule,
  BATCH_DAY_OF_WEEK,
  BATCH_SCHEDULER_HOUR_START,
  BATCH_DAYS_BEFORE_SEASON,
} from './batchSchedule';

// Everything here works in LOCAL time on purpose - the scheduler's day/hour
// gates use local getters, and a description built from UTC would name a
// different night than the one the job actually runs on.
//
// 2026-08-19 is a Wednesday; 2026-08-17 is a Monday.

test('the next season inside the threshold is found and dated', () => {
  const info = getNextSeasonInfo(new Date(2026, 7, 16, 12, 0)); // 16 Aug 2026
  assert.deepEqual(info, { season: 'FALL', year: 2026, daysUntil: 46 }, 'Oct 1 is 46 days from 16 Aug');
});

test('nothing within the threshold reports null, which is what stops the batch', () => {
  // 5 Jul 2026 -> Oct 1 is 88 days. The batch must not start this early; the
  // whole point of the gate is to give the local GPU run first crack.
  assert.equal(getNextSeasonInfo(new Date(2026, 6, 5, 12, 0)), null, 'a season 88 days out is out of range');
});

test('the search rolls into next year rather than stopping in December', () => {
  const info = getNextSeasonInfo(new Date(2026, 11, 1, 12, 0)); // 1 Dec 2026
  assert.deepEqual(info, { season: 'WINTER', year: 2027, daysUntil: 31 }, 'Jan 1 2027 is found from December');
});

test('the next window is always a Wednesday at the start hour', () => {
  const w = nextBatchWindow(new Date(2026, 7, 17, 10, 0)); // Monday
  assert.equal(w.at.getDay(), BATCH_DAY_OF_WEEK, 'the window lands on Wednesday');
  assert.equal(w.at.getHours(), BATCH_SCHEDULER_HOUR_START, 'the window opens at the start hour');
  assert.equal(w.at.getMinutes(), 0);
  assert.equal(w.inWindowNow, false, 'a Monday morning is not inside the window');
});

test('a Wednesday inside the window reports the window as open now', () => {
  const w = nextBatchWindow(new Date(2026, 7, 19, 3, 0)); // Wed 3am, mid-window
  assert.equal(w.inWindowNow, true, 'Wednesday 3am is inside the 2am-4am window');
  assert.equal(w.at.getDate(), 19, 'the open window is today, not next week');
});

test('a Wednesday past the window waits a full week', () => {
  const w = nextBatchWindow(new Date(2026, 7, 19, 5, 0)); // Wed 5am, window closed
  assert.equal(w.inWindowNow, false, 'Wednesday 5am is past the window');
  assert.equal(w.at.getDate(), 26, 'the next window is the following Wednesday');
});

test('a Wednesday before the window opens is still today', () => {
  const w = nextBatchWindow(new Date(2026, 7, 19, 1, 0)); // Wed 1am
  assert.equal(w.inWindowNow, false, 'an hour before opening is not inside the window');
  assert.equal(w.at.getDate(), 19, 'the window still opens later today');
});

test('the description says it would run when the season is close enough at that window', () => {
  const d = describeBatchSchedule(new Date(2026, 7, 16, 12, 0)); // 16 Aug 2026
  assert.equal(d.wouldFireAtNextWindow, true, 'the next Wednesday is inside the 50-day range of FALL');
  assert.equal(d.nextSeason, 'FALL');
  assert.equal(d.nextSeasonYear, 2026);
  assert.equal(d.daysBeforeSeason, BATCH_DAYS_BEFORE_SEASON);
});

test('the description evaluates the threshold at the window, not at now', () => {
  // 8 Jul 2026: the next Wednesday is still ~78 days from Oct 1, so the batch
  // will NOT run then. Saying "next run Wednesday" without this check would
  // promise a run that the scheduler is going to decline.
  const d = describeBatchSchedule(new Date(2026, 6, 8, 12, 0));
  assert.equal(d.wouldFireAtNextWindow, false, 'the batch declines to run while the season is out of range');
  assert.equal(d.nextSeason, 'FALL', 'the next season is still named even when out of range');
  assert.equal(d.daysUntilNextSeason > BATCH_DAYS_BEFORE_SEASON, true, 'and its distance says why');
});

test('the next season is named even when no season is within the threshold', () => {
  // getNextSeasonInfo returns null out of range; the page still has to say what
  // it is waiting for, or "will not run" reads as broken rather than early.
  const d = describeBatchSchedule(new Date(2026, 6, 5, 12, 0));
  assert.equal(d.nextSeason, 'FALL', 'FALL is named despite being out of range');
  assert.equal(d.daysUntilNextSeason, 88, 'Oct 1 is 88 days from 5 Jul');
});
