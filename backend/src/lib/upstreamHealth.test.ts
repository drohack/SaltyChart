import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_RECORD,
  MIN_OUTAGE_MS,
  UPSTREAMS,
  noRecentSuccess,
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
  // lastOkAt well before the window, so the quiet condition is satisfied and
  // this test is about the "once" rule alone.
  let r = rec({ lastOkAt: new Date(Date.parse(NOW) - 60 * 60_000).toISOString() });
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
  const old = new Date(Date.parse(NOW) - 60 * 60_000).toISOString();
  const two = failureTransition(rec({ consecutiveFailures: 1, failCount: 1, lastOkAt: old }), 'x', null, NOW, 2);
  assert.equal(two.crossed, true, 'brokenAfter 2 crosses on the second failure');
  const five = failureTransition(rec({ consecutiveFailures: 1, failCount: 1, lastOkAt: old }), 'x', null, NOW, 5);
  assert.equal(five.crossed, false, 'brokenAfter 5 does not');
});

test('recovery is announced only for an outage we actually reported', () => {
  // Keyed on the stored flag, not on the streak. Since a streak at the
  // threshold no longer implies a mail went out, reading recovery off the
  // streak would announce "working again" for an outage nobody was told about -
  // which is worse than silence, because it implies a first mail was missed.
  const down = okTransition(rec({ consecutiveFailures: 3, failCount: 3, downAlertedAt: NOW }), NOW, 3);
  assert.equal(down.recovered, true);
  assert.equal(down.next.consecutiveFailures, 0, 'a success clears the streak');
  assert.equal(down.next.downAlertedAt, null, 'and re-arms the next outage');
  const blip = okTransition(rec({ consecutiveFailures: 9, failCount: 9 }), NOW, 3);
  assert.equal(blip.recovered, false, 'a long streak we never announced has nothing to announce');
});

test('a burst of failures is not an outage while something just worked', () => {
  // The rule this whole gate exists for. skyhook answered 66 calls and failed
  // 16 in one evening - 19.5%, every one a 500 - while working fine. The
  // resolver drains at 300 ms per call, so ten consecutive failures is three
  // SECONDS, and it mailed "not responding" then "working again" a minute
  // apart. A success moments ago is proof the service is reachable.
  const justWorked = new Date(Date.parse(NOW) - 1_000).toISOString();
  let r = rec({ lastOkAt: justWorked });
  for (let i = 1; i <= 10; i++) {
    const t = failureTransition(r, `500 #${i}`, 500, NOW, 3);
    assert.equal(t.crossed, false, `failure ${i} must not be called an outage`);
    r = t.next;
  }
  assert.equal(r.consecutiveFailures, 10, 'the streak is still counted, just not believed');
});

test('the same streak IS an outage once nothing has worked for the window', () => {
  // The other direction, or the gate would just be a mute button.
  const stale = new Date(Date.parse(NOW) - MIN_OUTAGE_MS - 1_000).toISOString();
  const t = failureTransition(rec({ consecutiveFailures: 2, failCount: 2, lastOkAt: stale }), 'boom', 500, NOW, 3);
  assert.equal(t.crossed, true);
  assert.ok(t.next.downAlertedAt, 'and it remembers, so the next failure is quiet');
});

test('a service that has NEVER answered is not given the benefit of the doubt', () => {
  // `lastOkAt: null` must read as "nothing has worked", not as "something
  // worked just now". A brand-new service that has never once answered is
  // exactly the one worth hearing about.
  const t = failureTransition(rec({ consecutiveFailures: 2, failCount: 2 }), 'boom', 500, NOW, 3);
  assert.equal(t.crossed, true);
});

test('the outage is announced once even when the window opens later', () => {
  // The ordering the old `=== brokenAfter` could not express: the streak can
  // pass the threshold while a success is still recent, and the window opens
  // afterwards. Exactly one mail, at whichever moment both became true.
  const justWorked = Date.parse(NOW) - 1_000;
  let r = rec({ lastOkAt: new Date(justWorked).toISOString() });
  let crossings = 0;
  for (let i = 1; i <= 8; i++) {
    // Time advances a few minutes per failure; the success recedes.
    const at = new Date(justWorked + i * 3 * 60_000).toISOString();
    const t = failureTransition(r, 'boom', 500, at, 3);
    if (t.crossed) crossings++;
    r = t.next;
  }
  assert.equal(crossings, 1, 'exactly one mail, however the two conditions line up');
});

test('the twin still agrees on the streak, and is deliberately stricter on the mail', () => {
  // These were a threshold-aware twin of downloadHealth's and were asserted to
  // agree exactly. They no longer do, ON PURPOSE, and that divergence is worth
  // stating rather than deleting the test: downloadHealth watches a path whose
  // calls are MINUTES apart, so three in a row already spans time, while this
  // module watches services the resolver hammers hundreds of times a minute.
  //
  // What must still agree is the arithmetic - the streak, and a success
  // clearing it. What differs is only whether a streak is believed.
  for (let streak = 0; streak <= 5; streak++) {
    const mine = failureTransition(rec({ consecutiveFailures: streak }), 'boom', null, NOW, BROKEN_AFTER);
    const theirs = downloadFailureTransition(
      { ...({} as DownloadHealth), lastOkAt: null, lastFailAt: null, lastFailReason: null,
        lastFailKind: null, consecutiveFailures: streak, okCount: 0, failCount: 0 },
      'boom', 'other', NOW,
    );
    assert.equal(mine.next.consecutiveFailures, theirs.next.consecutiveFailures,
      `streak arithmetic disagrees at ${streak}`);

    const mineOk = okTransition(rec({ consecutiveFailures: streak }), NOW, BROKEN_AFTER);
    const theirsOk = downloadOkTransition(
      { ...({} as DownloadHealth), lastOkAt: null, lastFailAt: null, lastFailReason: null,
        lastFailKind: null, consecutiveFailures: streak, okCount: 0, failCount: 0 },
      NOW,
    );
    assert.equal(mineOk.next.consecutiveFailures, theirsOk.next.consecutiveFailures);
  }

  // And the divergence itself, pinned: a recent success mutes us and not them.
  const justWorked = new Date(Date.parse(NOW) - 1_000).toISOString();
  const muted = failureTransition(
    rec({ consecutiveFailures: BROKEN_AFTER - 1, lastOkAt: justWorked }), 'boom', null, NOW, BROKEN_AFTER);
  assert.equal(muted.crossed, false,
    'a recent success must mute this module even at the threshold');
});

test('a service nobody has checked reads unknown, never ok', () => {
  // The single most load-bearing rule on the status page. "We have not asked"
  // rendered as green is how skyhook stayed invisible for weeks; the same
  // mistake as an unreachable Sonarr reading "0 still to add".
  assert.equal(stateOf(rec(), 3, NOW), 'unknown');
  assert.notEqual(stateOf(rec(), 3, NOW), 'ok');
});

test('an unconfigured service is not a broken one', () => {
  // Sonarr with no URL saved is a deliberate state. A reader who cannot tell
  // "switched off" from "broken" goes hunting a bug that is not there.
  assert.equal(stateOf(rec({ lastCheckedAt: NOW, lastSkipped: 'no Sonarr server configured' }), 3, NOW), 'notConfigured');
  assert.equal(stateOf(rec({ lastCheckedAt: NOW }), 3, NOW), 'ok');
});

test('a real result clears a stale "not configured"', () => {
  // Otherwise configuring a service would leave it reading notConfigured until
  // someone noticed, which is the same class of lie as a cached failure.
  const skipped = rec({ lastCheckedAt: NOW, lastSkipped: 'no Sonarr server configured' });
  assert.equal(okTransition(skipped, NOW, 3).next.lastSkipped, null);
  assert.equal(failureTransition(skipped, 'boom', 500, NOW, 3).next.lastSkipped, null);
});

test('states ladder from ok through failing to down', () => {
  assert.equal(stateOf(rec({ lastCheckedAt: NOW }), 3, NOW), 'ok');
  assert.equal(stateOf(rec({ lastCheckedAt: NOW, consecutiveFailures: 1 }), 3, NOW), 'failing');
  assert.equal(stateOf(rec({ lastCheckedAt: NOW, consecutiveFailures: 3 }), 3, NOW), 'down');
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


test('the BADGE means what the EMAIL means - a long streak is not red on its own', () => {
  // The disagreement this closes: the alert gained a quiet window and `stateOf`
  // kept the streak-alone rule, so skyhook - 66 ok and 16 failures in one
  // evening, all 500s, while working perfectly - painted a red Down badge for a
  // service the system had deliberately decided was fine and sent no mail about.
  // Two of this page's five states exist purely so a reader is never misled;
  // this was the page misleading them.
  const justWorked = new Date(Date.parse(NOW) - 1_000).toISOString();
  assert.equal(
    stateOf(rec({ lastCheckedAt: NOW, consecutiveFailures: 9, lastOkAt: justWorked }), 3, NOW),
    'failing',
    'something succeeded a second ago - that is a flaky upstream, not an outage',
  );

  const stale = new Date(Date.parse(NOW) - MIN_OUTAGE_MS - 1_000).toISOString();
  assert.equal(
    stateOf(rec({ lastCheckedAt: NOW, consecutiveFailures: 3, lastOkAt: stale }), 3, NOW),
    'down',
    'nothing has worked for the whole window - that is an outage, and it is red',
  );

  // A service that has never answered stays red: "no record of it ever working"
  // must not read as "it worked recently".
  assert.equal(
    stateOf(rec({ lastCheckedAt: NOW, consecutiveFailures: 3 }), 3, NOW),
    'down',
  );
});

test('the badge and the alert are driven by ONE quiet rule, not two copies', () => {
  // `noRecentSuccess` is the single definition. Asserting the pieces agree is
  // weaker than asserting there is only one piece, so this pins the function
  // both callers use rather than re-deriving the arithmetic.
  const justWorked = new Date(Date.parse(NOW) - 1_000).toISOString();
  const stale = new Date(Date.parse(NOW) - MIN_OUTAGE_MS - 1_000).toISOString();

  assert.equal(noRecentSuccess(justWorked, NOW), false);
  assert.equal(noRecentSuccess(stale, NOW), true);
  assert.equal(noRecentSuccess(null, NOW), true, 'never succeeded counts as quiet');

  // And the two callers really do move together.
  for (const lastOkAt of [justWorked, stale, null]) {
    const r = rec({ lastCheckedAt: NOW, consecutiveFailures: 3, lastOkAt });
    const badgeSaysDown = stateOf(r, 3, NOW) === 'down';
    const alertWouldFire = failureTransition(r, 'boom', 500, NOW, 3).crossed;
    assert.equal(badgeSaysDown, alertWouldFire,
      `badge and alert disagree for lastOkAt=${lastOkAt}`);
  }
});
