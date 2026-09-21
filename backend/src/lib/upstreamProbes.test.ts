import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROBES, missingProbes, orphanProbes, parseFetchedAt, probeDue } from './upstreamProbes';
import {
  CONFIRM_RETRY_MS,
  EMPTY_RECORD,
  UPSTREAMS,
  upstreamById,
  type UpstreamRecord,
  type UpstreamSpec,
} from './upstreamHealth';

const NOW = Date.UTC(2026, 8, 20, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const rec = (over: Partial<UpstreamRecord> = {}): UpstreamRecord => ({ ...EMPTY_RECORD, ...over });
const skyhook = () => upstreamById('skyhook') as UpstreamSpec;

test('a healthy third-party API is probed once a day, not more', () => {
  // An API changes on a release cadence - weeks or months - so probing hourly
  // would monitor 24x faster than the event ever happens, against someone
  // else's free service. Daily is the honest rate.
  assert.equal(probeDue(skyhook(), rec({ lastCheckedAt: ago(2 * 60 * 60 * 1000) }), NOW), false,
    'two hours after a good check there is nothing to learn');
  assert.equal(probeDue(skyhook(), rec({ lastCheckedAt: ago(DAY + 1000) }), NOW), true);
});

test('a service that just failed is re-checked in minutes, not tomorrow', () => {
  // The other half of "probe daily, confirm fast". Without this a daily probe
  // and a 3-failure threshold would take THREE DAYS to send one email.
  const failing = rec({ lastCheckedAt: ago(CONFIRM_RETRY_MS + 1000), consecutiveFailures: 1 });
  assert.equal(probeDue(skyhook(), failing, NOW), true);
  const justFailed = rec({ lastCheckedAt: ago(30_000), consecutiveFailures: 1 });
  assert.equal(probeDue(skyhook(), justFailed, NOW), false, 'but not a hot loop');
});

test('a service nobody has ever checked is due immediately', () => {
  assert.equal(probeDue(skyhook(), rec(), NOW), true);
});

test('passive-only services are never due, and force cannot override that', () => {
  // "Check now" must not become a way to hand-fire a YouTube or AniList request:
  // those are passive precisely because a synthetic call competes with the
  // thing it measures.
  for (const u of UPSTREAMS.filter((x) => x.passiveOnly)) {
    assert.equal(probeDue(u, rec(), NOW), false, `${u.id} must never be probed`);
    assert.equal(probeDue(u, rec(), NOW, true), false, `${u.id} must resist force too`);
  }
});

test('force runs a probeable service regardless of when it last ran', () => {
  assert.equal(probeDue(skyhook(), rec({ lastCheckedAt: new Date(NOW).toISOString() }), NOW, true), true);
});

test('an unparseable timestamp is treated as never checked', () => {
  // A corrupt row must make us ask again, not sit silent for ever.
  assert.equal(probeDue(skyhook(), rec({ lastCheckedAt: 'not-a-date' }), NOW), true);
});

test('every probeable service actually has a probe', () => {
  // The registry and the probe table are two lists that must agree, and
  // nothing else checks that they do. A service declared probeable with no
  // probe is a row that says "unknown" forever - which reads as "we have not
  // got round to it" when it actually means "nobody wired this up".
  assert.deepEqual(missingProbes(), [], 'these services declare a probe interval but have no probe');
});

test('no probe exists for a service that was removed from the registry', () => {
  // The other direction: a leftover probe is dead code that still makes a
  // network call on a timer, charged to someone else's free service.
  assert.deepEqual(orphanProbes(), []);
});

test('passive-only services are deliberately NOT probed', () => {
  // YouTube must stay unprobed: its failure mode IS request volume, so a
  // synthetic request risks deepening the bot wall it is meant to detect -
  // monitoring that causes the outage it watches for. Pinned rather than left
  // to a comment, because it is a tempting thing to "fix".
  for (const u of UPSTREAMS.filter((x) => x.passiveOnly)) {
    assert.equal(PROBES[u.id], undefined, `${u.id} is passiveOnly and must have no probe`);
  }
  assert.ok(UPSTREAMS.some((u) => u.id === 'youtube' && u.passiveOnly));
  // AniList is NOT in that set, and the distinction is the point: YouTube's
  // failure mode is request volume, so a probe risks deepening the very block
  // it watches for. AniList answers 429 with headers and backs off politely -
  // one request a day against ~43,200 is not competition. Probing it was added
  // after the first version left it permanently "not checked" on a quiet
  // server, because nothing calls AniList except a viewer's page load.
  assert.ok(UPSTREAMS.every((u) => u.id !== 'anilist' || !u.passiveOnly),
    'AniList must be probed - nothing else would ever check it');
});

/**
 * NOT TESTED HERE: running a probe.
 *
 * Every probe needs a database and a network, and this suite has neither - it
 * runs offline inside `run_all.py`'s parallel group, and `prisma` is not even
 * initialised (calling one throws `PrismaClientInitializationError`). A test
 * that called them would fail for the environment rather than for the code,
 * which is worse than no test.
 *
 * The behaviour that matters - that an unconfigured service reports `skipped`
 * and is NOT recorded as a failure - is pinned in `tools/tests/test_status_page.py`
 * against a real backend. The rule it protects is the same one the Sonarr page
 * follows: "could not ask" is never rendered as a fault.
 */


test('the id-map timestamp is read as epoch milliseconds, not only as ISO', () => {
  // The stored value is `'1789925873565'` - a millisecond count in a string.
  // `Date.parse` returns NaN for that, so the first version of this probe
  // reported "never fetched" on a server whose map was minutes old: a row that
  // would have sat at "not set up" for ever while the thing it watches worked.
  // Found by reading the probe's output, not by a failing test.
  assert.equal(parseFetchedAt('1789925873565'), 1789925873565);
  assert.equal(parseFetchedAt('2026-09-20T12:00:00.000Z'), Date.parse('2026-09-20T12:00:00.000Z'));
  assert.equal(parseFetchedAt(null), null);
  assert.equal(parseFetchedAt(''), null);
  assert.equal(parseFetchedAt('   '), null);
  assert.equal(parseFetchedAt('not-a-date'), null);
  assert.equal(parseFetchedAt('0'), null, 'epoch zero is not a real fetch');
});
