import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  verdictFor,
  pickCandidate,
  premiereDelta,
  premiereOf,
  baseTitles,
  parseSweepStatus,
  parseLookupTerm,
  completeIdentityIds,
  retryAfterFor,
  retryStateFor,
  planSweep,
  mergeCrossReferencedCandidates,
  type RemoteCandidate,
} from './remoteIdentity';
import { __setMapsForTest } from './anilistTvdbMap';
import { closestDatedEpisode, AIR_DATE_TOLERANCE_MS, anilistDateToMs } from './episodeMatch';

const DAY = 24 * 60 * 60 * 1000;

test('the acceptance ladder - real pairs measured against the live library', () => {
  // Every row here was produced by the resolver and checked against the real
  // library. `days` is how far the air-date tier landed from the AniList
  // premiere, and it is the only signal that separates these: by title alone,
  // "Bananya Around the World -> Bananya" and "ONE PIECE FAN LETTER -> One
  // Piece" are the same shape.
  const cases: [string, number, 'accept' | 'reject'][] = [
    ['Thunderbolt Fantasy Sword Seekers 4 -> Thunderbolt Fantasy', 0, 'accept'],
    ['You and I Are Polar Opposites S2 -> (parent)', 0, 'accept'],
    ['Yamishibai 17 -> Yamishibai', 0, 'accept'],
    ['Bananya Around the World -> Bananya', 1, 'accept'],
    ['Frieren Part 3 -> Frieren', 3, 'accept'],
    ['ONE PIECE FAN LETTER -> One Piece', 329, 'reject'],
    ['One Piece Log -> One Piece', 343, 'reject'],
    ['Lycoris Recoil -Friends- -> Lycoris Recoil', 935, 'reject'],
    ['Star Wars: Visions Vol 3 -> Star Wars Rebels', 2795, 'reject'],
    ['5-Oku-nen Button Part 2 -> Babylon 5', 9441, 'reject'],
  ];
  for (const [label, days, want] of cases) {
    assert.equal(
      verdictFor({ exact: false, inLibrary: true, deltaMs: days * DAY, yearDelta: null, kind: 'tv', premiereDeltaMs: null, tvdbSeasonDeltaMs: null, tvdbHasUndatedFutureSeason: false }).verdict,
      want,
      `${label} (${days}d) should ${want}`
    );
  }
});

test('an exact title is accepted without needing the library', () => {
  const v = verdictFor({ exact: true, inLibrary: false, deltaMs: null, yearDelta: null, kind: 'tv', premiereDeltaMs: null, tvdbSeasonDeltaMs: null, tvdbHasUndatedFutureSeason: false });
  assert.equal(v.verdict, 'accept');
  assert.equal(v.rung, 'exact title');
});

test('an unverifiable result is queued, not thrown away', () => {
  // We do not hold it, so no air date can be checked. It still gets stored:
  // resolver ids are positive-only, so keeping it cannot cost anything, and the
  // id is what a future Sonarr/Radarr hand-off needs.
  assert.equal(
    verdictFor({ exact: false, inLibrary: false, deltaMs: null, yearDelta: null, kind: 'tv', premiereDeltaMs: null, tvdbSeasonDeltaMs: null, tvdbHasUndatedFutureSeason: false }).verdict,
    'queue'
  );
});

test('a film is judged on release year, having no episodes to date', () => {
  assert.equal(
    verdictFor({ exact: false, inLibrary: false, deltaMs: null, yearDelta: 0, kind: 'movie', premiereDeltaMs: null, tvdbSeasonDeltaMs: null, tvdbHasUndatedFutureSeason: false }).verdict,
    'accept'
  );
  assert.equal(
    verdictFor({ exact: false, inLibrary: false, deltaMs: null, yearDelta: 1, kind: 'movie', premiereDeltaMs: null, tvdbSeasonDeltaMs: null, tvdbHasUndatedFutureSeason: false }).verdict,
    'accept'
  );
  assert.equal(
    verdictFor({ exact: false, inLibrary: false, deltaMs: null, yearDelta: 9, kind: 'movie', premiereDeltaMs: null, tvdbSeasonDeltaMs: null, tvdbHasUndatedFutureSeason: false }).verdict,
    'queue'
  );
});

test('the year rung is for films only - a TV candidate cannot be accepted on release year', () => {
  // TMDB's Year-filtered search makes a +/-1 production year nearly free for an
  // unrelated series, and unlike a film a series has episodes whose air date
  // could decide - when we don't hold it, "queue" is the honest verdict. An
  // accept here writes a wrong id as permanent fact with no human in the loop.
  assert.equal(
    verdictFor({ exact: false, inLibrary: false, deltaMs: null, yearDelta: 0, kind: 'tv', premiereDeltaMs: null, tvdbSeasonDeltaMs: null, tvdbHasUndatedFutureSeason: false }).verdict,
    'queue',
    'year rung is for films only - a same-year TV sibling must queue for review'
  );
  assert.equal(
    verdictFor({ exact: false, inLibrary: false, deltaMs: null, yearDelta: 0, kind: null, premiereDeltaMs: null, tvdbSeasonDeltaMs: null, tvdbHasUndatedFutureSeason: false }).verdict,
    'queue',
    'an id-less kind must not be treated as a film'
  );
});

test('a premiere date outranks title text - the Echo class', () => {
  // Echo (anime film, premiere 2026-07-19) resolved to TMDB "Echo" (2023):
  // exact title, 1012 days off. The old ladder accepted on the text alone -
  // date evidence must send it to review instead.
  assert.equal(
    verdictFor({ exact: true, inLibrary: false, deltaMs: null, yearDelta: 3, kind: 'movie', premiereDeltaMs: 1012 * DAY, tvdbSeasonDeltaMs: null, tvdbHasUndatedFutureSeason: false }).verdict,
    'queue',
    'an exact title dated 1012d from the premiere must not blind-accept'
  );
  // cocoon: 523d off and it is the CORRECT film - TMDB dates the theatrical
  // release, AniList the broadcast. That pair is why beyond-tolerance QUEUES
  // for a human and must never auto-reject.
  assert.equal(
    verdictFor({ exact: true, inLibrary: false, deltaMs: null, yearDelta: 1, kind: 'movie', premiereDeltaMs: 523 * DAY, tvdbSeasonDeltaMs: null, tvdbHasUndatedFutureSeason: false }).verdict,
    'queue'
  );
  // And within tolerance the date VERIFIES the accept - the rung must say so,
  // because /admin/matching renders trust straight from it.
  const good = verdictFor({ exact: true, inLibrary: false, deltaMs: null, yearDelta: 0, kind: 'movie', premiereDeltaMs: 3 * DAY, tvdbSeasonDeltaMs: null, tvdbHasUndatedFutureSeason: false });
  assert.equal(good.verdict, 'accept');
  assert.equal(good.rung, 'premiere date 3d');
});

test('a dated non-exact candidate within tolerance is accepted - localized titles', () => {
  // 14 of the 105 queued rows resolve this way: TMDB holds the work under a
  // localized English title ("Kagaku×Bouken Survival!" -> "Surviving Science!",
  // 0 days). Title text can never match those; the date is a fingerprint.
  const v = verdictFor({ exact: false, inLibrary: false, deltaMs: null, yearDelta: 0, kind: 'tv', premiereDeltaMs: 0, tvdbSeasonDeltaMs: null, tvdbHasUndatedFutureSeason: false });
  assert.equal(v.verdict, 'accept');
  assert.equal(v.rung, 'premiere date 0d');
});

test('library episode evidence outranks a big series-premiere delta', () => {
  // Bananya Around the World -> Bananya: the SERIES premiered years before the
  // entry, so the premiere delta is huge - but the entry's own episode lands
  // 1 day off. Episode evidence must win or every held sequel gets queued.
  const v = verdictFor({ exact: false, inLibrary: true, deltaMs: 1 * DAY, yearDelta: null, kind: 'tv', premiereDeltaMs: 3300 * DAY, tvdbSeasonDeltaMs: null, tvdbHasUndatedFutureSeason: false });
  assert.equal(v.verdict, 'accept');
  assert.equal(v.rung, 'air date 1d');
});

test('a contradicting premiere date blocks the year rung', () => {
  // Measured: 4 of 51 release-year accepts were contradicted by day precision
  // (62-201d) - a +/-1 year window admits up to ~730 days, and the day already
  // knows better.
  assert.equal(
    verdictFor({ exact: false, inLibrary: false, deltaMs: null, yearDelta: 0, kind: 'movie', premiereDeltaMs: 201 * DAY, tvdbSeasonDeltaMs: null, tvdbHasUndatedFutureSeason: false }).verdict,
    'queue',
    'the year rung must not fire when the premiere date already disagrees'
  );
});

test('a TVDB season premiere accepts a held sequel the stale library rejected', () => {
  // Ranma1/2 (2024) Season 3: we hold seasons 1-2, so the nearest HELD episode
  // is 287d from the entry premiere and the old gate rejected the correct
  // parent. TVDB's schedule has S3E1 on the premiere day - that evidence must
  // win, because held episodes are naturally stale for a season nobody has
  // grabbed yet.
  const v = verdictFor({
    exact: false, inLibrary: true, deltaMs: 287 * DAY, yearDelta: null, kind: 'tv',
    premiereDeltaMs: null, tvdbSeasonDeltaMs: 0, tvdbHasUndatedFutureSeason: false,
  });
  assert.equal(v.verdict, 'accept',
    'a TVDB season premiere on the entry date must beat stale held episodes');
  assert.equal(v.rung, 'tvdb season premiere 0d');
});

test('an undated future season at TVDB softens a held rejection to review', () => {
  // Sousou no Frieren 3rd Season: held episodes end 553d before the entry
  // premiere, and TVDB lists season 3 but has not dated it. Rejecting writes
  // "not this series" about the show's own parent - queue it instead.
  const v = verdictFor({
    exact: false, inLibrary: true, deltaMs: 553 * DAY, yearDelta: null, kind: 'tv',
    premiereDeltaMs: null, tvdbSeasonDeltaMs: null, tvdbHasUndatedFutureSeason: true,
  });
  assert.equal(v.verdict, 'queue',
    'a rejection is premature while TVDB lists an undated future season');
  // And the rejections that were CORRECT stay rejections: One Piece Fan Letter
  // (329d) and Babylon 5 (9,441d) - no undated future season on either.
  for (const days of [329, 9441]) {
    assert.equal(
      verdictFor({
        exact: false, inLibrary: true, deltaMs: days * DAY, yearDelta: null, kind: 'tv',
        premiereDeltaMs: null, tvdbSeasonDeltaMs: null, tvdbHasUndatedFutureSeason: false,
      }).verdict,
      'reject',
      `${days}d with no future season must still reject`
    );
  }
});

const cand = (
  tmdbId: string, matchedTitle: string, exact: boolean,
  premiereDate: string | null, year: number | null = null
): RemoteCandidate => ({
  tvdbId: null, tmdbId, tmdbKind: 'movie', matchedTitle, exact, year,
  image: null, premiereDate,
});

test('pickCandidate prefers the dated-within exact by distance - the DIVE IN! pair', () => {
  // Real pair: two exact-title films, 167d and 16d from the 2025-03-09
  // premiere. The old pick took whichever TMDB ranked first (167d).
  const airMs = anilistDateToMs({ year: 2025, month: 3, day: 9 })!;
  const picked = pickCandidate([
    cand('1576829', 'Dive In', true, '2025-08-23'),   // 167d
    cand('1479380', 'DIVE IN!', true, '2025-03-25'),  // 16d
  ], airMs);
  assert.equal(picked?.tmdbId, '1479380',
    'with two exact titles, the one the premiere date vouches for must win');
});

test('pickCandidate lets a dated non-exact beat an undatable exact - Hyakki Yakou Shou', () => {
  // Real pair: the exact-title candidate is a same-named 2007 work (7003d);
  // the correct match is the localized "Beyond Twilight" at 0 days.
  const airMs = anilistDateToMs({ year: 2026, month: 4, day: 7 })!;
  const picked = pickCandidate([
    cand('81417', 'Hyakki Yakoushou', true, '2007-02-06'),
    cand('318478', 'Beyond Twilight', false, '2026-04-07'),
  ], airMs);
  assert.equal(picked?.matchedTitle, 'Beyond Twilight',
    'a candidate the date verifies must beat an exact title the date refutes');
});

test('pickCandidate: undated exacts tie-break on year, and no dates at all keeps today\'s order', () => {
  // Echo's shape with the dates missing: two same-titled films, wrong year
  // first in provider order. Year proximity must break the tie.
  const airMs = anilistDateToMs({ year: 2026, month: 7, day: 19 })!;
  const byYear = pickCandidate([
    cand('1187349', 'Echo', true, null, 2023),
    cand('1614268', 'Echo', true, null, 2026),
  ], airMs);
  assert.equal(byYear?.tmdbId, '1614268', 'the entry-year sibling must win the undated tie');
  // No dates, no years, or no entry date -> stored (provider) order, unchanged
  // from today.
  const asToday = pickCandidate([
    cand('1', 'A', true, null),
    cand('2', 'B', true, null),
  ], null);
  assert.equal(asToday?.tmdbId, '1');
  // Everything dated-beyond -> the ladder queues whatever is picked, but the
  // stored best-guess should still be the exact title, not whatever TMDB
  // ranked first: the real Echo re-grade stored "Echo Boomers" (non-exact,
  // 2020) over the exact-titled "Echo" because the fallback took all[0].
  const allBad = pickCandidate([
    cand('558574', 'Echo Boomers', false, '2020-11-13'),
    cand('1187349', 'Echo', true, '2023-10-10'),
  ], airMs);
  assert.equal(allBad?.tmdbId, '1187349',
    'the queued best-guess must prefer the exact title over provider order');
});

test('premiere dates parse defensively', () => {
  assert.equal(premiereOf({ PremiereDate: '2025-04-29T05:00:00.0000000Z' }), '2025-04-29');
  assert.equal(premiereOf({ PremiereDate: 'garbage' }), null);
  assert.equal(premiereOf({}), null);
  assert.equal(premiereOf(null), null);
  const airMs = Date.UTC(2025, 3, 29);
  assert.equal(premiereDelta('2025-04-29', airMs), 0);
  assert.equal(premiereDelta('2025-04-26', airMs), 3 * DAY);
  assert.equal(premiereDelta(null, airMs), null);
  assert.equal(premiereDelta('2025-04-29', null), null);
  assert.equal(premiereDelta('not a date', airMs), null, 'malformed must read as undated, never NaN');
});

test('baseTitles strips what TMDB does not catalogue, least-destructive first', () => {
  // Marker stripping keeps its measured behaviour: the marker goes, not the
  // franchise root - "Punirunes Puni", never "Punirunes". The probe that first
  // demonstrated the base pass typed the shorter form by hand.
  assert.deepEqual(baseTitles('Punirunes Puni 2'), ['Punirunes Puni']);
  assert.deepEqual(baseTitles('Kumarba Season 2'), ['Kumarba']);
  assert.deepEqual(
    baseTitles("BanG Dream! It's MyGO!!!!!: Haru no Hidamari, Mayoi Neko"),
    ["BanG Dream! It's MyGO!!!!!"]
  );
  assert.deepEqual(baseTitles('Sylvanian Families: Freya no Piece of Secret'),
    ['Sylvanian Families']);
  // Variants only: nothing to strip means nothing to search twice for.
  assert.deepEqual(baseTitles('Mebius Dust'), []);
});

test('markers are stripped BEFORE the subtitle, and they stack', () => {
  // The real false positive this ordering fixes: the old form stripped at the
  // first separator first, so this title collapsed straight to "Mission" -
  // which TMDB answered with *Mission: Impossible* - and the form that
  // actually resolves on TVDB (tvdb 424019) was never generated.
  assert.deepEqual(baseTitles('Mission: Yozakura Family Season 2 Part 2'), [
    'Mission: Yozakura Family', // tried first; resolves, so "Mission" is never searched
    'Mission',
  ]);
});

test('a separator must look like a separator', () => {
  // A colon without a trailing space is part of the word: "Re:Zero" collapsing
  // to "Re" is what once proposed "RE: European Stories".
  assert.deepEqual(
    baseTitles('Re:Zero kara Hajimeru Kyuukei Jikan (Break Time) 3rd Season'),
    ['Re:Zero kara Hajimeru Kyuukei Jikan (Break Time)']
  );
  // A dash without leading whitespace is part of the word - mid-word splits
  // truncated this to "Shin Tennis no Ouji", which matches nothing.
  assert.deepEqual(
    baseTitles('Shin Tennis no Ouji-sama: U-17 WORLD CUP Semifinal'),
    ['Shin Tennis no Ouji-sama']
  );
  // ...and "5-Oku-nen" collapsing to "5" is the entire Babylon 5 story.
  assert.deepEqual(baseTitles('5-Oku-nen Button Part 2'), ['5-Oku-nen Button']);
  // A spaced dash IS a separator, as before.
  assert.deepEqual(baseTitles('Solo Leveling -ReAwakening-'), ['Solo Leveling']);
});

test('closestDatedEpisode ignores season 0 and prefers the earlier of a tie', () => {
  const air = Date.UTC(2025, 0, 10);
  const eps = [
    // Specials cluster around the seasons they ship with and would otherwise
    // win ties against the real episode.
    { ParentIndexNumber: 0, IndexNumber: 1, PremiereDate: '2025-01-10T00:00:00Z' },
    { ParentIndexNumber: 2, IndexNumber: 1, PremiereDate: '2025-01-10T00:00:00Z' },
    { ParentIndexNumber: 2, IndexNumber: 2, PremiereDate: '2025-01-10T00:00:00Z' },
    { ParentIndexNumber: 1, IndexNumber: 1, PremiereDate: '2020-04-01T00:00:00Z' },
  ];
  const hit = closestDatedEpisode(eps, air);
  assert.equal(hit?.episode.ParentIndexNumber, 2,
    'season 0 must not compete for air-date ties - specials ship alongside ' +
    'the season and would win them');
  assert.equal(hit?.episode.IndexNumber, 1, 'ties go to the earlier episode');
  assert.equal(hit?.deltaMs, 0);
});

test('the tie-break holds regardless of the order Jellyfin returns', () => {
  // The docstring promises "ties go to the earlier episode", but the first
  // implementation kept whichever the response yielded first - and Jellyfin's
  // episode order is not a contract (the tier-2 picker in routes/jellyfin.ts
  // has always sorted before trusting it). A same-day double premiere then
  // opened Watch on episode 2 whenever the API happened to list it first.
  const air = Date.UTC(2025, 0, 10);
  const eps = [
    { ParentIndexNumber: 2, IndexNumber: 2, PremiereDate: '2025-01-10T00:00:00Z' },
    { ParentIndexNumber: 2, IndexNumber: 1, PremiereDate: '2025-01-10T00:00:00Z' },
  ];
  const hit = closestDatedEpisode(eps, air);
  assert.equal(hit?.episode.IndexNumber, 1,
    'ties must go to the earlier episode even when the API yields the later one first');
});

test('a partial AniList date reads as the earliest day it could mean', () => {
  assert.equal(anilistDateToMs({ year: 2025, month: null, day: null }), Date.UTC(2025, 0, 1));
  assert.equal(anilistDateToMs({ year: null }), null);
  assert.equal(anilistDateToMs(null), null);
});

test('a stored identity is completed in both id spaces where anything knows the pair', () => {
  // Jellyfin's remote search returns TMDB ids only on this server, but a
  // Sonarr/Radarr user expects SERIES rows to carry TVDB ids. The sweep must
  // complete what it stores: the library's own metadata first, the community
  // map second.
  __setMapsForTest({}, {});
  const viaLibrary = completeIdentityIds(
    { tvdbId: null, tmdbId: '37854', tmdbKind: 'tv' },
    { tvdbId: '81797', tmdbId: '37854' }
  );
  assert.equal(viaLibrary.tvdbId, '81797',
    'a tmdb-only series accepted against a held library item must take its tvdb id');

  __setMapsForTest({ '10': '5555' }, { '10': 'tv:9999' });
  const viaMap = completeIdentityIds({ tvdbId: null, tmdbId: '9999', tmdbKind: 'tv' }, null);
  assert.equal(viaMap.tvdbId, '5555',
    'an unheld tmdb series id must still pick up its tvdb sibling from the map');

  __setMapsForTest({}, {});
  const unknown = completeIdentityIds({ tvdbId: null, tmdbId: '777', tmdbKind: 'movie' }, null);
  assert.equal(unknown.tvdbId, null, 'nothing known stays honestly half-filled');
  assert.equal(unknown.tmdbId, '777');
});

test('lookup terms: a prefixed id is an id, bare digits are a title', () => {
  assert.deepEqual(parseLookupTerm('tvdb:81797'), { kind: 'tvdb', id: '81797' });
  assert.deepEqual(parseLookupTerm('TMDB: 37854'), { kind: 'tmdb', id: '37854' },
    'the prefix is case-insensitive and tolerates a space, like Sonarr');
  assert.deepEqual(parseLookupTerm('86'), { kind: 'name', name: '86' },
    'bare digits are a real title (the anime "86") - the prefix is required on purpose');
  assert.deepEqual(parseLookupTerm('  One Piece '), { kind: 'name', name: 'One Piece' });
});

test('a malformed sweep status degrades to null, never a throw', () => {
  // The status is a persisted cache row like every other AppConfig blob here:
  // a corrupt one must mean "no status", not a crashed admin page.
  assert.equal(parseSweepStatus(null), null);
  assert.equal(parseSweepStatus('not json {'), null, 'malformed JSON must read as no-status');
  assert.equal(parseSweepStatus('"a string"'), null, 'a non-object must read as no-status');
  const s = parseSweepStatus(JSON.stringify({
    finishedAt: 5, looked: 1, accepted: 1, queued: 0, rejected: 0,
    remaining: 2, overrides: 3, mapSize: 7000,
  }));
  assert.equal(s?.looked, 1, 'a valid status must round-trip');
});

test('miss retries tier by air-date distance, and a two-year-old miss is retired', () => {
  // The tiers exist because TMDB gains records as a show approaches airing -
  // and stops gaining them once it is long past. The Infinity rung is the
  // retirement rule: an entry that aired more than two years ago and is STILL
  // unknown upstream has been unknown for its whole life; re-asking monthly
  // forever is budget spent on lost causes (measured: the 2024 leftovers in
  // the dev cache are exactly these). First-ever lookups are unaffected - the
  // sweep consults this only for entries that already have a recorded miss.
  const y = new Date().getFullYear();
  assert.equal(retryAfterFor(null), 14 * DAY, 'unknown year: the flat fortnight');
  assert.equal(retryAfterFor(undefined), 14 * DAY);
  assert.equal(retryAfterFor(y), 2 * DAY, 'current year: records appear within days');
  assert.equal(retryAfterFor(y - 1), 2 * DAY);
  assert.equal(retryAfterFor(y + 1), 2 * DAY);
  assert.equal(retryAfterFor(y - 2), 30 * DAY, 'two years back still gets the slow lane');
  assert.equal(retryAfterFor(y + 2), 30 * DAY, 'far-future announcements are not retired');
  assert.equal(retryAfterFor(y - 3), Infinity,
    'a miss more than two years old must be retired - never re-asked');
  assert.equal(retryAfterFor(1998), Infinity,
    'a decades-old miss must be retired - never re-asked');
});

test('retryStateFor names each unmatched row honestly: eligible, cooldown, retired', () => {
  // The admin page shows this verbatim ("searched 2 d ago - retries in ~5 h" /
  // "retired" / "never searched"). It is retryAfterFor read from a single
  // row's point of view, so the tier arithmetic stays in one module - the
  // first sketch had the frontend re-deriving it, which rots the day a tier
  // changes. `now` is a parameter because a state that flips with the wall
  // clock cannot be table-tested otherwise.
  const now = 1_000_000_000_000; // fixed; only differences matter
  const y = new Date(now).getFullYear();

  assert.deepEqual(retryStateFor(null, y, now), { state: 'eligible', lastLookupAt: null, nextRetryAt: null },
    'never searched must be eligible - a first lookup is unconditional at any age');
  assert.deepEqual(retryStateFor(now - DAY, y, now),
    { state: 'cooldown', lastLookupAt: now - DAY, nextRetryAt: now - DAY + 2 * DAY },
    'a fresh miss on a current-year entry cools down until lastLookup + 2 days');
  assert.deepEqual(retryStateFor(now - 3 * DAY, y, now),
    { state: 'eligible', lastLookupAt: now - 3 * DAY, nextRetryAt: null },
    'a miss past its window is eligible again - cooldown must expire, not stick');
  assert.deepEqual(retryStateFor(now - DAY, y - 2, now),
    { state: 'cooldown', lastLookupAt: now - DAY, nextRetryAt: now - DAY + 30 * DAY },
    'two years back is the slow lane, not retirement');
  assert.deepEqual(retryStateFor(now - DAY, y - 3, now),
    { state: 'retired', lastLookupAt: now - DAY, nextRetryAt: null },
    'a miss on an entry that aired >2 years ago is retired - never re-asked');
  assert.deepEqual(retryStateFor(null, y - 10, now),
    { state: 'eligible', lastLookupAt: null, nextRetryAt: null },
    'retirement applies to misses, never to a first look - even a decade back');
});

test('candidates from two providers merge on an id cross-reference, never on a title', () => {
  // Chikyuu Daisuki! Kikkun, verbatim: TVDB knows it (undated) and TMDB knows
  // it (dated 2026-07-01, the entry's premiere day). Two candidates that look
  // ambiguous in the picker and are the same show - provably, because
  // skyhook's own show record for tvdb 479768 names tmdbId 326697.
  const chikyuu: RemoteCandidate[] = [
    { matchedTitle: 'Chikyuu Daisuki! Kikkun', year: null, premiereDate: null, tvdbId: '479768', tmdbId: null, tmdbKind: null, exact: true, image: null },
    { matchedTitle: 'Chikyuu Daisuki! Kikkun', year: 2026, premiereDate: '2026-07-01', tvdbId: null, tmdbId: '326697', tmdbKind: 'tv', exact: true, image: null },
  ];
  const merged = mergeCrossReferencedCandidates(chikyuu, new Map([['479768', '326697']]));
  assert.equal(merged.length, 1, 'one show must be one option, not two');
  assert.equal(merged[0].tvdbId, '479768', 'the merged option keeps the TVDB id');
  assert.equal(merged[0].tmdbId, '326697', 'and gains the TMDB id - the pair a Sonarr flow needs');
  assert.equal(merged[0].tmdbKind, 'tv');
  assert.equal(merged[0].premiereDate, '2026-07-01',
    'the date must survive the merge - it is the only thing that can verify the match');
  assert.equal(merged[0].year, 2026);

  // The guard that matters: same exact title is NOT evidence. Echo's three
  // candidates are all titled "Echo" and are three different films; with no
  // cross-reference between them, nothing may be collapsed.
  const echo: RemoteCandidate[] = [
    { matchedTitle: 'Echo', year: 2023, premiereDate: '2023-10-11', tvdbId: null, tmdbId: '1187349', tmdbKind: 'movie', exact: true, image: null },
    { matchedTitle: 'echo', year: 2026, premiereDate: '2026-06-03', tvdbId: null, tmdbId: '1631232', tmdbKind: 'movie', exact: true, image: null },
    { matchedTitle: 'Echo', year: 2026, premiereDate: '2026-02-05', tvdbId: null, tmdbId: '1614268', tmdbKind: 'movie', exact: true, image: null },
  ];
  // The map must be NON-EMPTY or this asserts nothing: an empty one hits the
  // early return and the merge logic never runs. (It didn't, at first - the
  // title-merge mutant sailed through a green test.) These references exist
  // and simply don't apply to any candidate here.
  const unrelatedXrefs = new Map([['399042', '69346'], ['479768', '326697']]);
  assert.equal(mergeCrossReferencedCandidates(echo, unrelatedXrefs).length, 3,
    'identical titles with no id cross-reference are different works and must all survive');

  // A cross-reference pointing at a candidate we do not have changes nothing.
  const lone: RemoteCandidate[] = [
    { matchedTitle: 'Youjo Shenki', year: 2017, premiereDate: '2017-01-10', tvdbId: '399042', tmdbId: null, tmdbKind: null, exact: false, image: null },
  ];
  assert.deepEqual(mergeCrossReferencedCandidates(lone, new Map([['399042', '999999']])), lone,
    'a cross-reference with nothing to merge into must leave the list untouched');
});

test('pickCandidate: outside tolerance, the closest premiere still wins over provider order', () => {
  // Echo (AniList 214068, premieres 2026-07-19), verbatim from the resolver's
  // stored candidates. Three exact-title matches, none inside the 31-day
  // tolerance, so every dated rung falls through - and the old last line took
  // "the first exact in provider order", i.e. TMDB's popularity ranking, which
  // put the 2023 film (1,012 d away) ahead of the 2026 one 46 d away. The
  // verdict was always right (it queues for review either way); what was wrong
  // was the suggestion a human is asked to judge.
  const airDate = Date.UTC(2026, 6, 19);
  const echo: RemoteCandidate[] = [
    { matchedTitle: 'Echo Boomers', year: 2020, premiereDate: '2020-11-13', tmdbId: '558574', tmdbKind: 'movie', tvdbId: null, exact: false, image: null },
    { matchedTitle: 'Echo', year: 2023, premiereDate: '2023-10-11', tmdbId: '1187349', tmdbKind: 'movie', tvdbId: null, exact: true, image: null },
    { matchedTitle: 'echo', year: 2026, premiereDate: '2026-06-03', tmdbId: '1631232', tmdbKind: 'movie', tvdbId: null, exact: true, image: null },
    { matchedTitle: 'Echo', year: 2026, premiereDate: '2026-02-05', tmdbId: '1614268', tmdbKind: 'movie', tvdbId: null, exact: true, image: null },
  ];
  assert.equal(pickCandidate(echo, airDate)?.tmdbId, '1631232',
    'the exact title 46 days from the premiere must be offered, not the one 1,012 days away');

  // No exact title anywhere: nothing has been measured to beat provider
  // relevance there, so it must stay untouched.
  const noExact: RemoteCandidate[] = [
    { matchedTitle: 'Something Else', year: 2019, premiereDate: '2019-01-01', tmdbId: '11', tmdbKind: 'tv', tvdbId: null, exact: false, image: null },
    { matchedTitle: 'Closer By Date', year: 2026, premiereDate: '2026-06-01', tmdbId: '22', tmdbKind: 'tv', tvdbId: null, exact: false, image: null },
  ];
  assert.equal(pickCandidate(noExact, airDate)?.tmdbId, '11',
    'with no exact title, provider order is still the only evidence there is');
});

test('planSweep: scheduled runs respect cooldowns, a manual drain overrides them', () => {
  // The selection half of the sweep, extracted so it can be tested at all -
  // it used to live inside runRemoteIdentitySweep, which needs Prisma and a
  // Jellyfin Api, so the rules that decide WHAT gets looked up were the least
  // covered part of the most consequential loop.
  const now = 1_000_000_000_000;
  const y = new Date(now).getFullYear();
  const todo = [
    { anilistId: 1, year: y },       // never asked
    { anilistId: 2, year: y },       // asked yesterday - cooling (2 d tier)
    { anilistId: 3, year: y },       // asked 3 days ago - window passed
    { anilistId: 4, year: y - 5 },   // asked yesterday, aired 5 y ago - retired
    { anilistId: 5, year: y },       // never asked
  ];
  const askedAt = new Map([[2, now - DAY], [3, now - 3 * DAY], [4, now - DAY]]);

  const scheduled = planSweep(todo, askedAt, { max: 10, now });
  assert.deepEqual(scheduled.batch.map((q) => q.anilistId), [1, 3, 5],
    'a scheduled run takes never-asked and window-passed entries, never the cooling ones');
  assert.equal(scheduled.cooldown, 1, 'the cooling entry is counted, not silently dropped');
  assert.equal(scheduled.retired, 1, 'the >2 y miss is counted as retired');
  assert.equal(scheduled.eligible, 3, 'eligible excludes both cooldown and retired');

  // The cap bounds the batch but must NOT shrink the queue figure the admin
  // page reports - that conflation is what made `remaining` unable to reach 0.
  const capped = planSweep(todo, askedAt, { max: 2, now });
  assert.deepEqual(capped.batch.map((q) => q.anilistId), [1, 3],
    'the cap truncates the batch in queue order');
  assert.equal(capped.eligible, 3, 'the cap must not change how many are eligible');

  // The manual button's contract: everything we still owe an answer for, now.
  const drain = planSweep(todo, askedAt, { max: Infinity, ignoreCooldown: true, now });
  assert.deepEqual(drain.batch.map((q) => q.anilistId), [1, 2, 3, 5],
    'a drain must include the cooling entry - an admin pressing the button is not the daily budget');
  assert.ok(!drain.batch.some((q) => q.anilistId === 4),
    'a drain still skips retired entries - upstream has never heard of them and re-asking forever is the churn retirement removed');
});

test('the tolerance is far tighter than the gap to a neighbouring season', () => {
  // A cour is ~90 days; the tolerance must sit well inside that or a sequel
  // would match its own previous season.
  assert.ok(AIR_DATE_TOLERANCE_MS < 90 * DAY);
  assert.ok(AIR_DATE_TOLERANCE_MS >= 14 * DAY);
});
