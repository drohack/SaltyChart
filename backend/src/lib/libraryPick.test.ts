import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchLibrary, type PickableSeries, type PickableFilm } from './libraryPick';
import { normalizeTitle, type MatchableSeries } from './animeMatch';

function series(id: string, title: string, tvdbId?: string | null, year?: number): MatchableSeries {
  return { id, title, norms: [normalizeTitle(title)], tvdbId: tvdbId ?? null, year };
}

const LIB: PickableSeries[] = [
  series('s1', 'Bananya', '313676', 2016),
  series('s2', 'Bananya and the Curious Bunch', '350001', 2019),
  series('s3', 'One Piece', '81797', 1999),
  // Held, but no id in either space - a pick could not be expressed as an
  // identity override, so offering it would be a control that does nothing.
  series('s4', 'Nameless Show', null),
  series('s5', '転生貴族、鑑定スキルで成り上がる', '400001', 2022),
];

const FILMS: Record<string, PickableFilm> = {
  '550': { itemId: 'f1', title: 'Echo', year: 2026 },
  '551': { itemId: 'f2', title: 'Echoes of a Distant Star', year: 2002 },
};

test('searchLibrary ranks exact titles first, then prefix, then contains', () => {
  // A human is choosing here, so recall beats precision - the opposite of
  // `matchSeries`, whose contains-anywhere tier was removed for being wrong 9
  // times out of 9. That rule is about AUTOMATIC matching; a picker that hides
  // the right answer because the title is a substring is just broken.
  const hits = searchLibrary('Bananya', LIB, FILMS, 10);
  assert.equal(hits[0].title, 'Bananya', 'the exact normalized title must lead');
  assert.ok(
    hits.some((h) => h.title === 'Bananya and the Curious Bunch'),
    'a prefix match must still be offered - it is often the sequel being looked for'
  );
});

test('searchLibrary never offers an item that cannot be pinned', () => {
  // Every pick is written as an identity override and resolved by id. A library
  // item carrying neither a TVDB nor a TMDB id cannot be pinned at all, so
  // offering it would be a button that silently changes nothing.
  const hits = searchLibrary('Nameless', LIB, FILMS, 10);
  assert.equal(hits.length, 0, 'an id-less library item must never be offered');
});

test('searchLibrary finds films, which carry no precomputed norms', () => {
  // jellyfinFilmIndex is deliberately an id index, not a matchable corpus, so
  // film titles arrive unnormalized - the search has to do that work itself or
  // films are silently unpickable.
  const hits = searchLibrary('echo', LIB, FILMS, 10);
  assert.equal(hits[0].title, 'Echo', 'the exact film title leads');
  assert.equal(hits[0].kind, 'movie');
  assert.equal(hits[0].tmdbId, '550', 'a film is pinned by its TMDB id');
  assert.ok(hits.some((h) => h.title === 'Echoes of a Distant Star'), 'prefix films are offered too');
});

test('searchLibrary matches non-latin titles, and an empty term finds nothing', () => {
  // normalizeTitle keeps letters of every script; reducing to [a-z0-9] once
  // turned a native title into "3" and matched 30 Rock.
  assert.equal(searchLibrary('転生貴族', LIB, FILMS, 10)[0]?.tvdbId, '400001');
  assert.deepEqual(searchLibrary('   ', LIB, FILMS, 10), [], 'a blank term must not list the library');
});

test('searchLibrary honours its limit', () => {
  assert.ok(searchLibrary('a', LIB, FILMS, 2).length <= 2, 'the limit caps what a viewer is shown');
});
