import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_RECORD,
  UPSTREAMS,
  failureTransition,
  okTransition,
  stateOf,
  upstreamById,
  type UpstreamRecord,
} from './upstreamHealth';
import {
  BROKEN_AFTER,
  failureTransition as downloadFailureTransition,
  okTransition as downloadOkTransition,
  type DownloadHealth,
} from './downloadHealth';

const NOW = '2026-09-20T12:00:00.000Z';
const rec = (over: Partial<UpstreamRecord> = {}): UpstreamRecord => ({ ...EMPTY_RECORD, ...over });

test('the down alert fires once, at the crossing, not on every failure after it', () => {
  // The rule the whole design rests on: one failure is a blip, a run of them is
  // an outage, and mailing every failure after the first is how an alert gets
  // filtered into a folder nobody opens.
  let r = rec();
  const crossings: number[] = [];
  for (let i = 1; i <= 6; i++) {
    const t = failureTransition(r, `fail ${i}`, 500, NOW, 3);
    if (t.crossed) crossings.push(i);
    r = t.next;
  }
  assert.deepEqual(crossings, [3], 'exactly the third failure crosses');
  assert.equal(r.consecutiveFailures, 6);
  assert.equal(r.failCount, 6);
});

test('each service gets its own threshold', () => {
  // Not cosmetic: AniList answers 429 as normal operation and needs a longer
  // run before we call it down, while SMTP failing twice is already serious.
  const two = failureTransition(rec({ consecutiveFailures: 1, failCount: 1 }), 'x', null, NOW, 2);
  assert.equal(two.crossed, true, 'brokenAfter 2 crosses on the second failure');
  const five = failureTransition(rec({ consecutiveFailures: 1, failCount: 1 }), 'x', null, NOW, 5);
  assert.equal(five.crossed, false, 'brokenAfter 5 does not');
});

test('recovery is announced only when the service was actually down', () => {
  const down = okTransition(rec({ consecutiveFailures: 3, failCount: 3 }), NOW, 3);
  assert.equal(down.recovered, true);
  assert.equal(down.next.consecutiveFailures, 0, 'a success clears the streak');
  const blip = okTransition(rec({ consecutiveFailures: 2, failCount: 2 }), NOW, 3);
  assert.equal(blip.recovered, false, 'it never crossed, so there is nothing to announce');
});

test('the transitions agree with downloadHealth at the default threshold', () => {
  // These are a threshold-aware TWIN of downloadHealth's, not shared code:
  // per-service thresholds are the point here, and that module's constants are
  // pinned by a mutation row. Two implementations of one rule only stay honest
  // if something says when they disagree - the MODEL_RANK lesson.
  for (let streak = 0; streak <= 5; streak++) {
    const mine = failureTransition(rec({ consecutiveFailures: streak }), 'boom', null, NOW, BROKEN_AFTER);
    const theirs = downloadFailureTransition(
      { ...({} as DownloadHealth), lastOkAt: null, lastFailAt: null, lastFailReason: null,
        lastFailKind: null, consecutiveFailures: streak, okCount: 0, failCount: 0 },
      'boom', 'other', NOW,
    );
    assert.equal(mine.crossed, theirs.crossed, `crossed disagrees at streak ${streak}`);
    assert.equal(mine.next.consecutiveFailures, theirs.next.consecutiveFailures);

    const mineOk = okTransition(rec({ consecutiveFailures: streak }), NOW, BROKEN_AFTER);
    const theirsOk = downloadOkTransition(
      { ...({} as DownloadHealth), lastOkAt: null, lastFailAt: null, lastFailReason: null,
        lastFailKind: null, consecutiveFailures: streak, okCount: 0, failCount: 0 },
      NOW,
    );
    assert.equal(mineOk.recovered, theirsOk.recovered, `recovered disagrees at streak ${streak}`);
  }
});

test('a service nobody has checked reads unknown, never ok', () => {
  // The single most load-bearing rule on the status page. "We have not asked"
  // rendered as green is how skyhook stayed invisible for weeks; the same
  // mistake as an unreachable Sonarr reading "0 still to add".
  assert.equal(stateOf(rec(), 3), 'unknown');
  assert.notEqual(stateOf(rec(), 3), 'ok');
});

test('an unconfigured service is not a broken one', () => {
  // Sonarr with no URL saved is a deliberate state. A reader who cannot tell
  // "switched off" from "broken" goes hunting a bug that is not there.
  assert.equal(stateOf(rec({ lastCheckedAt: NOW, lastSkipped: 'no Sonarr server configured' }), 3), 'notConfigured');
  assert.equal(stateOf(rec({ lastCheckedAt: NOW }), 3), 'ok');
});

test('a real result clears a stale "not configured"', () => {
  // Otherwise configuring a service would leave it reading notConfigured until
  // someone noticed, which is the same class of lie as a cached failure.
  const skipped = rec({ lastCheckedAt: NOW, lastSkipped: 'no Sonarr server configured' });
  assert.equal(okTransition(skipped, NOW, 3).next.lastSkipped, null);
  assert.equal(failureTransition(skipped, 'boom', 500, NOW, 3).next.lastSkipped, null);
});

test('states ladder from ok through failing to down', () => {
  assert.equal(stateOf(rec({ lastCheckedAt: NOW }), 3), 'ok');
  assert.equal(stateOf(rec({ lastCheckedAt: NOW, consecutiveFailures: 1 }), 3), 'failing');
  assert.equal(stateOf(rec({ lastCheckedAt: NOW, consecutiveFailures: 3 }), 3), 'down');
});

test('a failure records the status code, because 400 and 500 mean different things', () => {
  // "Their API changed" and "their server fell over" are the two cases, and the
  // status is what separates them. skyhook's outage was a 400.
  const t = failureTransition(rec(), 'Request failed with status code 400', 400, NOW, 3);
  assert.equal(t.next.lastFailStatus, 400);
  assert.match(t.next.lastFailReason ?? '', /400/);
});

test('the registry is complete and internally consistent', () => {
  // The registry is the thing that rots: a new dependency added without an
  // entry here is a service with no status row and no alert, which is exactly
  // the state this feature exists to end.
  assert.ok(UPSTREAMS.length >= 8, 'every third-party surface should be listed');
  const ids = UPSTREAMS.map((u) => u.id);
  assert.equal(new Set(ids).size, ids.length, 'ids must be unique - they key the stored record');
  for (const u of UPSTREAMS) {
    assert.ok(u.label.trim(), `${u.id} needs a label`);
    assert.ok(u.impact.trim(), `${u.id} must say what a viewer loses`);
    assert.ok(u.brokenAfter >= 1, `${u.id} needs a positive threshold`);
    assert.ok(
      u.passiveOnly === true || typeof u.minProbeIntervalMs === 'number',
      `${u.id} must either be explicitly passiveOnly or declare a probe interval`,
    );
  }
  assert.equal(upstreamById('nope'), undefined);
});

test('a service known to emit transient errors needs a longer streak', () => {
  // Pins the REASON, not the number - a test that just repeats the constant
  // only means editing two places. skyhook tripped at 3 during a drain and
  // mailed "not responding" while it was fine: it answered three of several
  // hundred requests with a 500. Measured over one evening, 45 of 45 failures
  // were 500 and none was a 4xx, so every failure seen so far is its server
  // under load rather than its API changing.
  const skyhook = upstreamById('skyhook');
  const jellyfin = upstreamById('jellyfin');
  assert.ok(
    (skyhook?.brokenAfter ?? 0) > (jellyfin?.brokenAfter ?? 0),
    'skyhook must tolerate a longer run of failures than a service on our own LAN',
  );
  // AniList for the same reason from the other direction: a 429 is normal
  // operation there, not an outage.
  assert.ok((upstreamById('anilist')?.brokenAfter ?? 0) > (jellyfin?.brokenAfter ?? 0));
});

test('YouTube is passive-only and reads its record from downloadHealth', () => {
  // Not an oversight: what breaks at YouTube is its tolerance for our requests,
  // so a synthetic probe adds load to the exact thing that is failing. Its
  // record stays in downloadHealth, which owns the bot-wall hold too.
  const yt = upstreamById('youtube');
  assert.equal(yt?.passiveOnly, true);
  assert.equal(yt?.recordSource, 'downloadHealth');
});

test('the SMTP row says out loud that it cannot mail about itself', () => {
  // The one circular case: if mail is down, the alert about mail cannot arrive.
  // The page has to carry that, or its silence reads as health.
  const smtp = upstreamById('smtp');
  assert.match(smtp?.impact ?? '', /ALERTS|alert/i);
});
