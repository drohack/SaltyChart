import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  titleRelated,
  seasonPremiereDelta,
  hasUndatedFutureSeason,
  skyhookSearch,
  skyhookEpisodes,
  __setSkyhookFetchForTest,
  __clearSkyhookCachesForTest,
  type SkyhookEpisode,
} from './skyhookIdentity';

const DAY = 24 * 60 * 60 * 1000;

/**
 * Every fixture here is a pair the measurement actually produced. The two
 * guards exist because the first pass of that measurement got them wrong:
 * it "verified" Natsume S7 against Lego Friends (any weekly series has SOME
 * episode within days of any date) and related "Re:Born" to a base title that
 * had collapsed to "Re".
 */

test('titleRelated: a collapsed base must not relate - the Re:Born case', () => {
  // base_title("Re:Zero kara Hajimeru ...") strips at the colon and leaves
  // "Re". Without a length floor that prefix-relates to every Re-titled work.
  assert.equal(titleRelated('Re:Born', ['Re']), false,
    'a 2-char base must never relate - "Re" matched Re:Born in the measurement');
  assert.equal(titleRelated('Reborn!', ['Re']), false);
});

test('titleRelated: exact and meaningful prefix relations hold', () => {
  assert.equal(titleRelated('Ranma ½ (2024)', ['Ranma1/2 (2024) Season 3', 'Ranma1/2 (2024)']), true,
    'unicode fraction vs slash must normalise equal');
  // The Frieren miss: the entry only carried romaji, TVDB answers in English.
  // Searching every title form is the fix - related() itself just has to hold
  // for whichever form matches.
  assert.equal(titleRelated("Frieren: Beyond Journey's End", ["Frieren: Beyond Journey's End Season 3", 'Sousou no Frieren']), true);
  assert.equal(titleRelated('Punirunes', ['Punirunes Puni 2', 'Punirunes Puni']), true,
    'candidate may be the shorter side of the prefix relation');
  assert.equal(titleRelated('Lego Friends: The Next Chapter', ["Natsume's Book of Friends"]), false,
    'sharing one word is not a relation');
});

const ep = (s: number, e: number, air: string | null): SkyhookEpisode =>
  ({ seasonNumber: s, episodeNumber: e, airDate: air });

test('seasonPremiereDelta: only a season premiere may verify - the weekly confound', () => {
  const prem = Date.UTC(2025, 9, 5); // 2025-10-05
  // A long-running weekly series: some mid-run episode is ALWAYS within days
  // of any seasonal premiere. That episode must not count.
  const weekly = [ep(3, 11, '2025-09-28'), ep(3, 12, '2025-10-05'), ep(3, 13, '2025-10-12')];
  assert.equal(seasonPremiereDelta(weekly, prem), null,
    'a mid-run weekly episode 0d away must not verify - it verified Lego Friends once');
  // Ranma ½ (2024) S3E1 on the entry premiere: the real rescue.
  const ranma = [ep(1, 1, '2024-10-06'), ep(2, 1, '2025-10-04'), ep(3, 1, '2025-10-05'), ep(3, 2, '2025-10-12')];
  assert.equal(seasonPremiereDelta(ranma, prem), 0);
  // Season 0 specials ship near premieres and must not compete.
  assert.equal(seasonPremiereDelta([ep(0, 1, '2025-10-05')], prem), null);
  assert.equal(seasonPremiereDelta([ep(2, 1, null)], prem), null, 'undated premieres read as no evidence');
  assert.equal(seasonPremiereDelta([], prem), null);
  assert.equal(seasonPremiereDelta(ranma, null), null, 'no entry date, no evidence');
});

test('hasUndatedFutureSeason: the Frieren-S3 shape', () => {
  // TVDB lists season 3 but has not dated it - the signal that a held-library
  // rejection is premature.
  const frieren = [ep(1, 1, '2023-09-29'), ep(2, 1, '2026-01-09'), ep(2, 10, '2026-03-27'), ep(3, 1, null)];
  assert.equal(hasUndatedFutureSeason(frieren), true);
  // A continuing series whose seasons are all dated (One Piece) is NOT that -
  // its rejections were correct and must stay rejections.
  const onepiece = [ep(21, 190, '2024-08-01'), ep(22, 37, '2024-10-20')];
  assert.equal(hasUndatedFutureSeason(onepiece), false);
  assert.equal(hasUndatedFutureSeason([]), false);
  // An undated season BEHIND the newest dated one (TVDB gaps happen) is not
  // a future season.
  const gap = [ep(1, 1, null), ep(2, 1, '2025-01-10')];
  assert.equal(hasUndatedFutureSeason(gap), false);
});

test('the client degrades to empty on anything, and memoises episodes', async () => {
  let calls = 0;
  __setSkyhookFetchForTest(async (url: string) => {
    calls++;
    if (url.includes('/search/')) return [{ tvdbId: 451479, title: 'Ranma ½ (2024)', firstAired: '2024-10-06' }];
    return { episodes: [{ seasonNumber: 3, episodeNumber: 1, airDate: '2025-10-05' }] };
  });
  __clearSkyhookCachesForTest();
  try {
    const found = await skyhookSearch('Ranma');
    assert.equal(found[0]?.tvdbId, '451479', 'numeric ids from the wire become strings');
    assert.equal(found[0]?.firstAired, '2024-10-06');
    const eps1 = await skyhookEpisodes('451479');
    const eps2 = await skyhookEpisodes('451479');
    assert.equal(eps1[0]?.seasonNumber, 3);
    assert.equal(calls, 2, 'the second episodes call must come from the memo');
    assert.deepEqual(eps2, eps1);

    __setSkyhookFetchForTest(async () => { throw new Error('down'); });
    __clearSkyhookCachesForTest();
    assert.deepEqual(await skyhookSearch('anything'), [], 'a dead service reads as no results, never a throw');
    assert.deepEqual(await skyhookEpisodes('1'), []);
    __setSkyhookFetchForTest(async () => 'not json shaped');
    __clearSkyhookCachesForTest();
    assert.deepEqual(await skyhookSearch('anything'), [], 'a malformed body reads as no results');
  } finally {
    __setSkyhookFetchForTest(null);
    __clearSkyhookCachesForTest();
  }
});
