import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verdictFor, baseTitle } from './remoteIdentity';
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
      verdictFor({ exact: false, inLibrary: true, deltaMs: days * DAY, yearDelta: null }),
      want,
      `${label} (${days}d) should ${want}`
    );
  }
});

test('an exact title is accepted without needing the library', () => {
  assert.equal(
    verdictFor({ exact: true, inLibrary: false, deltaMs: null, yearDelta: null }),
    'accept'
  );
});

test('an unverifiable result is queued, not thrown away', () => {
  // We do not hold it, so no air date can be checked. It still gets stored:
  // resolver ids are positive-only, so keeping it cannot cost anything, and the
  // id is what a future Sonarr/Radarr hand-off needs.
  assert.equal(
    verdictFor({ exact: false, inLibrary: false, deltaMs: null, yearDelta: null }),
    'queue'
  );
});

test('a film is judged on release year, having no episodes to date', () => {
  assert.equal(
    verdictFor({ exact: false, inLibrary: false, deltaMs: null, yearDelta: 0 }),
    'accept'
  );
  assert.equal(
    verdictFor({ exact: false, inLibrary: false, deltaMs: null, yearDelta: 1 }),
    'accept'
  );
  assert.equal(
    verdictFor({ exact: false, inLibrary: false, deltaMs: null, yearDelta: 9 }),
    'queue'
  );
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
  assert.equal(hit?.episode.ParentIndexNumber, 2);
  assert.equal(hit?.episode.IndexNumber, 1, 'ties go to the earlier episode');
  assert.equal(hit?.deltaMs, 0);
});

test('a partial AniList date reads as the earliest day it could mean', () => {
  assert.equal(anilistDateToMs({ year: 2025, month: null, day: null }), Date.UTC(2025, 0, 1));
  assert.equal(anilistDateToMs({ year: null }), null);
  assert.equal(anilistDateToMs(null), null);
});

test('the tolerance is far tighter than the gap to a neighbouring season', () => {
  // A cour is ~90 days; the tolerance must sit well inside that or a sequel
  // would match its own previous season.
  assert.ok(AIR_DATE_TOLERANCE_MS < 90 * DAY);
  assert.ok(AIR_DATE_TOLERANCE_MS >= 14 * DAY);
});
