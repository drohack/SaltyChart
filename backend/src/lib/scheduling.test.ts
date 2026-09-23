import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scheduledJobsAllowed, localDateKey, alreadyRanToday } from './scheduling';

/**
 * The guard that stops a dev backend doing the server's job on the server's
 * schedule. The story is in `scheduling.ts`; what matters here is that the
 * default direction is OFF, because the cost of being wrong is asymmetric: a
 * missed local timer is invisible, a fired one spawns batches, writes to Sonarr
 * and mails the owner at 2am from someone's desktop.
 */

test('scheduled jobs run in production', () => {
  assert.equal(scheduledJobsAllowed({ NODE_ENV: 'production' } as NodeJS.ProcessEnv), true);
});

test('a dev backend runs no scheduled jobs', () => {
  assert.equal(scheduledJobsAllowed({ NODE_ENV: 'development' } as NodeJS.ProcessEnv), false,
    'ts-node-dev is the case that mailed the owner at 2am');
  assert.equal(scheduledJobsAllowed({} as NodeJS.ProcessEnv), false,
    'unset is the normal local state - `npm run dev` sets nothing');
});

test('anything that is not exactly production counts as not production', () => {
  // The opposite question to the rate limiters, deliberately. They ask "is this
  // development or unset" so an unexpected value keeps the limiter ON; this
  // asks "is this production" so an unexpected value keeps the jobs OFF. Both
  // fail towards the safe side, which is a different side in each case.
  for (const v of ['test', 'staging', 'Production', 'PRODUCTION', '', 'prod']) {
    assert.equal(scheduledJobsAllowed({ NODE_ENV: v } as NodeJS.ProcessEnv), false,
      `NODE_ENV=${JSON.stringify(v)} must not be mistaken for production`);
  }
});

// ---------------------------------------------------------------------------
// The durable half of "once per day".
//
// Both the Wednesday batch and the Sonarr push used to decide "have I already
// run today?" from a value held only in the running process, so a restart
// forgot it. A deploy landing inside the batch's 02:00-04:00 window is that
// restart, and it started a second night of sequential YouTube downloads.
// ---------------------------------------------------------------------------

test('localDateKey is zero-padded so string comparison is date comparison', () => {
  assert.equal(localDateKey(new Date(2026, 0, 5, 13, 0, 0)), '2026-01-05',
    'a single-digit month and day must pad, or 2026-1-5 sorts and compares wrong');
  assert.equal(localDateKey(new Date(2026, 11, 31, 0, 0, 0)), '2026-12-31');
});

test('a job that ran earlier on the same local date has already run', () => {
  const now = new Date(2026, 8, 23, 3, 5, 0);
  const earlier = new Date(2026, 8, 23, 2, 5, 0);
  assert.equal(alreadyRanToday(now, earlier.toISOString()), true,
    'the 02:05 run must still count at the 03:05 check - that is the whole guard');
});

test('yesterday does not count as today', () => {
  const now = new Date(2026, 8, 23, 3, 5, 0);
  const lastWeek = new Date(2026, 8, 16, 2, 5, 0);
  assert.equal(alreadyRanToday(now, lastWeek.toISOString()), false,
    'last Wednesday must not suppress this Wednesday');
});

test('a missing or unparseable stamp lets the job run', () => {
  const now = new Date(2026, 8, 23, 3, 5, 0);
  assert.equal(alreadyRanToday(now, null), false, 'never run means run');
  assert.equal(alreadyRanToday(now, undefined), false);
  assert.equal(alreadyRanToday(now, ''), false);
  assert.equal(alreadyRanToday(now, 'not a date'), false,
    'a corrupt row must make us run, never disable the job for ever');
});

test('the date key follows the local clock, not UTC', () => {
  // Late local evening is already tomorrow in UTC west of the meridian, so a
  // UTC key would roll the day over mid-window and let the same night fire
  // twice. Asserted against the literal key rather than by comparing two
  // instants: `new Date(2026, 8, 23, ...)` is local 23 September on any host,
  // so this states the rule everywhere. (On a UTC host the two readings
  // coincide and there is nothing left to catch - which is correct, not a gap.)
  assert.equal(localDateKey(new Date(2026, 8, 23, 23, 30, 0)), '2026-09-23',
    'the key must name the LOCAL day, even when UTC has already moved on');
  assert.equal(localDateKey(new Date(2026, 8, 23, 0, 30, 0)), '2026-09-23');
});
