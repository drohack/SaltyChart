import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scheduledJobsAllowed } from './scheduling';

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
