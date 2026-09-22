import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  __setOverridesForTest,
  resolveIdentity,
  needsRemoteLookup,
  needsRegrade,
  isDateVerified,
  matchGrade,
  dateSettlesCandidates,
  isIdConfident,
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
 *     the community map permanently - Fribb adding the pair next week could
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
    'the map must win over an id-less bookkeeping row - otherwise a pair added ' +
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
    'a failed search must not retire an entry - TMDB gains records as a show ' +
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
  assert.equal(needsRemoteLookup(777), true, 'nothing known - look it up');
});

/**
 * `mergeIdentityPatch` exists because Confirm used to destroy the very evidence
 * the review page renders: the PUT handler passed only what the button sent, so
 * `setIdentityOverride` defaulted `source` back to 'manual' and nulled `note`
 * and `candidates` - one click relabelled a resolver id as a human decision and
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
  // suggestion exactly as it was - Echo kept offering its 2023 namesake until
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
    'a current row must NOT recycle - that is what makes the pass self-terminating');

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
  // correct matches land 0-31 days from the AniList premiere and wrong ones
  // 62-21,929 - nothing in between. So a resolver row accepted on a date is
  // as settled as a community-map id, and the viewer's correction picker is
  // hidden for it; 105 of 166 uncertain-looking 2026 rows are this case.
  assert.equal(isDateVerified('remote: air date 0d'), true);
  assert.equal(isDateVerified('remote: premiere date 3d'), true);
  assert.equal(isDateVerified('remote: tvdb season premiere 1d'), true);

  // Text and year are NOT dates. An exact title dated 1,012 days off is the
  // Echo class, and a +/-1 production year is nearly free for an unrelated
  // sibling - both must stay correctable by a viewer.
  assert.equal(isDateVerified('remote: exact title'), false);
  assert.equal(isDateVerified('remote: release year 0'), false);
  assert.equal(isDateVerified('remote: unverified'), false);
  assert.equal(isDateVerified('remote: no match'), false);
  assert.equal(isDateVerified(null), false);
  assert.equal(isDateVerified(''), false);
});

/**
 * The grade ladder, one case per rung.
 *
 * These messages are the `expect` substrings a mutation row matches, and the
 * distinctions are not cosmetic: this one function now decides both whether the
 * viewer's correction picker appears and whether the Sonarr page will let an
 * override through without asking.
 */
function ident(over: Partial<Identity>): Identity {
  return {
    tvdbId: '123',
    tmdbId: null,
    tmdbKind: null,
    source: 'map',
    confirmed: false,
    rejected: false,
    pending: false,
    matchedTitle: null,
    candidates: null,
    note: null,
    year: null,
    resolverVersion: null,
    ...over,
  };
}

test('a community-map id is confident even though it is unconfirmed', () => {
  // Map rows are unconfirmed by construction. Requiring confirmation would
  // throw away the ~94% of TV the map answers.
  const g = ident({ source: 'map' });
  assert.equal(matchGrade(g), 'map', 'a community-map row grades as map');
  assert.equal(isIdConfident(g), true, 'an unconfirmed map id is still something we know');
});

test('an admin override is confident but a viewer pick is NOT', () => {
  // Counting a viewer pick as settled hid the correction picker - and the undo
  // living inside it - the instant anyone used it.
  const admin = ident({ source: 'manual', note: 'set by hand' });
  const viewer = ident({ source: 'manual', note: 'viewer: picked by bob' });
  assert.equal(matchGrade(admin), 'adminOverride', 'a hand-written override is an admin decision');
  assert.equal(isIdConfident(admin), true, 'an admin decision is settled');
  assert.equal(matchGrade(viewer), 'viewerPick', 'a viewer pick grades as its own thing');
  assert.equal(
    isIdConfident(viewer),
    false,
    'a viewer pick is unconfirmed by construction and must never count as settled'
  );
});

test('a resolver id is confident only when a DATE vouched for it', () => {
  // Correct results land 0-31 days from the AniList premiere and wrong ones
  // 62-21,929, with nothing in between. Title text and a +/-1 year are the
  // Echo class - an exact title 1,012 days away.
  const dated = ident({ source: 'remote', note: 'remote: air date 3d' });
  const weak = ident({ source: 'remote', note: 'remote: exact title' });
  assert.equal(matchGrade(dated), 'dateVerified', 'a date rung grades as verified');
  assert.equal(isIdConfident(dated), true, 'a date-verified resolver id is as settled as a map id');
  assert.equal(matchGrade(weak), 'weak', 'an exact-title accept is a weak rung');
  assert.equal(
    isIdConfident(weak),
    false,
    'a resolver id accepted on title or year alone is not something we know'
  );
});

test('a human confirmation outranks everything, and a rejection counts as knowledge', () => {
  assert.equal(matchGrade(ident({ confirmed: true, source: 'remote' })), 'confirmed',
    'confirmed wins over the source it came from');
  // "Definitively not in the library" is knowledge too, and it must suppress
  // the title fallback rather than invite a correction.
  assert.equal(isIdConfident(ident({ rejected: true, source: 'none', tvdbId: null })), true,
    'a rejection is a real answer, not an absence of one');
  assert.equal(matchGrade(ident({ source: 'none', tvdbId: null })), 'none',
    'no id at all grades as none');
  assert.equal(isIdConfident(ident({ source: 'none', tvdbId: null })), false,
    'knowing nothing is not confidence');
});


const DAY = 86_400_000;
const ENTRY = Date.UTC(2026, 9, 4);
const c = (tvdbId: string | null, premiereDate: string | null, tmdbId: string | null = null) =>
  ({ tvdbId, tmdbId, premiereDate });

test('the date settles a row only when it separates the candidates', () => {
  // The whole point: one candidate on the entry's day, the other refuted by
  // years. 142 of 170 premiere-date-rung multi-candidate rows look like this,
  // and every one was a Confirm click on a match nothing disputed.
  assert.equal(
    dateSettlesCandidates([c('1', '2026-10-04'), c('2', '2019-01-05')], ENTRY, { tvdbId: '1' }),
    true,
  );
});

test('two candidates inside tolerance are exactly the review worth having', () => {
  // The date failed to discriminate - 21 stored rows are in this state. Settling
  // them would be choosing by search-result order, which is what the air-date
  // evidence exists to stop doing.
  assert.equal(
    dateSettlesCandidates([c('1', '2026-10-04'), c('2', '2026-10-11')], ENTRY, { tvdbId: '1' }),
    false,
  );
});

test('an undated sibling settles nothing - the Cyborg 009: Nemesis shape', () => {
  // That series exists TWICE in TVDB with one copy undated, and nothing proves
  // the two are the same show - which is why mergeCrossReferencedCandidates
  // refuses to merge them. Settling the row here would undo that by a side door.
  // "We do not know when it aired" is not evidence against it.
  assert.equal(
    dateSettlesCandidates([c('1', '2026-10-04'), c('2', null)], ENTRY, { tvdbId: '1' }),
    false,
  );
});

test('a stored pick the date REFUTES is never settled, however clean the separation', () => {
  // 1 of the 146 otherwise-separable rows stored a refuted candidate. Without
  // this check the rule would pin a match its own evidence disagrees with -
  // and it would look settled, which is worse than looking unverified.
  assert.equal(
    dateSettlesCandidates([c('1', '2026-10-04'), c('2', '2019-01-05')], ENTRY, { tvdbId: '2' }),
    false,
  );
});

test('the Echo shape stays queued, because nothing lands inside tolerance', () => {
  // Echo premiered 2026-07-19; its candidates are all titled "Echo" and are
  // three different films, the nearest 46 days away. The queue rule exists for
  // this row and must keep working - asserted, not assumed.
  assert.equal(
    dateSettlesCandidates(
      [c('1', '2026-09-03'), c('2', '2023-10-13'), c('3', '2021-05-02')],
      Date.UTC(2026, 6, 19), { tvdbId: '1' }),
    false,
  );
});

test('the season-premiere rung is left alone by construction', () => {
  // Its evidence is the SEASON date, which lives nowhere in a candidate's own
  // premiereDate - so no candidate reads as inside and the row stays queued.
  // Deliberate: that rung was never measured for this rule.
  assert.equal(
    dateSettlesCandidates([c('1', '2019-01-05'), c('2', '2016-04-02')], ENTRY, { tvdbId: '1' }),
    false,
  );
});

test('tolerance is the 31-day gap, not a rounder number', () => {
  const inside = new Date(ENTRY + 31 * DAY).toISOString().slice(0, 10);
  const outside = new Date(ENTRY + 32 * DAY).toISOString().slice(0, 10);
  assert.equal(dateSettlesCandidates([c('1', inside), c('2', '2019-01-05')], ENTRY, { tvdbId: '1' }), true);
  assert.equal(dateSettlesCandidates([c('1', outside), c('2', '2019-01-05')], ENTRY, { tvdbId: '1' }), false);
});

test('a single candidate and a dateless entry are outside this rule', () => {
  assert.equal(dateSettlesCandidates([c('1', '2026-10-04')], ENTRY, { tvdbId: '1' }), false);
  assert.equal(dateSettlesCandidates([c('1', '2026-10-04'), c('2', '2019-01-05')], null, { tvdbId: '1' }), false);
  assert.equal(dateSettlesCandidates(null, ENTRY, { tvdbId: '1' }), false);
});

test('the pick may be identified by its TMDB id alone', () => {
  // Roughly half of every search's results are TMDB-only, so requiring a TVDB
  // id to recognise the stored pick would silently exclude them.
  assert.equal(
    dateSettlesCandidates(
      [c(null, '2026-10-04', '55'), c(null, '2019-01-05', '66')], ENTRY, { tmdbId: '55' }),
    true,
  );
});

// ---------------------------------------------------------------------------
// Corroboration: a resolver id the community map independently carries.
//
// 2026-09-22, found by the deploy gate. `Battle Spirits [Re] ZEKKAI NO KU`
// reached the Sonarr auto-add list graded `weak`. Its candidate had no premiere
// date and no year, so the resolver accepted it on `exact title` - a rung no
// date vouches for - while the community map independently carried the SAME
// tvdbId. The sharp version of the bug: had the resolver row not existed at
// all, `resolveIdentity` would have fallen through to the map and graded it
// `map`, a verified candidate. Looking the entry up made it look WORSE than
// never having looked, which cannot be right.
//
// Measured over all 1520 stored rows that day: 42 shadow a map answer, 41 of
// them naming the map's own id, and exactly one of those graded weak.
// ---------------------------------------------------------------------------

test('a resolver id the community map independently carries is not weak', () => {
  __setMapsForTest({ '187990': '475488' }, {});
  __setOverridesForTest({
    187990: { tvdbId: '475488', tmdbId: '316551', tmdbKind: 'tv', source: 'remote',
              confirmed: false, rejected: false, pending: false,
              matchedTitle: 'Battle Spirits [Re] ZEKKAI NO KU',
              candidates: null, note: 'remote: exact title', year: null },
  });
  const id = resolveIdentity(187990);
  assert.equal(matchGrade(id), 'map',
    'two independent sources naming one id is stronger evidence than either alone');
  assert.equal(isIdConfident(id), true,
    'a corroborated id must not offer the correction picker as though it were doubtful');
});

test('corroboration means the SAME id, not merely that the map has an entry', () => {
  // The real instance is IGPX (AniList 3270): the map carries tvdb 80391, which
  // skyhook no longer resolves at all, while the resolver found 73011 -
  // 'IGPX: Immortal Grand Prix', first aired 2005-10-05, a day from the entry's
  // own premiere. Correcting the map is what the override table is FOR, so a
  // contradicted id must stay weak and keep its place in the review queue. The
  // date rung is omitted here so the check under test is the only thing acting.
  __setMapsForTest({ '3270': '80391' }, {});
  __setOverridesForTest({
    3270: { tvdbId: '73011', tmdbId: null, tmdbKind: null, source: 'remote',
            confirmed: false, rejected: false, pending: false,
            matchedTitle: 'IGPX: Immortal Grand Prix',
            candidates: null, note: 'remote: exact title', year: null },
  });
  const id = resolveIdentity(3270);
  assert.equal(matchGrade(id), 'weak',
    'an id the map CONTRADICTS is disputed, not corroborated');
});
