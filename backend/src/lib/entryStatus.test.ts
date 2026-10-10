import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  identityStatus,
  sonarrFindings,
  combine,
  isWanted,
  isUnaired,
  needsAttention,
  NOT_WATCHABLE_CODES,
  watchable,
  type IdentityFacts,
  type SonarrFacts,
  type Finding,
} from './entryStatus';

// Assertion messages are written as stories on purpose: they become the
// `expect` substrings mutation_audit.py matches on.

const NOW = Date.UTC(2026, 9, 10);
const DAY = 86_400_000;

const facts = (over: Partial<IdentityFacts> = {}): IdentityFacts => ({
  grade: 'map', confirmed: false, rejected: false, pending: false, hasId: true, note: null, ...over,
});

const sonarr = (over: Partial<SonarrFacts> = {}): SonarrFacts => ({
  wanted: true, unaired: false, startMs: NOW - 10 * DAY, sonarrHeld: true, sonarrFiles: 5, inJellyfin: true,
  availability: { available: true, english: 'fullEng' }, ...over,
});

const ok: Finding = { level: 'ok', code: 'matched', text: 'Community-map id' };

/** The full pipeline the report runs for one row. */
function statusOf(id: IdentityFacts, s: SonarrFacts, waiting = false) {
  const identity = identityStatus(id);
  return combine([...sonarrFindings(s, identity), identity], waiting);
}

test('identity: every rung lands on the level its result deserves', () => {
  assert.equal(identityStatus(facts()).level, 'ok', 'a community-map id is ok');
  assert.equal(identityStatus(facts({ grade: 'dateVerified', note: 'remote: air date 2d' })).level, 'ok', 'a date-verified auto-match is ok');
  assert.equal(identityStatus(facts({ confirmed: true, grade: 'confirmed' })).level, 'ok', 'a human-confirmed match is ok');
  assert.equal(identityStatus(facts({ rejected: true, hasId: false })).code, 'rejectedByHand', 'a Reject reads as a decision');
  assert.equal(identityStatus(facts({ grade: 'viewerPick', note: 'viewer: picked by x' })).code, 'viewerPick', 'a viewer pick needs a look');
  assert.equal(identityStatus(facts({ pending: true, grade: 'weak' })).code, 'guess', 'a pending id is a guess');
  assert.equal(
    identityStatus(facts({ candidates: [{}, {}, {}], settledByDate: false })).code, 'ambiguous',
    'several candidates the date cannot separate are ambiguous'
  );
  assert.equal(
    identityStatus(facts({ candidates: [{}, {}], settledByDate: true })).level, 'ok',
    'candidates the premiere date separated need nobody'
  );
  assert.equal(identityStatus(facts({ hasId: false, titleOnly: true, grade: 'none' })).code, 'titleOnly', 'a title-only match is a check');
});

test('an unconfirmed auto-match (release year / exact title) is yellow, never green', () => {
  for (const note of ['remote: release year 2026', 'remote: exact title', 'remote: unverified']) {
    const s = identityStatus(facts({ grade: 'weak', note }));
    assert.equal(s.level, 'check', `an auto-match on "${note}" must be a check - nothing dated it`);
    assert.equal(s.code, 'unconfirmedAuto');
  }
});

test('no id at all is broken, whatever the format', () => {
  // Colour means result: a film with no id is as red as a TV show with no id.
  // The format is not even an input.
  const s = identityStatus(facts({ hasId: false, grade: 'none' }));
  assert.equal(s.level, 'broken', 'an entry with no id must read as broken');
  assert.equal(s.code, 'noId');
});

test('waiting softens id problems only outside the air window', () => {
  const noId = identityStatus(facts({ hasId: false, grade: 'none' }));
  assert.equal(combine([noId], true).level, 'waiting', 'a far-off premiere with no id yet is waiting, not broken');
  assert.equal(combine([noId], false).level, 'broken', 'inside the air window a missing id is broken - Sonarr would act now');
  const failed: Finding = { level: 'broken', code: 'addFailed', text: 'x' };
  assert.equal(combine([failed], true).level, 'broken', 'waiting never hides a real failure');
});

test('combine: the worst finding wins and the rest are kept', () => {
  const s = combine([ok, { level: 'check', code: 'someNoEnglish', text: 'a' }, { level: 'broken', code: 'noVideo', text: 'b' }], false);
  assert.equal(s.code, 'noVideo', 'the worst finding must be the headline');
  assert.deepEqual(s.also?.map((f) => f.code), ['someNoEnglish'], 'the other problem is kept beside it, ok ones dropped');
  assert.equal(combine([{ level: 'ok', code: 'pushedAlready', text: 'Added by us' }, ok], false).code, 'pushedAlready',
    'with nothing wrong, the first (Sonarr) finding names the row');
});

test('a Sonarr rejection or failed add is broken, unless a re-match superseded it', () => {
  const push = { status: 'lookupFailed', tvdbId: 9, lastError: 'not found', superseded: false };
  const missing = { availability: { available: false } };
  const rejected = statusOf(facts(), sonarr({ ...missing, push, proposedState: 'lookupFailed' }));
  assert.equal(rejected.code, 'sonarrRejected', 'an open lookup failure must be named');
  assert.equal(rejected.level, 'broken', 'an open lookup failure on a show nobody can watch must be broken');
  assert.equal(statusOf(facts(), sonarr({ ...missing, push: { ...push, status: 'failed' } })).code, 'addFailed', 'an open add failure must be broken');
  assert.equal(statusOf(facts(), sonarr({ push, proposedState: 'lookupFailed' })).level, 'check',
    'a Sonarr failure on a show the library already plays is a loose end, not red');
  assert.equal(statusOf(facts(), sonarr({ push: { ...push, superseded: true }, proposedState: 'pushedAlready' })).level, 'ok',
    'a superseded failure is history, not a problem');
});

test('aired, wanted and no video in Sonarr is broken', () => {
  const missing = { available: false };
  const notHeld = statusOf(facts(), sonarr({ availability: missing, sonarrHeld: false, sonarrFiles: null, proposedState: 'willBeAdded' }));
  assert.equal(notHeld.code, 'noVideo', 'an aired wanted show Sonarr does not hold must be broken (noVideo)');
  assert.match(notHeld.text, /Add now/);
  const empty = statusOf(facts(), sonarr({ availability: missing, sonarrFiles: 0, proposedState: 'addedByUs' }));
  assert.equal(empty.code, 'noVideo', 'an aired wanted show with 0 files must be broken (noVideo)');
  const gone = statusOf(facts(), sonarr({ availability: missing, sonarrHeld: false, sonarrFiles: null, proposedState: 'pushedAlready' }));
  assert.match(gone.text, /no longer has it/, 'a show we added and someone deleted says so rather than "press Add now"');
  const unaired = statusOf(facts(), sonarr({ unaired: true, availability: null, sonarrHeld: false, sonarrFiles: null, proposedState: 'willBeAdded' }));
  assert.equal(unaired.level, 'ok', 'before the premiere nothing is missing');
  const unwanted = statusOf(facts(), sonarr({ wanted: false, availability: missing, sonarrHeld: false, sonarrFiles: null, rejectedReason: 'notFirstSeason', skipReason: 'Not auto-added: a sequel' }));
  assert.equal(unwanted.code, 'notInLibrary', 'an unwanted show is not "missing from Sonarr" - it is just not in the library');
});

test('Sonarr has files but Jellyfin does not have the show', () => {
  const s = statusOf(facts(), sonarr({ availability: { available: false }, sonarrFiles: 4, inJellyfin: false, proposedState: 'addedByUs' }));
  assert.equal(s.code, 'notInJellyfin', 'files in Sonarr with no Jellyfin series must say Refresh Jellyfin');
});

test('English is judged on the episode Randomize plays', () => {
  const none = statusOf(facts(), sonarr({ availability: { available: true, english: 'none', seasonNumber: 1, episodeNumber: 1 } }));
  assert.equal(none.code, 'noEnglish', 'episode 1 with no English must be broken - Randomize hides it');
  assert.match(none.text, /S1E1/);
  const signs = statusOf(facts(), sonarr({ availability: { available: true, english: 'signsOnly' } }));
  assert.equal(signs.code, 'noEnglish', 'signs-only is not English dialogue');
  const later = statusOf(facts(), sonarr({ availability: { available: true, english: 'fullEng' }, english: { label: 'subs 10/12', ok: false } }));
  assert.equal(later.level, 'check', 'later episodes without English are a check - Randomize plays episode 1, which is fine');
  assert.equal(later.code, 'someNoEnglish');
  const dub = statusOf(facts(), sonarr({ availability: { available: true, english: 'engAudio' } }));
  assert.equal(dub.level, 'ok', 'a dub is English');
});

test('a verdict that could not be asked is never "missing"', () => {
  const s = statusOf(facts(), sonarr({ availability: { available: false, unknown: true }, proposedState: 'addedByUs' }));
  assert.equal(s.level, 'ok', "unknown means couldn't ask, never not-in-library");
});

test('watchable is exactly the Randomize rule', () => {
  assert.equal(watchable({ unaired: true, availability: { available: false } }), null, 'unaired is not asked');
  assert.equal(watchable({ unaired: false, availability: { available: false, unknown: true } }), null, 'unknown is not missing');
  assert.equal(watchable({ unaired: false, availability: { available: false } }), false, 'definitely absent is not watchable');
  assert.equal(watchable({ unaired: false, availability: { available: true, english: 'signsOnly' } }), false, 'signs-only is not watchable');
  assert.equal(watchable({ unaired: false, availability: { available: true, english: 'engAudio' } }), true, 'a dub is watchable');
  assert.equal(watchable({ unaired: false, availability: { available: true } }), true, 'a verdict without the english field keeps the show, as Randomize does');
});

test('every code Randomize hides is broken, and every broken availability code is one Randomize hides', () => {
  // The 1:1 with Hide Not English: a row is hidden there exactly when it is
  // broken here with one of these codes.
  const cases: Array<[string, Finding]> = [
    ['noVideo', statusOf(facts(), sonarr({ availability: { available: false }, sonarrHeld: false, sonarrFiles: null }))],
    ['notInJellyfin', statusOf(facts(), sonarr({ availability: { available: false }, sonarrFiles: 3, inJellyfin: false }))],
    ['notInLibrary', statusOf(facts(), sonarr({ availability: { available: false } }))],
    ['noEnglish', statusOf(facts(), sonarr({ availability: { available: true, english: 'none' } }))],
    ['noId', statusOf(facts({ hasId: false, grade: 'none' }), sonarr({ availability: { available: false }, tvdbId: null, sonarrHeld: false }))],
  ];
  for (const [code, s] of cases) {
    assert.equal(s.code, code);
    assert.equal(s.level, 'broken', `${code} must be broken`);
    assert.ok(NOT_WATCHABLE_CODES.has(code), `${code} must be one Randomize hides`);
  }
});

test('wanted: the rules, a trusted list, or an Include - never a rule-skipped show', () => {
  assert.equal(isWanted({ proposed: true }), true, 'a proposed show is wanted');
  for (const reason of ['outsideAirWindow', 'noUsableTvdbId', 'unverifiedNotAcknowledged', 'duplicateTvdbId']) {
    assert.equal(isWanted({ proposed: false, rejectedReason: reason }), true, `${reason} comes after every rule gate, so it is wanted`);
  }
  for (const reason of ['format', 'adult', 'notFirstSeason', 'malformed']) {
    assert.equal(isWanted({ proposed: false, rejectedReason: reason }), false, `a ${reason} skip is not wanted - it must stay out of Needs attention`);
  }
  assert.equal(isWanted({ proposed: false, rejectedReason: 'notFirstSeason', listedBy: 1 }), true, 'a listed sequel is wanted');
  assert.equal(isWanted({ proposed: false, rejectedReason: 'format', forced: true }), true, 'an Included film is wanted');
  assert.equal(isWanted({ proposed: true, identityRejected: true }), false, 'a show marked not-in-library is never wanted');
});

test('Needs attention = wanted and broken or check', () => {
  assert.equal(needsAttention({ level: 'broken' }, true), true);
  assert.equal(needsAttention({ level: 'check' }, true), true);
  assert.equal(needsAttention({ level: 'broken' }, false), false, 'a problem on an unwanted show is not in Needs attention');
  assert.equal(needsAttention({ level: 'waiting' }, true), false);
  assert.equal(needsAttention({ level: 'ok' }, true), false);
});

test('isUnaired mirrors the frontend rule', () => {
  assert.equal(isUnaired({ status: 'NOT_YET_RELEASED', startDate: { year: 2020 } }, NOW), true, 'status wins over the date');
  assert.equal(isUnaired({ status: 'RELEASING' }, NOW), false);
  assert.equal(isUnaired({ startDate: { year: 2026, month: 11 } }, NOW), true, 'a partial future date is unaired');
  assert.equal(isUnaired({ startDate: { year: 2026, month: 10 } }, NOW), false, 'a partial date reads as its earliest day');
  assert.equal(isUnaired({}, NOW), false, 'no evidence is not unaired');
});
