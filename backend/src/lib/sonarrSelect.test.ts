import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectForSonarr,
  selectForSonarrDetailed,
  seasonsForSonarr,
  isFirstSeason,
  isWithinAirWindow,
  usableTvdbId,
  DEFAULT_WITHIN_DAYS,
  type SonarrCandidate,
  type SonarrIdentity,
} from './sonarrSelect';

// The assertion messages here are written as stories on purpose: they become
// the `expect` substrings mutation_audit.py matches on, so a vague one makes
// the audit row grade the wrong failure.

const NOW = new Date('2026-08-06T00:00:00Z');

function entry(over: Partial<SonarrCandidate> & { id: number }): SonarrCandidate {
  return {
    format: 'TV',
    isAdult: false,
    status: 'RELEASING',
    startDate: { year: 2026, month: 7, day: 5 },
    title: { english: `Show ${over.id}`, romaji: null, native: null },
    relations: { edges: [] },
    ...over,
  };
}

/** A resolver backed by a plain id map: a bare string is a clean map row. */
/** A force-include on an entry whose identity is not in doubt. */
function ok(tvdbId: number) {
  return { tvdbId, acknowledgedUnverified: false };
}

function mapResolver(ids: Record<number, string | Partial<SonarrIdentity>>) {
  const none: SonarrIdentity = { tvdbId: null, pending: false, rejected: false };
  return (anilistId: number): SonarrIdentity => {
    const hit = ids[anilistId];
    if (hit === undefined) return none;
    if (typeof hit === 'string') return { tvdbId: hit, pending: false, rejected: false };
    return { ...none, ...hit };
  };
}

test('a season 1 that HAS a sequel is kept - only PREQUEL/PARENT disqualify', () => {
  // Every existing sequel predicate in this repo tests "has any of
  // SEQUEL/PREQUEL/SIDE_STORY", which drops a genuine first season merely for
  // having spawned a sequel. Reusing one of them here would silently shrink the
  // list to shows nobody ever continued.
  const shows = [
    entry({ id: 1, relations: { edges: [{ relationType: 'SEQUEL' }, { relationType: 'ADAPTATION' }] } }),
  ];
  const out = selectForSonarr(shows, mapResolver({ 1: '100' }), NOW);
  assert.deepEqual(
    out,
    [{ title: 'Show 1', tvdbId: 100 }],
    'a first season that later got a sequel must still be auto-added'
  );
});

test('a PREQUEL or PARENT edge means something aired first, so it is dropped', () => {
  const shows = [
    entry({ id: 1, relations: { edges: [{ relationType: 'PREQUEL' }] } }),
    entry({ id: 2, relations: { edges: [{ relationType: 'PARENT' }] } }),
    entry({ id: 3, relations: { edges: [{ relationType: 'ADAPTATION' }, { relationType: 'PARENT' }] } }),
  ];
  const out = selectForSonarr(shows, mapResolver({ 1: '100', 2: '200', 3: '300' }), NOW);
  assert.deepEqual(out, [], 'an entry with a PREQUEL or PARENT relation is not a first season');

  assert.equal(
    isFirstSeason(entry({ id: 9, relations: null })),
    true,
    'no relations block at all is a first season'
  );
  assert.equal(
    isFirstSeason(entry({ id: 9, relations: { edges: [null] } })),
    true,
    'a null relation edge must not throw or disqualify'
  );
});

test('an adult entry is dropped even when the community map has an id for it', () => {
  // The identity sweep skips adult entries, but that skips LOOKUPS - it removes
  // nothing from SeasonCache, and the map answers adult entries directly. So
  // this has to be its own check, not an inherited side effect.
  const shows = [entry({ id: 1, isAdult: true })];
  const out = selectForSonarr(shows, mapResolver({ 1: '100' }), NOW);
  assert.deepEqual(out, [], 'isAdult must be filtered here, not left to the sweep');
});

test('only TV and TV_SHORT are auto-added', () => {
  const shows = [
    entry({ id: 1, format: 'MOVIE' }),
    entry({ id: 2, format: 'OVA' }),
    entry({ id: 3, format: 'SPECIAL' }),
    entry({ id: 4, format: 'ONA' }),
    entry({ id: 5, format: 'TV_SHORT' }),
    entry({ id: 6, format: 'TV' }),
  ];
  const out = selectForSonarr(
    shows,
    mapResolver({ 1: '1', 2: '2', 3: '3', 4: '4', 5: '5', 6: '6' }),
    NOW
  );
  assert.deepEqual(
    out.map((i) => i.tvdbId),
    [5, 6],
    'Sonarr is a TV app: MOVIE, OVA, SPECIAL and ONA must all be excluded'
  );
});

test('a pending identity is dropped, but an unconfirmed community-map row is kept', () => {
  // The exact filter is `tvdbId && !pending && !rejected`. Requiring `confirmed`
  // instead would throw away the ~94% of TV the community map answers, since a
  // map row is unconfirmed by construction.
  const shows = [entry({ id: 1 }), entry({ id: 2 }), entry({ id: 3 })];
  const out = selectForSonarr(
    shows,
    mapResolver({
      1: { tvdbId: '100', pending: true },
      2: { tvdbId: '200', rejected: true },
      3: { tvdbId: '300' }, // an unconfirmed community-map row
    }),
    NOW
  );
  assert.deepEqual(
    out.map((i) => i.tvdbId),
    [300],
    'an unverified guess must not download a season of the wrong series, and an unconfirmed map id must still be used'
  );
});

test('two AniList ids sharing one TVDB id emit a single row', () => {
  // Split cours and seasons of one series share a TVDB id, and resolveIdentity
  // does not dedupe. A duplicate row is a thing Sonarr should never be sent.
  const shows = [entry({ id: 1 }), entry({ id: 2 })];
  const out = selectForSonarr(shows, mapResolver({ 1: '100', 2: '100' }), NOW);
  assert.equal(out.length, 1, 'a tvdbId must appear at most once in the list');
  assert.equal(out[0].tvdbId, 100, 'the first entry carrying the id wins');
});

test('a partial startDate is read as the earliest day it could mean', () => {
  // Same convention as isUnaired() in the frontend. A month-only date must not
  // be read as the end of the month, or a show tips in or out of the window
  // depending on which helper asked.
  const inWindow = entry({
    id: 1,
    status: 'NOT_YET_RELEASED',
    startDate: { year: 2026, month: 8, day: null },
  });
  const outOfWindow = entry({
    id: 2,
    status: 'NOT_YET_RELEASED',
    startDate: { year: 2026, month: 9, day: null },
  });
  const out = selectForSonarr([inWindow, outOfWindow], mapResolver({ 1: '100', 2: '200' }), NOW);
  assert.deepEqual(
    out.map((i) => i.tvdbId),
    [100],
    'a day-less date means the 1st of that month, so 2026-08 is inside a 14-day window from 2026-08-06'
  );
});

test('the air window has no lower bound - a show already airing stays in', () => {
  // The season scoping is the past-side bound. Evicting a show N days into its
  // run would drop exactly the entries whose TVDB id only appears after they
  // premiere, which is the whole reason this list is re-polled and not synced.
  const airingSince = entry({ id: 1, status: 'RELEASING', startDate: { year: 2026, month: 4, day: 2 } });
  assert.equal(
    isWithinAirWindow(airingSince, NOW),
    true,
    'a RELEASING show that started months ago must stay in the list'
  );

  const farFuture = entry({ id: 2, status: 'NOT_YET_RELEASED', startDate: { year: 2026, month: 10, day: 1 } });
  assert.equal(
    isWithinAirWindow(farFuture, NOW),
    false,
    'a premiere beyond the window is not handed to Sonarr yet'
  );
  assert.equal(
    isWithinAirWindow(farFuture, NOW, 60),
    true,
    'widening withinDays must pull the same entry in'
  );
});

test('status is authoritative when present, and an undated future entry is excluded', () => {
  assert.equal(
    isWithinAirWindow(entry({ id: 1, status: 'FINISHED', startDate: null }), NOW),
    true,
    'FINISHED means it aired, whatever the date says'
  );
  assert.equal(
    isWithinAirWindow(entry({ id: 2, status: 'HIATUS', startDate: null }), NOW),
    true,
    'HIATUS aired and paused, so a season 1 exists to grab'
  );
  assert.equal(
    isWithinAirWindow(entry({ id: 3, status: 'CANCELLED', startDate: { year: 2026, month: 1, day: 1 } }), NOW),
    false,
    'CANCELLED must not be rescued by a past start date'
  );
  assert.equal(
    isWithinAirWindow(entry({ id: 4, status: 'NOT_YET_RELEASED', startDate: null }), NOW),
    false,
    'an undated future series has nothing for Sonarr to monitor'
  );
});

test('a tvdbId that is not a positive integer never reaches Sonarr', () => {
  assert.equal(usableTvdbId({ tvdbId: 'abc', pending: false, rejected: false }), null, 'a non-numeric id is refused');
  assert.equal(usableTvdbId({ tvdbId: '0', pending: false, rejected: false }), null, 'zero is not a TVDB id');
  assert.equal(usableTvdbId({ tvdbId: '-5', pending: false, rejected: false }), null, 'a negative id is refused');
  assert.equal(
    usableTvdbId({ tvdbId: '12345', pending: false, rejected: false }),
    12345,
    'a real id is coerced from its stored string form to a number'
  );
  assert.equal(usableTvdbId(null), null, 'no identity at all is not an error');
});

test('the title falls back english -> romaji -> native, and an untitled entry is skipped', () => {
  const shows = [
    entry({ id: 1, title: { english: null, romaji: 'Romaji Only', native: 'ネイティブ' } }),
    entry({ id: 2, title: { english: null, romaji: null, native: 'ネイティブのみ' } }),
    entry({ id: 3, title: { english: '  ', romaji: null, native: null } }),
  ];
  const out = selectForSonarr(shows, mapResolver({ 1: '100', 2: '200', 3: '300' }), NOW);
  assert.deepEqual(
    out,
    [
      { title: 'Romaji Only', tvdbId: 100 },
      { title: 'ネイティブのみ', tvdbId: 200 },
    ],
    'romaji then native fill in for a missing english title, and a blank title is not a row'
  );
});

test('malformed cache rows are skipped rather than thrown on', () => {
  // `shows` is parsed SeasonCache.data - upstream JSON, so any field can be the
  // wrong shape. A throw here would 500 a route Sonarr re-reads every few
  // minutes.
  const out = selectForSonarr(
    [null, 'nonsense', 42, {}, { id: 'not-a-number', format: 'TV' }, entry({ id: 7 })],
    mapResolver({ 7: '700' }),
    NOW
  );
  assert.deepEqual(out, [{ title: 'Show 7', tvdbId: 700 }], 'junk rows are skipped and the good one still lands');
  assert.deepEqual(
    selectForSonarr(undefined as unknown as unknown[], mapResolver({}), NOW),
    [],
    'a non-array input yields an empty list, never a throw'
  );
});

test('every dropped entry reports the gate that stopped it', () => {
  // The dry-run tool is unreviewable without these: "39 proposed" says nothing,
  // "24 dropped on a PREQUEL/PARENT edge" says whether the filter is sane.
  const shows = [
    entry({ id: 1, format: 'MOVIE' }),
    entry({ id: 2, isAdult: true }),
    entry({ id: 3, relations: { edges: [{ relationType: 'PARENT' }] } }),
    entry({ id: 4, status: 'NOT_YET_RELEASED', startDate: { year: 2027, month: 1, day: 1 } }),
    entry({ id: 5 }), // resolver knows nothing about it
    entry({ id: 6 }),
    entry({ id: 7 }), // shares 6's tvdbId
    entry({ id: 8, title: { english: null, romaji: null, native: null } }),
  ];
  const { items, rejected } = selectForSonarrDetailed(
    shows,
    mapResolver({ 1: '1', 2: '2', 3: '3', 4: '4', 6: '600', 7: '600', 8: '800' }),
    NOW
  );
  assert.deepEqual(items.map((i) => i.tvdbId), [600], 'only the one clean entry survives');
  assert.deepEqual(
    rejected.map((r) => r.reason),
    ['format', 'adult', 'notFirstSeason', 'outsideAirWindow', 'noUsableTvdbId', 'duplicateTvdbId', 'noTitle'],
    'each gate must name itself, in the order the gates run'
  );
});

test('a force-include beats every scope gate', () => {
  // This is the only override direction the feature has. If a gate could consume
  // it, the button would appear to work and change nothing.
  //
  // It lifts SCOPE gates only. It cannot re-add something already pushed - that
  // record lives in `sonarrPush.ts` and is deliberately out of reach from here,
  // because "add it once" has to survive an admin clicking Include again.
  const shows = [
    entry({ id: 1, format: 'ONA' }),                                            // dropped on format
    entry({ id: 2, relations: { edges: [{ relationType: 'PREQUEL' }] } }),      // dropped as a sequel
    entry({ id: 3, isAdult: true }),                                            // dropped as adult
  ];
  const out = selectForSonarr(
    shows,
    mapResolver({ 1: '100', 2: '200', 3: '300' }),
    NOW,
    { forceInclude: new Map([[1, ok(100)], [2, ok(200)], [3, ok(300)]]) }
  );
  assert.deepEqual(
    out.map((i) => i.tvdbId),
    [100, 200, 300],
    'a force-include must lift the format gate, the sequel gate and the adult gate alike'
  );
});

test('a force-include still cannot emit a duplicate or an unusable id', () => {
  const shows = [entry({ id: 1 }), entry({ id: 2, format: 'ONA' })];
  const { items, rejected } = selectForSonarrDetailed(
    shows,
    mapResolver({ 1: '100' }),
    NOW,
    { forceInclude: new Map([[2, ok(100)]]) }   // same tvdbId as entry 1
  );
  assert.equal(items.length, 1, 'a force-include is still deduped by tvdbId');
  assert.deepEqual(rejected.map((r) => r.reason), ['duplicateTvdbId'], 'and says so');

  const bad = selectForSonarrDetailed(shows, mapResolver({}), NOW, {
    forceInclude: new Map([[2, ok(0)]]),
  });
  assert.deepEqual(
    bad.rejected.map((r) => r.reason),
    ['noUsableTvdbId', 'noUsableTvdbId'],
    'a force-include carrying a non-positive id is refused like any other'
  );
});

test('seasonsForSonarr returns the calendar season and the next, rolling the year', () => {
  // UTC-constructed dates on purpose: reading the month in local time made
  // 2026-01-01T00:00:00Z resolve to FALL 2025 west of UTC, which is silent in
  // production and only visible for a few hours, four times a year.
  assert.deepEqual(
    seasonsForSonarr(new Date('2026-08-06T00:00:00Z')),
    [
      { season: 'SUMMER', year: 2026 },
      { season: 'FALL', year: 2026 },
    ],
    'August is SUMMER, followed by FALL of the same year'
  );
  assert.deepEqual(
    seasonsForSonarr(new Date('2026-11-20T00:00:00Z')),
    [
      { season: 'FALL', year: 2026 },
      { season: 'WINTER', year: 2027 },
    ],
    'FALL is followed by WINTER of the NEXT year - the one boundary that can be off by a year'
  );
  assert.deepEqual(
    seasonsForSonarr(new Date('2026-01-01T00:00:00Z')),
    [
      { season: 'WINTER', year: 2026 },
      { season: 'SPRING', year: 2026 },
    ],
    'the first instant of January is WINTER of its own year, not the previous FALL'
  );
});

test('DEFAULT_WITHIN_DAYS is not coupled to the site look-ahead', () => {
  // LOOKAHEAD_DAYS (frontend/src/stores/season.ts) is 50 and governs what the
  // site DISPLAYS. If these two ever become one constant, a display tweak
  // changes what gets downloaded.
  assert.equal(
    DEFAULT_WITHIN_DAYS,
    14,
    'the air window is its own constant, deliberately not the display look-ahead'
  );
});

test('a force-include on an UNVERIFIED identity is refused unless acknowledged', () => {
  // The hole this closed: the forced branch never called usableTvdbId, so
  // `tvdbId && !pending && !rejected` did not apply to overrides at all. 22
  // candidates carried a pending identity when this was measured - among them
  // Echo, whose resolver suggestion was a namesake 1,012 days from the entry's
  // premiere. One click grabbed it, silently.
  const shows = [entry({ id: 1, format: 'ONA' })];
  const resolver = mapResolver({ 1: { tvdbId: '100', pending: true } });

  const blind = selectForSonarrDetailed(shows, resolver, NOW, {
    forceInclude: new Map([[1, { tvdbId: 100, acknowledgedUnverified: false }]]),
  });
  assert.deepEqual(blind.items, [], 'an unverified identity must not be force-included blindly');
  assert.deepEqual(
    blind.rejected.map((r) => r.reason),
    ['unverifiedNotAcknowledged'],
    'and the refusal names itself, so the page can ask instead of failing silently'
  );

  const informed = selectForSonarrDetailed(shows, resolver, NOW, {
    forceInclude: new Map([[1, { tvdbId: 100, acknowledgedUnverified: true }]]),
  });
  assert.deepEqual(
    informed.items.map((i) => i.tvdbId),
    [100],
    'an override still wins once someone has been shown what they are overriding'
  );
});

test('a rejected identity is refused the same way as a pending one', () => {
  // `rejected` means an admin said "this is definitively not in the library".
  // Force-including it without acknowledgement would silently undo that.
  const shows = [entry({ id: 1 })];
  const out = selectForSonarrDetailed(shows, mapResolver({ 1: { tvdbId: '100', rejected: true } }), NOW, {
    forceInclude: new Map([[1, { tvdbId: 100, acknowledgedUnverified: false }]]),
  });
  assert.deepEqual(
    out.rejected.map((r) => r.reason),
    ['unverifiedNotAcknowledged'],
    'a rejection is a human decision and must not be overridden without acknowledgement'
  );
});

test('a confident identity needs no acknowledgement', () => {
  // The guard must not become friction on the ordinary case: a community-map id
  // is the most reliable thing we have, and 30 of the 39 current proposals are
  // exactly that.
  const shows = [entry({ id: 1, format: 'ONA' })];
  const out = selectForSonarr(shows, mapResolver({ 1: '100' }), NOW, {
    forceInclude: new Map([[1, { tvdbId: 100, acknowledgedUnverified: false }]]),
  });
  assert.deepEqual(
    out.map((i) => i.tvdbId),
    [100],
    'a settled identity is force-included without ceremony'
  );
});
