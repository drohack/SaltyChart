import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  __setOverridesForTest,
  resolveIdentity,
  needsRemoteLookup,
  needsRegrade,
  isDateVerified,
  RESOLVER_VERSION,
  mergeIdentityPatch,
  type Identity,
} from './seriesIdentity';
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
           matchedTitle: null, candidates: null, note: 'remote: no match', year: null },
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
           matchedTitle: null, candidates: null, note: 'rejected', year: null },
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
           matchedTitle: null, candidates: null, note: 'remote: no match', year: null },
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
           matchedTitle: 'Something', candidates: null, note: null, year: null },
    666: { tvdbId: null, tmdbId: null, tmdbKind: null, source: 'manual',
           confirmed: true, rejected: true, pending: false,
           matchedTitle: null, candidates: null, note: 'rejected', year: null },
  });
  assert.equal(needsRemoteLookup(444), false, 'already has an id');
  assert.equal(needsRemoteLookup(555), false, 'the map already knows it');
  assert.equal(needsRemoteLookup(666), false, 'a human said no');
  assert.equal(needsRemoteLookup(777), true, 'nothing known — look it up');
});

/**
 * `mergeIdentityPatch` exists because Confirm used to destroy the very evidence
 * the review page renders: the PUT handler passed only what the button sent, so
 * `setIdentityOverride` defaulted `source` back to 'manual' and nulled `note`
 * and `candidates` — one click relabelled a resolver id as a human decision and
 * erased which rung of the ladder accepted it. Absent means "keep what's
 * stored"; an explicit value (including null) means "change it".
 */

const remoteRow: Identity = {
  tvdbId: '111', tmdbId: null, tmdbKind: null, source: 'remote',
  confirmed: false, rejected: false, pending: false,
  matchedTitle: 'Thunderbolt Fantasy',
  candidates: [{ tvdbId: '111', tmdbId: null, tmdbKind: null,
                 matchedTitle: 'Thunderbolt Fantasy', exact: true, year: 2016 }],
  note: 'remote: exact title',
  year: 2016,
};

test('Confirm must not wipe provenance', () => {
  const merged = mergeIdentityPatch(remoteRow, {
    anilistId: 1, tvdbId: '111', confirmed: true, pending: false,
  });
  assert.equal(merged.source, 'remote',
    'confirming a resolver suggestion must keep it labelled as ours, not relabel it manual');
  assert.equal(merged.note, 'remote: exact title', 'the acceptance-rung note must survive');
  assert.equal(merged.matchedTitle, 'Thunderbolt Fantasy');
  assert.equal(merged.candidates?.length, 1, 'the candidate list must survive a confirm');
  assert.equal(merged.year, 2016, 'the display year must survive a confirm');
  assert.equal(merged.confirmed, true);
});

test('an explicit field in the patch wins over the stored row', () => {
  const merged = mergeIdentityPatch(remoteRow, {
    anilistId: 1, tvdbId: '222', confirmed: true, note: null, source: 'manual',
  });
  assert.equal(merged.note, null, 'explicit null means clear, not keep');
  assert.equal(merged.source, 'manual');
  assert.equal(merged.tvdbId, '222');
});

test('a rejection keeps the note recording what was rejected', () => {
  const merged = mergeIdentityPatch(remoteRow, {
    anilistId: 1, tvdbId: null, tmdbId: null, confirmed: true, rejected: true,
  });
  assert.equal(merged.rejected, true);
  assert.equal(merged.note, 'remote: exact title');
  assert.equal(merged.tvdbId, null, 'explicit null id must not be resurrected from the old row');
});

test('with no stored row a patch behaves like a plain write', () => {
  const merged = mergeIdentityPatch(null, { anilistId: 1, tvdbId: '333', confirmed: true });
  assert.equal(merged.source ?? 'manual', 'manual');
  assert.equal(merged.note ?? null, null);
  assert.equal(merged.candidates ?? null, null);
});


test('needsRegrade: a ladder change reaches stored rows, but never human ones', () => {
  // The self-healing half of a matcher improvement. The sweep skips any entry
  // that already carries an id (needsRemoteLookup is false for it), so before
  // this a better ladder or ranking fixed only NEW lookups and left every old
  // suggestion exactly as it was — Echo kept offering its 2023 namesake until
  // its row was deleted by hand. A stamped version is what makes "re-ask about
  // everything decided by an older resolver" expressible, and self-terminating.
  const stale = { source: 'remote' as const, confirmed: false, rejected: false,
                  tvdbId: '123', tmdbId: null, resolverVersion: RESOLVER_VERSION - 1 };

  assert.equal(needsRegrade(stale), true, 'a row from an older resolver must be re-asked');
  assert.equal(
    needsRegrade({ ...stale, resolverVersion: null }), true,
    'a row stamped before versioning existed is stale by definition');
  assert.equal(
    needsRegrade({ ...stale, resolverVersion: RESOLVER_VERSION }), false,
    'a current row must NOT recycle — that is what makes the pass self-terminating');

  // Human decisions are permanent; re-grading one would overwrite the answer a
  // person gave with a machine's guess.
  assert.equal(needsRegrade({ ...stale, confirmed: true }), false, 'a confirmed row is settled');
  assert.equal(needsRegrade({ ...stale, rejected: true }), false, 'a rejection is settled');
  assert.equal(needsRegrade({ ...stale, source: 'manual' }), false, 'a manual row is settled');

  // An id-less bookkeeping row ("we looked, found nothing") is already re-asked
  // by the main sweep on its retry tier; regrading it too would spend the
  // budget twice on the same entry.
  assert.equal(
    needsRegrade({ ...stale, tvdbId: null, tmdbId: null }), false,
    'a row with no ids belongs to the main sweep, not the regrade pass');
});


test('isDateVerified: only a DATE vouches for a resolver id', () => {
  // The strongest evidence this system has. Measured across the corpus,
  // correct matches land 0–31 days from the AniList premiere and wrong ones
  // 62–21,929 — nothing in between. So a resolver row accepted on a date is
  // as settled as a community-map id, and the viewer's correction picker is
  // hidden for it; 105 of 166 uncertain-looking 2026 rows are this case.
  assert.equal(isDateVerified('remote: air date 0d'), true);
  assert.equal(isDateVerified('remote: premiere date 3d'), true);
  assert.equal(isDateVerified('remote: tvdb season premiere 1d'), true);

  // Text and year are NOT dates. An exact title dated 1,012 days off is the
  // Echo class, and a ±1 production year is nearly free for an unrelated
  // sibling — both must stay correctable by a viewer.
  assert.equal(isDateVerified('remote: exact title'), false);
  assert.equal(isDateVerified('remote: release year 0'), false);
  assert.equal(isDateVerified('remote: unverified'), false);
  assert.equal(isDateVerified('remote: no match'), false);
  assert.equal(isDateVerified(null), false);
  assert.equal(isDateVerified(''), false);
});
