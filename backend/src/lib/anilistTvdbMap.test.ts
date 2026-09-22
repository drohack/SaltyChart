import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __setMapsForTest, crosswalkIds, REFRESH_AFTER_MS, refreshDue } from './anilistTvdbMap';
import { MAP_STALE_MS } from './upstreamProbes';

/**
 * The community map stores anilist->tvdb and anilist->tmdb; the cross-walk joins
 * tvdb<->tmdb THROUGH the anilist key. It exists because Jellyfin's remote
 * search returns TMDB ids only on this deployment (measured: all 342 stored
 * resolver candidates), while corrections sometimes arrive as pasted TVDB ids.
 */

test('crosswalkIds joins tvdb->tmdb through the anilist key', () => {
  __setMapsForTest({ '10': '81797' }, { '10': 'tv:37854' });
  const x = crosswalkIds({ tvdbId: '81797' });
  assert.equal(x?.tmdbId, '37854', 'a tvdb id must pick up its tmdb sibling from the map');
  assert.equal(x?.tmdbKind, 'tv');
  assert.equal(x?.tvdbId, '81797');
});

test('crosswalkIds joins tmdb->tvdb, respecting the kind namespace', () => {
  // TMDB numbers films and shows independently - the same NUMBER exists in
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

// ---------------------------------------------------------------------------
// The refresh clock, and why it is not independent of the alarm clock.
//
// 2026-09-22: `/admin/status` mailed "the map is not responding" after two
// failed checks. Upstream was fine - raw.githubusercontent.com answered 200
// with an ETag throughout. What had actually stopped was the *stamp*: the only
// thing that refreshes it on a running server is a 24h in-process
// `setInterval`, and a deploy-on-push server restarts far more often than that
// (nine deploys on 2026-09-21 alone), so the timer never once reached 24h.
//
// Boot could not repair it either, because a refresh only came due at 7 days
// while the probe called the map broken at 2. Between those two numbers sat a
// five-day hole in which nothing refreshed the stamp and the alert stayed lit.
// Every piece was individually correct; only the relationship was wrong, which
// is why this is asserted here rather than left to the next alert.
// ---------------------------------------------------------------------------

test('a refresh comes due before /admin/status calls the map broken', () => {
  assert.ok(
    REFRESH_AFTER_MS < MAP_STALE_MS,
    `a refresh must come due (${REFRESH_AFTER_MS / 3600000}h) before the alarm ` +
      `fires (${MAP_STALE_MS / 3600000}h), or the alarm is guaranteed to win`
  );
  // Worst case is the threshold PLUS one restart interval, because a boot that
  // finds the copy still inside the window deliberately leaves it alone. A
  // deploy-on-push server restarts at least daily, so that sum must still clear
  // the alarm with room to spare.
  const DAY_MS = 24 * 60 * 60 * 1000;
  assert.ok(
    REFRESH_AFTER_MS + DAY_MS <= MAP_STALE_MS,
    `a server restarting daily can reach ${(REFRESH_AFTER_MS + DAY_MS) / 3600000}h ` +
      `of staleness, past the ${MAP_STALE_MS / 3600000}h alarm`
  );
});

test('a backend restarting more often than daily still refreshes the map', () => {
  // The reported failure, replayed. The 24h timer is reset by every restart, so
  // it contributes nothing here; boot is the only chance to refresh and must
  // therefore take it. Ten days of an 8-hourly restart cycle.
  const RESTART_EVERY_MS = 8 * 60 * 60 * 1000;
  let fetchedAt = 0;
  let now = 0;
  let worstStaleness = 0;
  for (let i = 0; i < 30; i++) {
    now += RESTART_EVERY_MS; // the process restarts; the in-process timer resets
    if (refreshDue(fetchedAt, now)) fetchedAt = now;
    worstStaleness = Math.max(worstStaleness, now - fetchedAt);
  }
  assert.ok(
    worstStaleness < MAP_STALE_MS,
    `the stamp reached ${Math.round(worstStaleness / 3600000)}h of staleness, past ` +
      `the ${MAP_STALE_MS / 3600000}h alarm - restarts alone never refreshed it`
  );
});
