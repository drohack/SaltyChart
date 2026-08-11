import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decidePush,
  planPushRun,
  classifyAddError,
  newlyHeldToRecord,
  findOrphans,
  isTerminal,
  type PushRow,
  type PushStatus,
  type PushCandidate,
} from './sonarrPush';

// Assertion messages are written as stories on purpose: they become the
// `expect` substrings mutation_audit.py matches on.

const NONE: ReadonlySet<number> = new Set<number>();

function candidate(tvdbId: number): PushCandidate {
  return { tvdbId, anilistId: tvdbId * 10, title: `Show ${tvdbId}` };
}

function prior(tvdbId: number, status: PushStatus): PushRow {
  return {
    tvdbId,
    anilistId: tvdbId * 10,
    title: `Show ${tvdbId}`,
    status,
    sonarrSeriesId: status === 'pushed' ? 500 + tvdbId : null,
    pushedAt: status === 'pushed' ? new Date('2026-08-01T00:00:00Z') : null,
    attempts: 1,
    lastAttemptAt: new Date('2026-08-01T00:00:00Z'),
    lastError: null,
  };
}

// --- the one-and-done guarantee -------------------------------------------

test('a series we already pushed is never pushed again, even once Sonarr no longer holds it', () => {
  // The whole feature in one assertion: the candidate is absent from `held`,
  // i.e. it has been deleted since. That must not bring it back.
  const d = decidePush(candidate(1), prior(1, 'pushed'), NONE, NONE);
  assert.deepEqual(d, { action: 'skip', reason: 'alreadyPushed' });
});

test('a series recorded as already held is never pushed, even once it is deleted', () => {
  const d = decidePush(candidate(2), prior(2, 'alreadyHeld'), NONE, NONE);
  assert.deepEqual(d, { action: 'skip', reason: 'alreadyHeld' });
});

test('a terminal record outranks the live library, so the reason stays alreadyPushed', () => {
  // Order test: both branches would skip, but only the terminal one is the
  // permanent record. A generic "it skipped anyway" assertion would pass with
  // the terminal check deleted, which is why this pins the reason.
  const d = decidePush(candidate(3), prior(3, 'pushed'), new Set([3]), NONE);
  assert.deepEqual(d, { action: 'skip', reason: 'alreadyPushed' });
});

// --- the retryable cases, which are the only reason to try twice ------------

test('a failed add is retried, because nothing was added and Sonarr may be back', () => {
  const d = decidePush(candidate(4), prior(4, 'failed'), NONE, NONE);
  assert.deepEqual(d, { action: 'push' }, 'failed must not be terminal');
});

test('a lookup failure is retried, because a corrected identity is how it gets fixed', () => {
  const d = decidePush(candidate(5), prior(5, 'lookupFailed'), NONE, NONE);
  assert.deepEqual(d, { action: 'push' }, 'lookupFailed must not be terminal');
});

test('only pushed and alreadyHeld are terminal', () => {
  assert.equal(isTerminal('pushed'), true);
  assert.equal(isTerminal('alreadyHeld'), true);
  assert.equal(isTerminal('failed'), false, 'a failed add must stay retryable');
  assert.equal(isTerminal('lookupFailed'), false, 'a bad id must stay retryable');
});

// --- what the library and the exclusion list say ---------------------------

test('a series Sonarr already holds is skipped rather than pushed', () => {
  const d = decidePush(candidate(6), undefined, new Set([6]), NONE);
  assert.deepEqual(d, { action: 'skip', reason: 'alreadyHeld' });
});

test('a series on Sonarr Import List Exclusions is skipped as a human decision', () => {
  const d = decidePush(candidate(7), undefined, NONE, new Set([7]));
  assert.deepEqual(d, { action: 'skip', reason: 'excluded' });
});

test('a brand new candidate with no history is pushed', () => {
  assert.deepEqual(decidePush(candidate(8), undefined, NONE, NONE), { action: 'push' });
});

// --- the cap must never lose anything --------------------------------------

test('the run cap defers the overflow instead of dropping it', () => {
  const cands = [1, 2, 3, 4, 5].map(candidate);
  const plan = planPushRun(cands, new Map(), NONE, NONE, 2);
  assert.equal(plan.toPush.length, 2, 'cap of 2 must push exactly 2');
  assert.equal(plan.deferred.length, 3, 'the rest are deferred, not discarded');
});

test('every candidate is accounted for as pushed, deferred or skipped', () => {
  const cands = [1, 2, 3, 4, 5, 6].map(candidate);
  const priors = new Map([[1, prior(1, 'pushed')]]);
  const plan = planPushRun(cands, priors, new Set([2]), new Set([3]), 2);
  const total = plan.toPush.length + plan.deferred.length + plan.skipped.length;
  assert.equal(total, cands.length, 'a candidate must never vanish between the plan and the run');
  assert.equal(plan.skipped.length, 3, 'one prior, one held and one excluded were skipped');
});

test('skipped candidates do not consume the cap', () => {
  // Otherwise a season already in the library would spend the whole budget on
  // no-ops and never reach the entries that actually need adding.
  const cands = [1, 2, 3, 4].map(candidate);
  const plan = planPushRun(cands, new Map(), new Set([1, 2]), NONE, 2);
  assert.equal(plan.toPush.length, 2, 'both remaining candidates still fit the cap');
  assert.equal(plan.deferred.length, 0);
});

// --- recording what Sonarr already holds -----------------------------------

test('a series Sonarr already holds is recorded, so deleting it later cannot re-add it', () => {
  // The gap this closes was real and invisible: held series were skipped from
  // the LIVE snapshot every run, so one you deleted became a fresh candidate.
  const rows = newlyHeldToRecord(
    [{ candidate: candidate(1), reason: 'alreadyHeld' }],
    new Set()
  );
  assert.deepEqual(rows.map((r) => r.tvdbId), [1]);
});

test('an exclusion is never recorded, because it can be undone in Sonarr', () => {
  const rows = newlyHeldToRecord(
    [{ candidate: candidate(2), reason: 'excluded' }],
    new Set()
  );
  assert.deepEqual(rows, [], 'a terminal row would outlive the human decision behind it');
});

test('a series that already has a row is not recorded again', () => {
  const rows = newlyHeldToRecord(
    [{ candidate: candidate(3), reason: 'alreadyHeld' }],
    new Set([3])
  );
  assert.deepEqual(rows, [], 'an existing row must not be overwritten by a later run');
});

test('a skip for our own prior push is not re-recorded as merely held', () => {
  // `alreadyPushed` and `alreadyHeld` are different claims about who added it.
  const rows = newlyHeldToRecord(
    [{ candidate: candidate(4), reason: 'alreadyPushed' }],
    new Set()
  );
  assert.deepEqual(rows, [], 'a series we pushed must not be downgraded to "you already had it"');
});

// --- orphans ----------------------------------------------------------------

test('a series held for an entry that now resolves elsewhere is an orphan', () => {
  // Correct an identity after we added the wrong series and Sonarr keeps the
  // wrong one while we add the right one. We have no delete verb, so this is
  // the one thing here that has to be handed to a human.
  const rows = [prior(10, 'pushed')];               // anilistId 100 -> tvdb 10
  const orphans = findOrphans(rows, new Map([[100, 99]]), new Set([10]));
  assert.deepEqual(
    orphans.map((o) => [o.tvdbId, o.nowTvdbId]),
    [[10, 99]],
    'the held series and what its entry resolves to now must both be named'
  );
});

test('a series whose identity still agrees is not an orphan', () => {
  const orphans = findOrphans([prior(11, 'pushed')], new Map([[110, 11]]), new Set([11]));
  assert.deepEqual(orphans, []);
});

test('a re-identified series Sonarr no longer holds is not an orphan', () => {
  // Nothing to delete, so reporting it would ask someone to act on nothing.
  const orphans = findOrphans([prior(12, 'pushed')], new Map([[120, 99]]), new Set());
  assert.deepEqual(orphans, [], 'only a series still held can need deleting');
});

test('a row with no AniList id cannot be judged an orphan', () => {
  const row = { ...prior(13, 'pushed'), anilistId: null };
  assert.deepEqual(findOrphans([row], new Map([[130, 99]]), new Set([13])), []);
});

// --- reading Sonarr's refusals ---------------------------------------------

test('Sonarr saying the series has already been added is not a failure', () => {
  // Recording this as `failed` would leave it retryable, and it would be retried
  // on every run forever - the re-add loop rebuilt in a new place.
  const kind = classifyAddError({
    status: 400,
    body: [{ errorMessage: 'This series has already been added', propertyName: 'TvdbId' }],
  });
  assert.equal(kind, 'alreadyExists');
});

test('a different 400 is invalid rather than retryable, because the same body will fail again', () => {
  const kind = classifyAddError({
    status: 400,
    body: [{ errorMessage: 'Root folder path does not exist', propertyName: 'RootFolderPath' }],
  });
  assert.equal(kind, 'invalid');
});

test('a 500 from Sonarr is retryable', () => {
  assert.equal(classifyAddError({ status: 500, body: undefined }), 'retryable');
});

test('a transport failure with no status at all is retryable', () => {
  // A connection reset or timeout never reached Sonarr, so nothing was added.
  assert.equal(classifyAddError({}), 'retryable');
});
