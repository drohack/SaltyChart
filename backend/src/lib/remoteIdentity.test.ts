import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  verdictFor,
  pickCandidate,
  premiereDelta,
  premiereOf,
  baseTitle,
  parseSweepStatus,
  parseLookupTerm,
  completeIdentityIds,
  type RemoteCandidate,
} from './remoteIdentity';
import { __setMapsForTest } from './anilistTvdbMap';
import { closestDatedEpisode, AIR_DATE_TOLERANCE_MS, anilistDateToMs } from './episodeMatch';

const DAY = 24 * 60 * 60 * 1000;

test('the acceptance ladder — real pairs measured against the live library', () => {
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
      verdictFor({ exact: false, inLibrary: true, deltaMs: days * DAY, yearDelta: null, kind: 'tv', premiereDeltaMs: null }).verdict,
      want,
      `${label} (${days}d) should ${want}`
    );
  }
});

test('an exact title is accepted without needing the library', () => {
  const v = verdictFor({ exact: true, inLibrary: false, deltaMs: null, yearDelta: null, kind: 'tv', premiereDeltaMs: null });
  assert.equal(v.verdict, 'accept');
  assert.equal(v.rung, 'exact title');
});

test('an unverifiable result is queued, not thrown away', () => {
  // We do not hold it, so no air date can be checked. It still gets stored:
  // resolver ids are positive-only, so keeping it cannot cost anything, and the
  // id is what a future Sonarr/Radarr hand-off needs.
  assert.equal(
    verdictFor({ exact: false, inLibrary: false, deltaMs: null, yearDelta: null, kind: 'tv', premiereDeltaMs: null }).verdict,
    'queue'
  );
});

test('a film is judged on release year, having no episodes to date', () => {
  assert.equal(
    verdictFor({ exact: false, inLibrary: false, deltaMs: null, yearDelta: 0, kind: 'movie', premiereDeltaMs: null }).verdict,
    'accept'
  );
  assert.equal(
    verdictFor({ exact: false, inLibrary: false, deltaMs: null, yearDelta: 1, kind: 'movie', premiereDeltaMs: null }).verdict,
    'accept'
  );
  assert.equal(
    verdictFor({ exact: false, inLibrary: false, deltaMs: null, yearDelta: 9, kind: 'movie', premiereDeltaMs: null }).verdict,
    'queue'
  );
});

test('the year rung is for films only — a TV candidate cannot be accepted on release year', () => {
  // TMDB's Year-filtered search makes a ±1 production year nearly free for an
  // unrelated series, and unlike a film a series has episodes whose air date
  // could decide — when we don't hold it, "queue" is the honest verdict. An
  // accept here writes a wrong id as permanent fact with no human in the loop.
  assert.equal(
    verdictFor({ exact: false, inLibrary: false, deltaMs: null, yearDelta: 0, kind: 'tv', premiereDeltaMs: null }).verdict,
    'queue',
    'year rung is for films only — a same-year TV sibling must queue for review'
  );
  assert.equal(
    verdictFor({ exact: false, inLibrary: false, deltaMs: null, yearDelta: 0, kind: null, premiereDeltaMs: null }).verdict,
    'queue',
    'an id-less kind must not be treated as a film'
  );
});

test('a premiere date outranks title text — the Echo class', () => {
  // Echo (anime film, premiere 2026-07-19) resolved to TMDB "Echo" (2023):
  // exact title, 1012 days off. The old ladder accepted on the text alone —
  // date evidence must send it to review instead.
  assert.equal(
    verdictFor({ exact: true, inLibrary: false, deltaMs: null, yearDelta: 3, kind: 'movie', premiereDeltaMs: 1012 * DAY }).verdict,
    'queue',
    'an exact title dated 1012d from the premiere must not blind-accept'
  );
  // cocoon: 523d off and it is the CORRECT film — TMDB dates the theatrical
  // release, AniList the broadcast. That pair is why beyond-tolerance QUEUES
  // for a human and must never auto-reject.
  assert.equal(
    verdictFor({ exact: true, inLibrary: false, deltaMs: null, yearDelta: 1, kind: 'movie', premiereDeltaMs: 523 * DAY }).verdict,
    'queue'
  );
  // And within tolerance the date VERIFIES the accept — the rung must say so,
  // because /admin/matching renders trust straight from it.
  const good = verdictFor({ exact: true, inLibrary: false, deltaMs: null, yearDelta: 0, kind: 'movie', premiereDeltaMs: 3 * DAY });
  assert.equal(good.verdict, 'accept');
  assert.equal(good.rung, 'premiere date 3d');
});

test('a dated non-exact candidate within tolerance is accepted — localized titles', () => {
  // 14 of the 105 queued rows resolve this way: TMDB holds the work under a
  // localized English title ("Kagaku×Bouken Survival!" → "Surviving Science!",
  // 0 days). Title text can never match those; the date is a fingerprint.
  const v = verdictFor({ exact: false, inLibrary: false, deltaMs: null, yearDelta: 0, kind: 'tv', premiereDeltaMs: 0 });
  assert.equal(v.verdict, 'accept');
  assert.equal(v.rung, 'premiere date 0d');
});

test('library episode evidence outranks a big series-premiere delta', () => {
  // Bananya Around the World -> Bananya: the SERIES premiered years before the
  // entry, so the premiere delta is huge — but the entry's own episode lands
  // 1 day off. Episode evidence must win or every held sequel gets queued.
  const v = verdictFor({ exact: false, inLibrary: true, deltaMs: 1 * DAY, yearDelta: null, kind: 'tv', premiereDeltaMs: 3300 * DAY });
  assert.equal(v.verdict, 'accept');
  assert.equal(v.rung, 'air date 1d');
});

test('a contradicting premiere date blocks the year rung', () => {
  // Measured: 4 of 51 release-year accepts were contradicted by day precision
  // (62–201d) — a ±1 year window admits up to ~730 days, and the day already
  // knows better.
  assert.equal(
    verdictFor({ exact: false, inLibrary: false, deltaMs: null, yearDelta: 0, kind: 'movie', premiereDeltaMs: 201 * DAY }).verdict,
    'queue',
    'the year rung must not fire when the premiere date already disagrees'
  );
});

const cand = (
  tmdbId: string, matchedTitle: string, exact: boolean,
  premiereDate: string | null, year: number | null = null
): RemoteCandidate => ({
  tvdbId: null, tmdbId, tmdbKind: 'movie', matchedTitle, exact, year,
  image: null, premiereDate,
});

test('pickCandidate prefers the dated-within exact by distance — the DIVE IN! pair', () => {
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

test('pickCandidate lets a dated non-exact beat an undatable exact — Hyakki Yakou Shou', () => {
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
  // No dates, no years, or no entry date → stored (provider) order, unchanged
  // from today.
  const asToday = pickCandidate([
    cand('1', 'A', true, null),
    cand('2', 'B', true, null),
  ], null);
  assert.equal(asToday?.tmdbId, '1');
  // Everything dated-beyond → the ladder queues whatever is picked, but the
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

test('baseTitle strips what TMDB does not catalogue', () => {
  // TMDB files a sequel as a season of one series, so it holds the base name.
  //
  // Note it strips the *marker*, not back to the franchise root: "Punirunes
  // Puni 2" becomes "Punirunes Puni", not "Punirunes". The exploratory probe
  // that first showed this working typed the shorter form by hand, so the
  // measured +59 belongs to this behaviour — pinning it here stops a future
  // reading of that note from "fixing" the function to match the anecdote.
  assert.equal(baseTitle('Punirunes Puni 2'), 'Punirunes Puni');
  assert.equal(baseTitle('Kumarba Season 2'), 'Kumarba');
  assert.equal(
    baseTitle("BanG Dream! It's MyGO!!!!!: Haru no Hidamari, Mayoi Neko"),
    "BanG Dream! It's MyGO!!!!!"
  );
  assert.equal(baseTitle('Sylvanian Families: Freya no Piece of Secret'), 'Sylvanian Families');
  // A title with nothing to strip is returned unchanged, so the caller can tell
  // there is no second pass worth making.
  assert.equal(baseTitle('Mebius Dust'), 'Mebius Dust');
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
    'season 0 must not compete for air-date ties — specials ship alongside ' +
    'the season and would win them');
  assert.equal(hit?.episode.IndexNumber, 1, 'ties go to the earlier episode');
  assert.equal(hit?.deltaMs, 0);
});

test('the tie-break holds regardless of the order Jellyfin returns', () => {
  // The docstring promises "ties go to the earlier episode", but the first
  // implementation kept whichever the response yielded first — and Jellyfin's
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
    'bare digits are a real title (the anime "86") — the prefix is required on purpose');
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

test('the tolerance is far tighter than the gap to a neighbouring season', () => {
  // A cour is ~90 days; the tolerance must sit well inside that or a sequel
  // would match its own previous season.
  assert.ok(AIR_DATE_TOLERANCE_MS < 90 * DAY);
  assert.ok(AIR_DATE_TOLERANCE_MS >= 14 * DAY);
});
