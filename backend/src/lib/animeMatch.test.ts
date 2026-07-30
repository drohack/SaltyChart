import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectSeasonNumber,
  expandCandidates,
  matchByTitle,
  matchSeries,
  normalizeTitle,
  type MatchableSeries,
} from './animeMatch';

// Fixtures are taken from the real library, including the cases that actually
// went wrong — see the comments on each.
function series(id: string, title: string, original?: string, tvdbId?: string): MatchableSeries {
  const norms = [normalizeTitle(title)];
  if (original) {
    const n = normalizeTitle(original);
    if (n && !norms.includes(n)) norms.push(n);
  }
  return { id, title, norms, tvdbId };
}

test('normalizeTitle keeps non-latin scripts', () => {
  // Stripping to [a-z0-9] collapsed this to "3", which then matched "30 Rock".
  const n = normalizeTitle('転生貴族、鑑定スキルで成り上がる 第3期');
  assert.ok(n.length > 3, `expected a substantial normalized form, got "${n}"`);
  assert.equal(normalizeTitle('Frieren: Beyond Journey’s End'), 'frierenbeyondjourneysend');
  assert.equal(normalizeTitle('  Spy × Family  '), 'spyfamily');
});

test('expandCandidates strips season suffixes in both scripts', () => {
  assert.ok(expandCandidates(['Mushoku Tensei III']).includes('Mushoku Tensei III'));
  assert.ok(expandCandidates(['Grand Blue Season 3']).includes('Grand Blue'));
  assert.ok(expandCandidates(['Skeleton Knight 2nd Season']).includes('Skeleton Knight'));
  assert.ok(expandCandidates(['ぐらんぶる 第3期']).includes('ぐらんぶる'));
});

test('detectSeasonNumber reads the markers we rely on', () => {
  assert.equal(detectSeasonNumber(['Tensei Kizoku 3rd Season']), 3);
  assert.equal(detectSeasonNumber(['Grand Blue Season 3']), 3);
  assert.equal(detectSeasonNumber(['ぐらんぶる 第3期']), 3);
  assert.equal(detectSeasonNumber(['Sakamoto Days']), null);
  assert.equal(detectSeasonNumber(['Season 99']), null); // out of the 1-50 range
});

test('short normalized titles cannot prefix-match unrelated shows', () => {
  // The original bug: an all-Japanese title normalized to "3" and matched
  // "30 Rock" via the prefix tier.
  const library = [series('1', '30 Rock')];
  const hit = matchByTitle(['第3期'], library);
  assert.equal(hit, null);
});

test('genuine title-only matches still work', () => {
  // Both of these were found ONLY by title in the live library — no usable id
  // mapping exists for them — so the fuzzy tier can never be dropped.
  const library = [
    series('a', 'KAIJU GIRL CARAMELISE'),
    series('b', 'Chainsmoker Cat'),
    series('c', 'Unrelated Show'),
  ];
  // AniList supplies several titles per entry; the romaji one alone does NOT
  // reach the library's English name, which is exactly why all candidates are
  // passed in rather than just the first.
  assert.equal(matchByTitle(['Otome Kaijuu Caramelise'], library), null);
  assert.equal(
    matchByTitle(['Otome Kaijuu Caramelise', 'Kaiju Girl Caramelise'], library)?.series.id,
    'a'
  );
  assert.equal(matchByTitle(['Yani Neko', 'Chainsmoker Cat'], library)?.series.id, 'b');
});

test('exact beats prefix, and the shortest title wins within a tier', () => {
  const library = [
    series('long', "Frieren: Beyond Journey's End"),
    series('short', 'Frieren'),
  ];
  assert.equal(matchByTitle(['Frieren'], library)?.series.id, 'short');
  assert.equal(matchByTitle(['Frieren'], library)?.tier, 0);
});

test('an id match is reported as confirmed', () => {
  const library = [series('jf-1', 'The Apothecary Diaries', undefined, '431162')];
  const r = matchSeries({ tvdbId: '431162', titles: ['Kusuriya no Hitorigoto'] }, library);
  assert.equal(r?.confidence, 'id');
  assert.equal(r?.series.id, 'jf-1');
});

test('a title-only match is reported as unconfirmed — the Nanoha false positive', () => {
  // Real case: AniList's 2026 "Mahou Shoujo Lyrical Nanoha EXCEEDS" matched the
  // library's 2004 "Magical Girl Lyrical Nanoha". The match still happens (we
  // can't tell from titles alone that it's wrong), but it must NOT claim to be
  // id-confirmed, so the UI can mark it and Hide-Not-on-Jellyfin can ignore it.
  const library = [series('old', 'Magical Girl Lyrical Nanoha', undefined, '81115')];
  const r = matchSeries(
    { tvdbId: null, titles: ['Mahou Shoujo Lyrical Nanoha EXCEEDS', '魔法少女リリカルなのは'] },
    library
  );
  assert.notEqual(r?.confidence, 'id');
  if (r) assert.equal(r.confidence, 'title');
});

test('an unmapped id falls through to titles rather than failing', () => {
  const library = [series('x', 'Sakamoto Days', undefined, '999')];
  const r = matchSeries({ tvdbId: '12345', titles: ['Sakamoto Days'] }, library);
  assert.equal(r?.confidence, 'title');
  assert.equal(r?.series.id, 'x');
});

test('nothing in the library means no match, not a wrong one', () => {
  const library = [series('x', 'Completely Different Show')];
  assert.equal(matchSeries({ tvdbId: '371310', titles: ['Mushoku Tensei III'] }, library), null);
});
