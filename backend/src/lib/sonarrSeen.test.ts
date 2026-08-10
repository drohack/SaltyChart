import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  reconcileSeen,
  suppressedTvdbIds,
  type SeenRow,
  type HeldSeries,
  type ReconcileInput,
} from './sonarrSeen';

// Assertion messages are written as stories on purpose: they become the
// `expect` substrings mutation_audit.py matches on.

const NOW = new Date('2026-08-08T12:00:00Z');
const EARLIER = new Date('2026-08-01T12:00:00Z');
const TAG = 7;

function held(tvdbId: number, title = `Show ${tvdbId}`, tags: number[] = []): HeldSeries {
  return { tvdbId, title, tags };
}

function row(over: Partial<SeenRow> & { tvdbId: number }): SeenRow {
  return {
    anilistId: over.tvdbId * 10,
    title: `Show ${over.tvdbId}`,
    firstHeldAt: EARLIER,
    lastHeldAt: EARLIER,
    goneAt: null,
    taggedByUs: true,
    ...over,
  };
}

function input(over: Partial<ReconcileInput>): ReconcileInput {
  return {
    prior: [],
    snapshot: { ok: true, series: [held(100)] },
    proposed: new Map([[100, 1000]]),
    currentIdentity: new Map(),
    tagId: TAG,
    now: NOW,
    ...over,
  };
}

test('a proposed series Sonarr holds is recorded, with our tag noted', () => {
  const r = reconcileSeen(
    input({ snapshot: { ok: true, series: [held(100, 'Show 100', [TAG])] } })
  );
  assert.equal(r.skipped, null);
  assert.equal(r.upserts.length, 1, 'the held proposal must be recorded');
  assert.equal(r.upserts[0].firstHeldAt?.getTime(), NOW.getTime(), 'first sighting stamps firstHeldAt');
  assert.equal(r.upserts[0].goneAt, null, 'a held series is not suppressed');
  assert.equal(r.upserts[0].taggedByUs, true, 'our import-list tag is recorded for Maintainerr scoping');
  assert.deepEqual(r.suppressed, [], 'nothing is suppressed when everything is still held');
});

test('a series we saw held that Sonarr no longer holds is suppressed', () => {
  // The whole point of the feature: nobody deletes by accident, so an observed
  // deletion stops us proposing it. Without this the list re-proposes it and
  // Sonarr re-grabs it every sync, forever.
  const r = reconcileSeen(
    input({
      prior: [row({ tvdbId: 200 })],
      snapshot: { ok: true, series: [held(100)] },
      proposed: new Map([[100, 1000]]),
    })
  );
  assert.deepEqual(r.suppressed, [200], 'a deleted series must be suppressed so it is not re-added forever');
  const gone = r.upserts.find((u) => u.tvdbId === 200);
  assert.ok(gone?.goneAt, 'goneAt is the suppression and must be stamped');
});

test('a FAILED snapshot changes nothing at all', () => {
  // "Could not ask" is not "everything was deleted". Acting on a failed read
  // would suppress the whole list the first time Sonarr restarted.
  const r = reconcileSeen(
    input({
      prior: [row({ tvdbId: 200 }), row({ tvdbId: 300 })],
      snapshot: { ok: false, series: [], error: 'ECONNREFUSED' },
    })
  );
  assert.deepEqual(r.upserts, [], 'a failed snapshot must not write a single row');
  assert.deepEqual(r.suppressed, [], 'a failed snapshot must never suppress anything');
  assert.match(String(r.skipped), /snapshot failed/, 'the run says why it did nothing');
});

test('a failed snapshot is ignored even when it carries series', () => {
  // A partial read is still a read we cannot trust. Without this case the
  // `ok` check could be deleted and every test would still pass, because a
  // failed fetch also happens to return an empty list - two guards, one of
  // them accidentally covering for the other.
  const r = reconcileSeen(
    input({
      prior: [row({ tvdbId: 200 })],
      snapshot: { ok: false, series: [held(100)], error: 'partial read' },
    })
  );
  assert.deepEqual(r.suppressed, [], 'a failed snapshot must never suppress anything, even a partial one');
  assert.deepEqual(r.upserts, [], 'and it must not write a row either');
});

test('an EMPTY library is treated as a failure, never as mass deletion', () => {
  // The most dangerous line in the feature. One bad read would otherwise
  // suppress every series permanently, and it would look exactly like "the
  // list correctly has nothing to add". A genuinely empty Sonarr costs
  // nothing: there would be no prior held rows to suppress either.
  const r = reconcileSeen(
    input({
      prior: [row({ tvdbId: 200 }), row({ tvdbId: 300 }), row({ tvdbId: 400 })],
      snapshot: { ok: true, series: [] },
    })
  );
  assert.deepEqual(r.suppressed, [], 'an empty library must never suppress anything');
  assert.deepEqual(r.upserts, [], 'an empty library must not write a single row');
  assert.match(String(r.skipped), /empty library/, 'the run says it refused to trust an empty read');
});

test('a series that comes back is un-suppressed', () => {
  const r = reconcileSeen(
    input({
      prior: [row({ tvdbId: 100, goneAt: EARLIER })],
      snapshot: { ok: true, series: [held(100)] },
      proposed: new Map([[100, 1000]]),
    })
  );
  assert.equal(r.upserts[0].goneAt, null, 're-adding a series by hand must clear its suppression');
  assert.equal(
    r.upserts[0].firstHeldAt?.getTime(),
    EARLIER.getTime(),
    'the original first-held date survives a round trip'
  );
});

test('an already-suppressed series is not reported as newly suppressed again', () => {
  const r = reconcileSeen(
    input({
      prior: [row({ tvdbId: 200, goneAt: EARLIER })],
      snapshot: { ok: true, series: [held(100)] },
    })
  );
  assert.deepEqual(r.suppressed, [], 'a suppression is announced once, not on every run');
});

test('suppression keys on having been held, not on carrying our tag', () => {
  // If the tag were the trigger, deleting a show you had added BY HAND would
  // let us re-acquire it: we propose it, Sonarr adds it, and only then is it
  // tagged. It would be silently back without anyone asking for it.
  const r = reconcileSeen(
    input({
      prior: [row({ tvdbId: 200, taggedByUs: false })],
      snapshot: { ok: true, series: [held(100)] },
    })
  );
  assert.deepEqual(r.suppressed, [200], 'an untagged series we proposed and saw held is still suppressed when deleted');
});

test('a never-held row is not suppressed when absent', () => {
  const r = reconcileSeen(
    input({
      prior: [row({ tvdbId: 200, firstHeldAt: null, lastHeldAt: null })],
      snapshot: { ok: true, series: [held(100)] },
    })
  );
  assert.deepEqual(r.suppressed, [], 'a series we never saw held cannot have been deleted');
});

test('a re-identified entry leaves the old series as a reported orphan', () => {
  // Sonarr keeps the wrong show (nothing on our side removes it) and grabs the
  // corrected one on the next sync, so the library ends up holding both. We
  // cannot delete it - that needs write credentials we deliberately do not
  // take - so it is reported for a human.
  const r = reconcileSeen(
    input({
      prior: [row({ tvdbId: 200, anilistId: 555 })],
      snapshot: { ok: true, series: [held(100), held(200, 'Wrong Show')] },
      proposed: new Map([[100, 1000]]),
      currentIdentity: new Map([[555, 999]]),
    })
  );
  assert.equal(r.orphans.length, 1, 'a corrected identity must surface the series Sonarr still holds');
  assert.equal(r.orphans[0].tvdbId, 200, 'the orphan names the series to delete');
  assert.equal(r.orphans[0].nowTvdbId, 999, 'and what the entry resolves to now');
});

test('an unchanged identity is not an orphan, and a deleted one is not either', () => {
  const same = reconcileSeen(
    input({
      prior: [row({ tvdbId: 200, anilistId: 555 })],
      snapshot: { ok: true, series: [held(200)] },
      currentIdentity: new Map([[555, 200]]),
    })
  );
  assert.deepEqual(same.orphans, [], 'an identity that still resolves the same way is not an orphan');

  const absent = reconcileSeen(
    input({
      prior: [row({ tvdbId: 200, anilistId: 555 })],
      snapshot: { ok: true, series: [held(100)] },
      currentIdentity: new Map([[555, 999]]),
    })
  );
  assert.deepEqual(absent.orphans, [], 'a series Sonarr no longer holds needs no deletion');
});

test('suppressedTvdbIds reports the gone rows, and force-include beats them', () => {
  const rows = [row({ tvdbId: 100, goneAt: NOW }), row({ tvdbId: 200, goneAt: NOW }), row({ tvdbId: 300 })];
  assert.deepEqual(
    [...suppressedTvdbIds(rows, new Set())].sort((a, b) => a - b),
    [100, 200],
    'only rows carrying goneAt are suppressed'
  );
  assert.deepEqual(
    [...suppressedTvdbIds(rows, new Set([100]))],
    [200],
    'a force-include is how a suppression is undone, so it must win'
  );
});
