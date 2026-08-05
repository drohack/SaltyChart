import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyMatch,
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

test('a title inside a longer, different title is not a match', () => {
  // Every one of these is a real pair the removed contains-anywhere tier
  // produced against the live library — 9 fired across 6 seasons (696 shows)
  // and all 9 were wrong. They are kept as fixtures because the tier looked
  // reasonable in isolation and the temptation is to bring it back with a
  // higher threshold; the *Four Seasons* pair sat at exactly the old 0.4 floor,
  // so no threshold separates these from the ones that looked plausible.
  const library = [
    series('fs', 'The Four Seasons (2025)'), // live-action comedy
    series('rg', 'Ragnarok'), // Norwegian drama, not Record of Ragnarok
    series('tk', 'The 10th Kingdom'), // 2000 miniseries
    series('op', 'One Piece'),
  ];
  for (const cand of [
    'Agents of the Four Seasons: Dance of Spring',
    'Record of Ragnarok III',
    'Kingdom Season 6',
    'Koisuru ONE PIECE',
  ]) {
    assert.equal(matchByTitle([cand], library), null, `"${cand}" should not match anything`);
  }
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

test('a known id that the library lacks is the ANSWER, not a reason to guess', () => {
  // This test asserted the opposite until the corpus was measured: an id miss
  // used to fall through to titles. That fallback was the entire remaining
  // false-positive class — 12 of 945 entries, every one of them a new work
  // matched onto its franchise parent, and every one of them carrying an id the
  // library did not have. We knew the answer and overwrote it with a guess.
  const library = [series('x', 'Sakamoto Days', undefined, '999')];
  assert.equal(
    matchSeries({ tvdbId: '12345', titles: ['Sakamoto Days'] }, library),
    null,
    'an id we hold must not be overridden by a title that happens to look close'
  );
  // …but only when we actually have an id. With none, titles are all we have
  // and they resolve 65 corpus entries nothing else could reach.
  assert.equal(matchSeries({ titles: ['Sakamoto Days'] }, library)?.confidence, 'title');
});

test('a guessed id is positive-only — it must not suppress a working title match', () => {
  // The remote resolver hands us TMDB search results, which are guesses. Those
  // may ADD a match and must never remove one, because the entries it touches
  // are exactly the ones that resolve by title today: granting a guess negative
  // evidence would let it delete a working Watch button.
  const library = [series('a', 'Mebius Dust', undefined, '111')];
  const guessed = { tvdbId: '999999', titles: ['Mebius Dust'], idIsAuthoritative: false };
  assert.equal(
    matchSeries(guessed, library)?.confidence,
    'title',
    'a resolver guess that misses must fall through to titles'
  );
  // The same miss from the community map DOES end the lookup — that is the rule
  // that removed 11 wrong matches, and it stays.
  assert.equal(matchSeries({ tvdbId: '999999', titles: ['Mebius Dust'] }, library), null);
});

test('the franchise-sibling class — real pairs that used to resolve wrongly', () => {
  // Every pair below was produced against the live library. In each case the
  // AniList entry has a TVDB id, the library does not hold that id, and the
  // title tier matched the parent series anyway. Pokémon Concierge resolved to
  // *episode 109 of season 20* of Pokémon.
  //
  // These are fixtures rather than a synthetic case because the shape is not
  // guessable: "BLEACH: Thousand-Year Blood War" is a CORRECT match of exactly
  // the same form, so nothing about the strings distinguishes them.
  const library = [
    series('pk', 'Pokémon', undefined, '12345'),
    series('sao', 'Sword Art Online', undefined, '23456'),
    series('7ds', 'The Seven Deadly Sins', undefined, '34567'),
    series('nan', 'Magical Girl Lyrical Nanoha', undefined, '81115'),
    series('tf', 'Thunderbolt Fantasy', undefined, '45678'),
  ];
  const cases: [string, string][] = [
    ['Pokémon Concierge: Season 1: Part 2', '99001'],
    ['Sword Art Online Alternative: Gun Gale Online', '99002'],
    ['The Seven Deadly Sins: Four Knights of the Apocalypse', '99003'],
    ['Magical Girl Lyrical Nanoha EXCEEDS Gun Blaze', '458309'],
    ['Thunderbolt Fantasy: Touriken Yuuki 4', '99005'],
  ];
  for (const [title, tvdbId] of cases)
    assert.equal(matchSeries({ tvdbId, titles: [title] }, library), null, `"${title}" must not match`);
});

test('a tmdb id resolves when tvdb is absent — the movie case', () => {
  // TVDB is a TV database: it covers 4 of 117 corpus movies against TMDB's 43.
  const lib: MatchableSeries[] = [
    { id: 'mv', title: 'Some Anime Film', norms: [normalizeTitle('Some Anime Film')], tmdbId: '778899' },
  ];
  assert.equal(matchSeries({ tmdbId: '778899', titles: ['Totally Different Name'] }, lib)?.confidence, 'id');
  // And the negative rule applies to tmdb too.
  assert.equal(matchSeries({ tmdbId: '111', titles: ['Some Anime Film'] }, lib), null);
});

test('nothing in the library means no match, not a wrong one', () => {
  const library = [series('x', 'Completely Different Show')];
  assert.equal(matchSeries({ tvdbId: '371310', titles: ['Mushoku Tensei III'] }, library), null);
});

test('classifyMatch partitions entries the way the admin panel reports them', () => {
  // One definition shared by the per-season view and the all-seasons sweep
  // tally. Before it existed the two were computed from different sources, so
  // the panel's two rows could disagree and neither could be checked against
  // the other.
  const library: MatchableSeries[] = [
    { id: 'lib-1', title: 'Bananya', norms: [normalizeTitle('Bananya')], tvdbId: '313676' },
    { id: 'lib-2', title: 'One Piece', norms: [normalizeTitle('One Piece')], tvdbId: '81797' },
  ];
  const heldFilms = new Set(['550']); // one film we hold, by TMDB id

  assert.equal(
    classifyMatch({ tvdbId: '313676', titles: ['Bananya'] }, library, heldFilms), 'id',
    'a known id the library carries is the id tier');
  assert.equal(
    classifyMatch({ tvdbId: '999999', titles: ['Bananya'] }, library, heldFilms), 'notHeld',
    'an authoritative id the library lacks is NOT in the library — it must not fall through to titles');
  assert.equal(
    classifyMatch({ titles: ['One Piece'] }, library, heldFilms), 'title',
    'no id at all still matches by title — 65 corpus entries resolve only this way');
  assert.equal(
    classifyMatch({ titles: ['Nothing Like This Exists'] }, library, heldFilms), 'noMatch',
    'nothing found by id or title is its own bucket, not "not in library"');
  assert.equal(
    classifyMatch({ tvdbId: '313676', titles: ['Bananya'], rejected: true }, library, heldFilms),
    'notHeld',
    'a human rejection short-circuits before matching, exactly as availability does');
  // The dangerous one first, deliberately: both film assertions break together
  // if the film branch goes, and whichever fires first is what the mutation
  // audit reads. It must name the category error, not the happy path.
  assert.equal(
    classifyMatch({ tmdbId: '551', tmdbKind: 'movie', titles: ['One Piece'] }, library, heldFilms),
    'notHeld',
    'an unheld film must NOT title-match the series list — that is the House category error');
  assert.equal(
    classifyMatch({ tmdbId: '550', tmdbKind: 'movie', titles: ['Some Film'] }, library, heldFilms),
    'id',
    'a held film resolves by its TMDB id through the film index');
});
