import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __setOverridesForTest, resolveIdentity, needsRemoteLookup } from './seriesIdentity';
import { __setMapsForTest } from './anilistTvdbMap';

/**
 * These two guard the *auto* in auto-scanning.
 *
 * The resolver records a row when a search finds nothing, so it doesn't re-ask
 * the same dead end every day. That bookkeeping row broke both halves of "check
 * again later":
 *
 *   - `resolveIdentity` returned any override first, so an empty row shadowed
 *     the community map permanently — Fribb adding the pair next week could
 *     never take effect.
 *   - the sweep skipped anything with an identity row, so a single failed search
 *     retired the entry forever and the retry schedule below it was unreachable.
 *
 * Both are invisible in normal use: everything looks fine, it just silently
 * stops improving.
 */

test('a recorded miss does not shadow the community map', () => {
  __setMapsForTest({ '111': '74796' }, {});
  // The resolver looked, found nothing, and wrote bookkeeping.
  __setOverridesForTest({
    111: { tvdbId: null, tmdbId: null, tmdbKind: null, source: 'remote',
           confirmed: false, rejected: false, pending: true,
           matchedTitle: null, candidates: null, note: 'remote: no match' },
  });
  const id = resolveIdentity(111);
  assert.equal(id.tvdbId, '74796',
    'the map must win over an id-less bookkeeping row — otherwise a pair added ' +
    'upstream can never take effect');
  assert.equal(id.source, 'map');
});

test('a human decision DOES win over the map', () => {
  __setMapsForTest({ '222': '99999' }, {});
  __setOverridesForTest({
    222: { tvdbId: null, tmdbId: null, tmdbKind: null, source: 'manual',
           confirmed: true, rejected: true, pending: false,
           matchedTitle: null, candidates: null, note: 'rejected' },
  });
  const id = resolveIdentity(222);
  assert.equal(id.rejected, true, 'an explicit rejection is an answer, not bookkeeping');
  assert.equal(id.tvdbId, null);
});

test('the sweep re-examines an entry it previously failed on', () => {
  __setMapsForTest({}, {});
  __setOverridesForTest({
    333: { tvdbId: null, tmdbId: null, tmdbKind: null, source: 'remote',
           confirmed: false, rejected: false, pending: true,
           matchedTitle: null, candidates: null, note: 'remote: no match' },
  });
  assert.equal(needsRemoteLookup(333), true,
    'a failed search must not retire an entry — TMDB gains records as a show ' +
    'approaches airing, which is exactly when re-checking matters');
});

test('the sweep leaves settled entries alone', () => {
  __setMapsForTest({ '555': '12345' }, {});
  __setOverridesForTest({
    444: { tvdbId: '777', tmdbId: null, tmdbKind: null, source: 'remote',
           confirmed: false, rejected: false, pending: true,
           matchedTitle: 'Something', candidates: null, note: null },
    666: { tvdbId: null, tmdbId: null, tmdbKind: null, source: 'manual',
           confirmed: true, rejected: true, pending: false,
           matchedTitle: null, candidates: null, note: 'rejected' },
  });
  assert.equal(needsRemoteLookup(444), false, 'already has an id');
  assert.equal(needsRemoteLookup(555), false, 'the map already knows it');
  assert.equal(needsRemoteLookup(666), false, 'a human said no');
  assert.equal(needsRemoteLookup(777), true, 'nothing known — look it up');
});
