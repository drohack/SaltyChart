import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __setMapsForTest, crosswalkIds } from './anilistTvdbMap';

/**
 * The community map stores anilist→tvdb and anilist→tmdb; the cross-walk joins
 * tvdb↔tmdb THROUGH the anilist key. It exists because Jellyfin's remote
 * search returns TMDB ids only on this deployment (measured: all 342 stored
 * resolver candidates), while corrections sometimes arrive as pasted TVDB ids.
 */

test('crosswalkIds joins tvdb→tmdb through the anilist key', () => {
  __setMapsForTest({ '10': '81797' }, { '10': 'tv:37854' });
  const x = crosswalkIds({ tvdbId: '81797' });
  assert.equal(x?.tmdbId, '37854', 'a tvdb id must pick up its tmdb sibling from the map');
  assert.equal(x?.tmdbKind, 'tv');
  assert.equal(x?.tvdbId, '81797');
});

test('crosswalkIds joins tmdb→tvdb, respecting the kind namespace', () => {
  // TMDB numbers films and shows independently — the same NUMBER exists in
  // both namespaces, so the join must never cross them.
  __setMapsForTest({ '20': '5555' }, { '20': 'tv:123', '21': 'movie:123' });
  const tv = crosswalkIds({ tmdbId: '123', tmdbKind: 'tv' });
  assert.equal(tv?.tvdbId, '5555', 'a tmdb tv id must pick up its tvdb sibling');
  const film = crosswalkIds({ tmdbId: '123', tmdbKind: 'movie' });
  assert.equal(film?.tvdbId ?? null, null,
    'the film sharing that number must not inherit the series tvdb id');
});

test('crosswalkIds returns null when the map knows neither id', () => {
  __setMapsForTest({}, {});
  assert.equal(crosswalkIds({ tvdbId: '999' }), null);
  assert.equal(crosswalkIds({ tmdbId: '999', tmdbKind: 'tv' }), null);
});
