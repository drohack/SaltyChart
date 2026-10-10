import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  auditSeries,
  classifyJellyfin,
  classifySonarr,
  fileName,
  isSignsOnly,
  type JellyfinStream,
  type SonarrEpisodeLite,
  type JellyfinEpisodeLite,
} from './libraryAudit';
import { decideStart, seriesToRefresh, totalsOf, VISIT_INTERVAL_MS, type LibraryRow } from './libraryCheck';

// Assertion messages are written as stories on purpose: they become the
// `expect` substrings mutation_audit.py matches on.

const sub = (title: string | null, extra: Partial<JellyfinStream> = {}): JellyfinStream => ({
  type: 'Subtitle',
  language: 'eng',
  title,
  displayTitle: null,
  isForced: false,
  ...extra,
});
const VIDEO: JellyfinStream = { type: 'Video' };
const JPN_AUDIO: JellyfinStream = { type: 'Audio', language: 'jpn' };

test('every English track title measured in the library on 2026-10-09 classifies correctly', () => {
  // Signs and songs only - what a dual-audio release ships for its dub.
  for (const t of ['Forced', 'Forced (Signs only)', 'Signs | Forced', 'English (forced)']) {
    assert.equal(
      isSignsOnly(sub(t), false),
      true,
      `"${t}" is a signs-only track; counting it as subbed hid a raw behind a signs track`
    );
  }
  assert.equal(
    isSignsOnly(sub('English', { isForced: true }), true),
    true,
    'a forced English track in a dual-audio file is the signs for the dub'
  );
  // SKYANiME flags its only English track forced, and it is full dialogue: 346
  // lines on Iron Wok Jan S01E06, as many as the Arabic track beside it.
  for (const t of ['English', 'English (United States)']) {
    assert.equal(
      isSignsOnly(sub(t, { isForced: true, displayTitle: `${t} - Default - Forced - ASS` }), false),
      false,
      `a forced "${t}" track in a Japanese-audio-only file is full dialogue - the flag alone is not signs-only`
    );
  }
  // Full dialogue tracks, including the one that names signs AND dialogue.
  for (const t of [
    'English [Dialogue, Signs & Song (CicakRumah)]',
    'SDH',
    'Dubtitle',
    'Dubtitle (SDH)',
    'Honorific',
    'CR_English',
    'CR',
    '',
    'English (CC)',
  ]) {
    assert.equal(isSignsOnly(sub(t), false), false, `"${t}" carries dialogue and must count as subbed`);
  }
});

test('a file with only a forced English track is signsOnly, not subbed', () => {
  assert.equal(
    classifyJellyfin([VIDEO, JPN_AUDIO, sub('Forced', { isForced: true })]),
    'signsOnly',
    'a forced-only English track was counted as full subtitles'
  );
  assert.equal(
    classifyJellyfin([VIDEO, JPN_AUDIO, { type: 'Audio', language: 'eng' }, sub('English', { isForced: true })]),
    'signsOnly',
    'a dual-audio file whose only English subtitle is the forced signs track was counted as subbed'
  );
  assert.equal(
    classifyJellyfin([VIDEO, JPN_AUDIO, sub('English', { isForced: true })]),
    'fullEng',
    'the SKYANiME shape - one forced English track, Japanese audio - is fully subbed'
  );
  assert.equal(
    classifyJellyfin([VIDEO, JPN_AUDIO, sub('Forced', { isForced: true }), sub('')]),
    'fullEng',
    'a release with a forced track AND a dialogue track is subbed'
  );
});

test('Jellyfin classification: raws, dubs, and files nobody has probed', () => {
  assert.equal(classifyJellyfin([VIDEO, JPN_AUDIO]), 'none', 'a raw with no subtitle tracks is none');
  assert.equal(
    classifyJellyfin([VIDEO, JPN_AUDIO, { type: 'Subtitle', language: 'jpn', title: 'SDH' }]),
    'none',
    'Japanese-only subtitles are not English subtitles'
  );
  assert.equal(
    classifyJellyfin([VIDEO, { type: 'Audio', language: 'eng' }]),
    'engAudio',
    'English audio with no English subs is engAudio'
  );
  assert.equal(classifyJellyfin([]), 'unknown', 'no streams at all means not probed, which is never subbed');
  assert.equal(
    classifyJellyfin([VIDEO, { type: 'Subtitle', language: null, title: 'English subs' }]),
    'fullEng',
    'an untagged track titled English counts, as the player already picks it'
  );
});

test('Sonarr classification reads its language codes, and missing media info is unknown', () => {
  const f = (subtitles: string | null, audioLanguages: string | null) => ({
    path: '/x.mkv',
    releaseGroup: null,
    quality: null,
    subtitles,
    audioLanguages,
  });
  assert.equal(classifySonarr(f('', 'jpn')), 'none', 'an empty subtitles string is a file with no subtitle tracks');
  assert.equal(classifySonarr(f('eng/ara/ger', 'jpn')), 'fullEng', 'eng among the codes is subbed');
  assert.equal(classifySonarr(f('', 'jpn/eng')), 'engAudio', 'English audio and no subs is engAudio');
  assert.equal(classifySonarr(f(null, null)), 'unknown', 'unanalysed media info must not read as no subtitles');
});

test('fileName takes the last segment for either separator', () => {
  assert.equal(fileName('/media/Anime/Show/Season 01/Show - S01E01.mkv'), 'Show - S01E01.mkv');
  assert.equal(fileName('D:\\Anime\\Show - S01E01.mkv'), 'Show - S01E01.mkv');
  assert.equal(fileName(null), '');
});

const ep = (n: number, path: string | null, subtitles = 'eng'): SonarrEpisodeLite => ({
  seasonNumber: 1,
  episodeNumber: n,
  title: `Episode ${n}`,
  file: path
    ? { path, releaseGroup: 'Grp', quality: 'WEBDL-1080p', audioLanguages: 'jpn', subtitles }
    : null,
});
const jf = (path: string, streams: JellyfinStream[] = [VIDEO, JPN_AUDIO, sub('')]): JellyfinEpisodeLite => ({
  path,
  streams,
});

test('staleness is decided by file name, not episode number', () => {
  // Sonarr and Jellyfin mount the same share at different roots, and a
  // multi-episode file is one Jellyfin item: a per-episode comparison flagged
  // dozens of healthy series as stale.
  const sonarr = [ep(7, '/media/Anime/S/S01E07-08.mkv'), ep(8, '/media/Anime/S/S01E07-08.mkv')];
  const audit = auditSeries(sonarr, [jf('/data/anime/S/S01E07-08.mkv')]);
  assert.equal(audit.stale, 0, 'a multi-episode file Jellyfin holds was reported stale');
  assert.equal(audit.state, 'allSubbed');
});

test('a file Sonarr replaced and Jellyfin has not seen is stale', () => {
  const audit = auditSeries(
    [ep(1, '/media/Anime/P/P - S01E01 - CicakRumah.mkv'), ep(2, '/media/Anime/P/P - S01E02.mkv')],
    [jf('/data/anime/P/P - S01E01 - ToonsHub.mkv'), jf('/data/anime/P/P - S01E02.mkv')]
  );
  assert.equal(audit.stale, 1, 'the PANDOROBO case: Jellyfin still naming the deleted ToonsHub file must be stale');
  assert.equal(audit.state, 'stale', 'a stale series sorts first because a button here fixes it');
  assert.deepEqual(audit.problems.map((p) => [p.episode, p.stale]), [[1, true]]);
});

test('an episode with no file is neither counted nor stale', () => {
  const audit = auditSeries([ep(1, '/m/a.mkv'), ep(2, null)], [jf('/d/a.mkv')]);
  assert.equal(audit.episodes, 1, 'an episode Sonarr has no file for was counted');
  assert.equal(audit.stale, 0);
});

test('without a Jellyfin match, Sonarr codes decide and nothing is stale', () => {
  const audit = auditSeries([ep(1, '/m/a.mkv', ''), ep(2, '/m/b.mkv')], null);
  assert.equal(audit.source, 'sonarr');
  assert.equal(audit.stale, 0, 'with nothing to compare against, nothing can be called stale');
  assert.equal(audit.counts.none, 1);
  assert.equal(audit.state, 'missing');
});

test('series state: missing beats unknown, and unknown is never allSubbed', () => {
  const unknownOnly = auditSeries([ep(1, '/m/a.mkv')], [jf('/d/a.mkv', [])]);
  assert.equal(unknownOnly.state, 'unknown', 'an unprobed file rolled up as allSubbed');
  const signs = auditSeries(
    [ep(1, '/m/a.mkv'), ep(2, '/m/b.mkv')],
    [jf('/d/a.mkv', []), jf('/d/b.mkv', [VIDEO, JPN_AUDIO, sub('Forced', { isForced: true })])]
  );
  assert.equal(signs.state, 'missing', 'a signs-only episode makes the series missing');
  assert.equal(signs.counts.signsOnly, 1);
});

test('a Randomize visit starts at most one check per interval; an admin is never throttled', () => {
  const t0 = 1_000_000;
  assert.equal(decideStart('visit', false, null, t0), 'start');
  assert.equal(
    decideStart('visit', false, t0, t0 + VISIT_INTERVAL_MS - 1),
    'throttled',
    'a second visit inside the interval started another check'
  );
  assert.equal(decideStart('visit', false, t0, t0 + VISIT_INTERVAL_MS), 'start');
  assert.equal(decideStart('admin', false, t0, t0 + 1), 'start', 'the admin button was throttled');
  assert.equal(decideStart('admin', true, t0, t0 + 1), 'running', 'two checks ran at once');
});

const row = (title: string, state: LibraryRow['state'], jellyfinId: string | null): LibraryRow => ({
  sonarrId: 1,
  tvdbId: 1,
  title,
  titleSlug: null,
  qualityProfileId: 12,
  jellyfinId,
  state,
});

test('only stale series Jellyfin holds are refreshed', () => {
  const picked = seriesToRefresh([
    row('Stale', 'stale', 'jf1'),
    row('Missing subs', 'missing', 'jf2'),
    row('Fine', 'allSubbed', 'jf3'),
    row('Stale but unmatched', 'stale', null),
  ]);
  assert.deepEqual(
    picked.map((p) => p.title),
    ['Stale'],
    'a series whose files did not change was refreshed - that is a library scan by another name'
  );
});

test('totals add up across rows and count Sonarr-only rows as unmatched', () => {
  const a = auditSeries([ep(1, '/m/a.mkv', ''), ep(2, '/m/b.mkv')], null);
  const b = auditSeries([ep(1, '/m/c.mkv')], [jf('/d/old.mkv')]);
  const t = totalsOf([
    { ...row('A', a.state, null), audit: a },
    { ...row('B', b.state, 'jf'), audit: b },
    row('C', 'error', 'jf'),
  ]);
  assert.equal(t.episodes, 3);
  assert.equal(t.stale, 1);
  assert.equal(t.seriesStale, 1);
  assert.equal(t.seriesMissing, 1);
  assert.equal(t.unmatched, 1);
  assert.equal(t.errors, 1, 'a series Sonarr did not answer for vanished from the totals');
});
