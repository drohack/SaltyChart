import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSubtitleReport,
  rowState,
  isBelowChampion,
  modelRank,
  CHAMPION,
  MODEL_RANK,
  type SeasonInput,
  type SeasonEntry,
  type SubtitleRow,
} from './subtitleReport';

// The assertion messages here are written as stories on purpose: they become
// the `expect` substrings mutation_audit.py matches on, so a vague one makes
// the audit row grade the wrong failure.

/** A SubtitleCache row with everything absent, so each test states only what it means. */
function cached(over: Partial<SubtitleRow> = {}): SubtitleRow {
  return {
    videoId: 'vid',
    modelName: null,
    hasEnglishSubs: null,
    hasBurnedInSubs: null,
    subtitlesDisabled: null,
    segmentCount: null,
    lastEnCheckAt: null,
    createdAt: null,
    ...over,
  };
}

function entry(over: Partial<SeasonEntry> & { id: number }): SeasonEntry {
  return {
    title: { english: `Show ${over.id}`, romaji: null, native: null },
    format: 'TV',
    isAdult: false,
    coverImage: { medium: 'cover.jpg' },
    trailer: { id: `v${over.id}`, site: 'youtube' },
    ...over,
  };
}

function season(over: Partial<SeasonInput> = {}): SeasonInput {
  return { season: 'SUMMER', year: 2026, cached: true, entries: [], ...over };
}

// ---------------------------------------------------------------------------
// rowState - one state per video, and the precedence when several are true
// ---------------------------------------------------------------------------

test('a trailer with no SubtitleCache row at all is never, not a zeroed row', () => {
  // The distinction the page is built on: "we have never looked at this" is a
  // different job from "we looked and there was nothing to translate".
  assert.equal(rowState(null), 'never', 'a trailer we have never checked reports never');
});

test('a row that exists but carries no check result still reports never', () => {
  // `PATCH /dismiss` upserts, so turning our subtitles off and on again for a
  // never-checked trailer CREATES a row with `hasEnglishSubs` still null.
  // Calling that "checked, no YouTube CC" is a false claim about work nobody
  // did - and the admin page's own toggle is the fastest way to produce it.
  const state = rowState(cached({ modelName: 'small', hasEnglishSubs: null }));
  assert.equal(state, 'never', 'a row with no English-CC verdict has never been checked');
});

test('checked, no YouTube CC and no segments is the real backlog', () => {
  const state = rowState(cached({ hasEnglishSubs: false, lastEnCheckAt: '2026-08-01T00:00:00Z' }));
  assert.equal(state, 'checkedNoSubs', 'a checked trailer with nothing to show is checkedNoSubs');
});

test('segments present reports translated', () => {
  const state = rowState(cached({ modelName: 'medium', segmentCount: 42 }));
  assert.equal(state, 'translated', 'a trailer with cached segments is translated');
});

test('YouTube English CC outranks our own segments - we never translate those', () => {
  // The misreading this guards: a video with real YouTube CC counted as backlog
  // sends someone re-translating trailers that never needed it. `hasEnglishSubs`
  // is why the pipeline skips it in the first place (openModal path A).
  const state = rowState(cached({ hasEnglishSubs: true, modelName: 'medium', segmentCount: 42 }));
  assert.equal(state, 'youtubeCc', 'a trailer with YouTube English CC reports youtubeCc, not backlog');
});

test('burned-in subs outrank YouTube CC', () => {
  // Hardsubbed is the stronger fact: our overlay defaults off for it regardless
  // of what YouTube also offers.
  const state = rowState(cached({ hasEnglishSubs: true, hasBurnedInSubs: true }));
  assert.equal(state, 'burnedIn', 'a hardsubbed trailer reports burnedIn even with YouTube CC');
});

test('someone turning our subs off outranks every other fact', () => {
  const state = rowState(
    cached({ subtitlesDisabled: true, hasEnglishSubs: true, hasBurnedInSubs: true, segmentCount: 9 })
  );
  assert.equal(state, 'ourSubsOff', 'a dismissed trailer reports ourSubsOff above everything else');
});

// ---------------------------------------------------------------------------
// The model ladder
// ---------------------------------------------------------------------------

test('the champion is the top of the ladder and nothing is below itself', () => {
  assert.equal(CHAMPION, 'large-v3-split', 'the champion pipeline is large-v3-split');
  assert.equal(
    MODEL_RANK[CHAMPION],
    Math.max(...Object.values(MODEL_RANK)),
    'nothing outranks the champion'
  );
  assert.equal(isBelowChampion(CHAMPION), false, 'the champion is not below itself');
});

test('every named model under the champion counts as below it', () => {
  for (const name of ['tiny', 'base', 'small', 'medium', 'large-v2', 'large-v3']) {
    assert.equal(isBelowChampion(name), true, `${name} is below the champion and will be redone`);
  }
});

test('an unknown model name ranks 0, never NaN', () => {
  // A NaN rank makes every comparison false, so an unrecognised model would
  // quietly report as already-at-champion and never be re-translated.
  assert.equal(modelRank('some-future-model'), 0, 'an unknown model ranks 0');
  assert.equal(modelRank(null), 0, 'a null model ranks 0');
  assert.equal(isBelowChampion('some-future-model'), true, 'an unknown model is below the champion');
});

// ---------------------------------------------------------------------------
// buildSubtitleReport
// ---------------------------------------------------------------------------

test('only entries with a YouTube trailer become rows', () => {
  const report = buildSubtitleReport(
    [
      season({
        entries: [
          entry({ id: 1 }),
          entry({ id: 2, trailer: null }),
          entry({ id: 3, trailer: { id: 'x3', site: 'dailymotion' } }),
          entry({ id: 4, trailer: { id: null, site: 'youtube' } }),
        ],
      }),
    ],
    new Map()
  );
  assert.equal(report.rows.length, 1, 'only the YouTube trailer produces a row');
  assert.equal(report.rows[0].mediaId, 1);
  assert.equal(report.seasons[0].entries, 4, 'the season still reports all 4 cached entries');
  assert.equal(report.seasons[0].withTrailer, 1, 'exactly 1 of them has a YouTube trailer');
});

test('two entries sharing one trailer both get a row - videoId is NOT unique', () => {
  // Real data: two SUMMER 2025 entries share YouTube id OszqzmdvIUk. Both are
  // separate works and both belong in the table, so the rows are keyed by
  // mediaId on screen - keying the `{#each}` by videoId threw
  // "Cannot have duplicate keys in a keyed each" and corrupted the render.
  const report = buildSubtitleReport(
    [
      season({
        entries: [
          entry({ id: 1, trailer: { id: 'shared', site: 'youtube' } }),
          entry({ id: 2, trailer: { id: 'shared', site: 'youtube' } }),
        ],
      }),
    ],
    new Map([['shared', cached({ videoId: 'shared', hasEnglishSubs: true })]])
  );
  assert.equal(report.rows.length, 2, 'both entries appear even though they share a trailer');
  assert.deepEqual(report.rows.map((r) => r.mediaId).sort(), [1, 2], 'mediaId is what distinguishes them');
  assert.equal(report.seasons[0].counts.youtubeCc, 2, 'and both are counted');
});

test('a cached-but-empty season reports zeroes rather than throwing', () => {
  // SUMMER 2027 was a real cached-but-empty row. "We asked and there is nothing
  // yet" must not read the same as "we never asked".
  const report = buildSubtitleReport([season({ cached: true, entries: [] })], new Map());
  assert.equal(report.seasons[0].cached, true, 'an empty season is still a cached season');
  assert.equal(report.seasons[0].withTrailer, 0);
  assert.equal(report.seasons[0].counts.never, 0);
});

test('an uncached season is flagged so the page never renders it as zero work', () => {
  const report = buildSubtitleReport([season({ cached: false, entries: [] })], new Map());
  assert.equal(report.seasons[0].cached, false, 'a season with no SeasonCache row reports cached false');
});

test('season counts are the states of that season own rows', () => {
  const report = buildSubtitleReport(
    [
      season({
        entries: [entry({ id: 1 }), entry({ id: 2 }), entry({ id: 3 })],
      }),
    ],
    new Map([
      ['v1', cached({ videoId: 'v1', hasEnglishSubs: true })],
      ['v2', cached({ videoId: 'v2', modelName: 'medium', segmentCount: 5 })],
      // v3 deliberately absent - never checked
    ])
  );
  const c = report.seasons[0].counts;
  assert.equal(c.youtubeCc, 1, '1 trailer has YouTube CC');
  assert.equal(c.translated, 1, '1 trailer is translated');
  assert.equal(c.never, 1, '1 trailer has never been checked');
  assert.equal(report.seasons[0].belowChampion, 1, 'the medium translation is below the champion');
});

test('a below-rank translation counts even when the badge says YouTube CC', () => {
  // `belowChampion` asks "is there a translation a better model would redo",
  // which is independent of which badge won the precedence contest. The local
  // GPU run decides purely on cached segments and model rank
  // (`check_server_cache` in tools/local_translate.py) - it never consults
  // hasEnglishSubs - so gating this on `state === 'translated'` undercounted the
  // per-season totals against the overall figure, which counts every stored
  // translation.
  const report = buildSubtitleReport(
    [season({ entries: [entry({ id: 1 })] })],
    new Map([['v1', cached({ videoId: 'v1', modelName: 'medium', segmentCount: 5, hasEnglishSubs: true })]])
  );
  assert.equal(report.rows[0].state, 'youtubeCc', 'the badge still reports YouTube CC');
  assert.equal(report.rows[0].belowChampion, true, 'but the stored translation is still below our best model');
  assert.equal(report.seasons[0].belowChampion, 1, 'and the season total counts it');
});

test('a champion translation does not count as below the champion', () => {
  const report = buildSubtitleReport(
    [season({ entries: [entry({ id: 1 })] })],
    new Map([['v1', cached({ videoId: 'v1', modelName: CHAMPION, segmentCount: 5 })]])
  );
  assert.equal(report.seasons[0].belowChampion, 0, 'a champion translation is not pending rework');
  assert.equal(report.rows[0].belowChampion, false);
});

test('rows sort actionable-first: never and checkedNoSubs above settled ones', () => {
  // A table that buries the two states a human can act on under a hundred
  // settled rows is how a stalled batch goes unnoticed for a season - the same
  // reason /admin/sonarr lists its failures first.
  const report = buildSubtitleReport(
    [
      season({
        entries: [
          entry({ id: 1, title: { english: 'AAA settled', romaji: null, native: null } }),
          entry({ id: 2, title: { english: 'ZZZ never seen', romaji: null, native: null } }),
          entry({ id: 3, title: { english: 'MMM checked, empty', romaji: null, native: null } }),
        ],
      }),
    ],
    new Map([
      ['v1', cached({ videoId: 'v1', hasEnglishSubs: true })],
      ['v3', cached({ videoId: 'v3', hasEnglishSubs: false })],
    ])
  );
  assert.deepEqual(
    report.rows.map((r) => r.state),
    ['never', 'checkedNoSubs', 'youtubeCc'],
    'never sorts above checkedNoSubs, and both above a settled row'
  );
});

test('below-champion translations sort above settled rows but below the backlog', () => {
  const report = buildSubtitleReport(
    [
      season({
        entries: [entry({ id: 1 }), entry({ id: 2 }), entry({ id: 3 })],
      }),
    ],
    new Map([
      ['v1', cached({ videoId: 'v1', modelName: CHAMPION, segmentCount: 5 })],
      ['v2', cached({ videoId: 'v2', modelName: 'small', segmentCount: 5 })],
      ['v3', cached({ videoId: 'v3', hasEnglishSubs: false })],
    ])
  );
  assert.deepEqual(
    report.rows.map((r) => r.mediaId),
    [3, 2, 1],
    'backlog first, then the below-champion translation, then the settled champion row'
  );
});

test('the season order given is the season order returned', () => {
  // The route passes [current, next]; the page groups by season and must not
  // silently reorder them.
  const report = buildSubtitleReport(
    [
      season({ season: 'SUMMER', year: 2026, entries: [entry({ id: 1 })] }),
      season({ season: 'FALL', year: 2026, entries: [entry({ id: 2 })] }),
    ],
    new Map()
  );
  assert.deepEqual(
    report.seasons.map((s) => `${s.season} ${s.year}`),
    ['SUMMER 2026', 'FALL 2026'],
    'seasons come back in the order they were asked for'
  );
  assert.deepEqual(report.rows.map((r) => r.season), ['SUMMER', 'FALL'], 'rows follow the same order');
});

test('a title falls back through romaji to native rather than rendering blank', () => {
  const report = buildSubtitleReport(
    [
      season({
        entries: [
          entry({ id: 1, title: { english: null, romaji: 'Romaji Only', native: 'Native' } }),
          entry({ id: 2, title: { english: null, romaji: null, native: 'Native Only' } }),
        ],
      }),
    ],
    new Map()
  );
  assert.deepEqual(
    report.rows.map((r) => r.title),
    ['Native Only', 'Romaji Only'],
    'romaji is preferred over native, and neither renders as an empty cell'
  );
});
