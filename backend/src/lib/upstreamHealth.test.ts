import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_RECORD,
  MIN_OUTAGE_MS,
  UPSTREAMS,
  failingLongEnough,
  outageWindowFor,
  streakStartedAt,
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
const W = MIN_OUTAGE_MS;
const rec = (over: Partial<UpstreamRecord> = {}): UpstreamRecord => ({ ...EMPTY_RECORD, ...over });
const at = (msAfterNow: number) => new Date(Date.parse(NOW) + msAfterNow).toISOString();
/** A streak start old enough to count, so a test can be about something else. */
const LONG_AGO = at(-W - 60_000);

/** Feed `n` failures `stepMs` apart starting at NOW; return crossings (1-based) and the record. */
function failRun(start: UpstreamRecord, n: number, stepMs: number, brokenAfter: number, windowMs = W) {
  let r = start;
  const crossings: number[] = [];
  for (let i = 1; i <= n; i++) {
    const t = failureTransition(r, `fail ${i}`, 500, at((i - 1) * stepMs), brokenAfter, windowMs);
    if (t.crossed) crossings.push(i);
    r = t.next;
  }
  return { r, crossings };
}

test('the down alert fires once, at the crossing, not on every failure after it', () => {
  // The rule the whole design rests on: one failure is a blip, a run of them is
  // an outage, and mailing every failure after the first is how an alert gets
  // filtered into a folder nobody opens. The streak is already old, so this
  // test is about the "once" rule alone.
  const { r, crossings } = failRun(rec({ consecutiveFailures: 1, failCount: 1, failingSince: LONG_AGO }), 6, 1_000, 3);
  assert.deepEqual(crossings, [2], 'exactly the failure that makes the streak 3 crosses');
  assert.equal(r.consecutiveFailures, 7);
  assert.equal(r.failCount, 7);
});

test('each service gets its own threshold', () => {
  // Not cosmetic: AniList answers 429 as normal operation and needs a longer
  // run before we call it down, while SMTP failing twice is already serious.
  const long = rec({ consecutiveFailures: 1, failCount: 1, failingSince: LONG_AGO });
  assert.equal(failureTransition(long, 'x', null, NOW, 2, W).crossed, true, 'brokenAfter 2 crosses on the second failure');
  assert.equal(failureTransition(long, 'x', null, NOW, 5, W).crossed, false, 'brokenAfter 5 does not');
});

test('recovery is announced only for an outage we actually reported', () => {
  // Keyed on the stored flag, not on the streak. Since a streak at the
  // threshold no longer implies a mail went out, reading recovery off the
  // streak would announce "working again" for an outage nobody was told about -
  // which is worse than silence, because it implies a first mail was missed.
  const down = okTransition(rec({ consecutiveFailures: 3, failCount: 3, failingSince: LONG_AGO, downAlertedAt: NOW }), NOW, 3);
  assert.equal(down.recovered, true);
  assert.equal(down.next.consecutiveFailures, 0, 'a success clears the streak');
  assert.equal(down.next.failingSince, null, 'and its start, so the next streak times from zero');
  assert.equal(down.next.downAlertedAt, null, 'and re-arms the next outage');
  const blip = okTransition(rec({ consecutiveFailures: 9, failCount: 9 }), NOW, 3);
  assert.equal(blip.recovered, false, 'a long streak we never announced has nothing to announce');
});

test('a burst of failures is not an outage while something just worked', () => {
  // skyhook answered 66 calls and failed 16 in one evening - 19.5%, every one a
  // 500 - while working fine. The resolver drains at 300 ms per call, so ten
  // consecutive failures is three SECONDS.
  const { r, crossings } = failRun(rec({ lastOkAt: at(-1_000) }), 10, 300, 3);
  assert.deepEqual(crossings, [], 'no failure in a three-second burst is an outage');
  assert.equal(r.consecutiveFailures, 10, 'the streak is still counted, just not believed');
});

test('a burst is not an outage even when the last success was hours ago - the 2026-09-29 alert', () => {
  // The case the first window missed. It asked "has anything succeeded in the
  // last ten minutes?" - and skyhook is probed DAILY, so on a quiet server its
  // last success is hours old before anything fails. The 2 AM sweep then got
  // six 403s in about two seconds and mailed "not responding" for a block that
  // had lifted within minutes. How long it has been FAILING is the question.
  const skyhook = upstreamById('skyhook')!;
  const { crossings } = failRun(rec({ lastOkAt: at(-20 * 3600_000) }), 6, 300, skyhook.brokenAfter, outageWindowFor(skyhook));
  assert.deepEqual(crossings, [], 'six 403s in two seconds must not mail, however old the last success');
});

test('the same streak IS an outage once it has lasted the window', () => {
  // The other direction, or the window would just be a mute button. Failures
  // every five minutes (CONFIRM_RETRY_MS) until the window has passed.
  const { crossings } = failRun(rec(), 5, 5 * 60_000, 3);
  assert.deepEqual(crossings, [3], 'crosses at the first failure at least one window after the first');
});

test('a service that has NEVER answered is still announced once it has failed for the window', () => {
  // `lastOkAt: null` gives no benefit of the doubt, and needs none: it is timed
  // from its first failure like everything else.
  const t = failureTransition(rec({ consecutiveFailures: 2, failCount: 2, failingSince: LONG_AGO }), 'boom', 500, NOW, 3, W);
  assert.equal(t.crossed, true);
  assert.ok(t.next.downAlertedAt, 'and it remembers, so the next failure is quiet');
});

test('the outage is announced once even when the window opens later', () => {
  // The ordering the old `=== brokenAfter` could not express: the streak passes
  // the threshold in seconds and the window opens minutes later. Exactly one
  // mail, at whichever moment both became true.
  const { crossings } = failRun(rec(), 8, 3 * 60_000, 3);
  assert.equal(crossings.length, 1, 'exactly one mail, however the two conditions line up');
});

test('the streak start survives the streak and is kept, not re-stamped', () => {
  const first = failureTransition(rec(), 'a', 500, NOW, 3, W).next;
  assert.equal(first.failingSince, NOW, 'the first failure stamps the start');
  const later = failureTransition(first, 'b', 500, at(60_000), 3, W).next;
  assert.equal(later.failingSince, NOW, 'later failures keep it');
});

test('a record written before failingSince existed times from its last failure', () => {
  // Errs towards not alerting yet: lastFailAt is LATER than the true start, and
  // the next failure stamps a real one.
  const legacy = rec({ consecutiveFailures: 4, lastFailAt: at(-30_000) });
  assert.equal(streakStartedAt(legacy), at(-30_000));
  assert.equal(streakStartedAt(rec()), null, 'no streak, no start');
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
    const mine = failureTransition(rec({ consecutiveFailures: streak }), 'boom', null, NOW, BROKEN_AFTER, W);
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

  // And the divergence itself, pinned: a streak that just began mutes us and not them.
  const muted = failureTransition(
    rec({ consecutiveFailures: BROKEN_AFTER - 1, failingSince: at(-1_000) }), 'boom', null, NOW, BROKEN_AFTER, W);
  assert.equal(muted.crossed, false,
    'a streak one second old must mute this module even at the threshold');
});

test('a service nobody has checked reads unknown, never ok', () => {
  // The single most load-bearing rule on the status page. "We have not asked"
  // rendered as green is how skyhook stayed invisible for weeks; the same
  // mistake as an unreachable Sonarr reading "0 still to add".
  assert.equal(stateOf(rec(), 3, NOW, W), 'unknown');
  assert.notEqual(stateOf(rec(), 3, NOW, W), 'ok');
});

test('an unconfigured service is not a broken one', () => {
  // Sonarr with no URL saved is a deliberate state. A reader who cannot tell
  // "switched off" from "broken" goes hunting a bug that is not there.
  assert.equal(stateOf(rec({ lastCheckedAt: NOW, lastSkipped: 'no Sonarr server configured' }), 3, NOW, W), 'notConfigured');
  assert.equal(stateOf(rec({ lastCheckedAt: NOW }), 3, NOW, W), 'ok');
});

test('a real result clears a stale "not configured"', () => {
  // Otherwise configuring a service would leave it reading notConfigured until
  // someone noticed, which is the same class of lie as a cached failure.
  const skipped = rec({ lastCheckedAt: NOW, lastSkipped: 'no Sonarr server configured' });
  assert.equal(okTransition(skipped, NOW, 3).next.lastSkipped, null);
  assert.equal(failureTransition(skipped, 'boom', 500, NOW, 3, W).next.lastSkipped, null);
});

test('states ladder from ok through failing to down', () => {
  assert.equal(stateOf(rec({ lastCheckedAt: NOW }), 3, NOW, W), 'ok');
  assert.equal(stateOf(rec({ lastCheckedAt: NOW, consecutiveFailures: 1 }), 3, NOW, W), 'failing');
  assert.equal(stateOf(rec({ lastCheckedAt: NOW, consecutiveFailures: 3, failingSince: LONG_AGO }), 3, NOW, W), 'down');
});

test('a failure records the status code, because 400 and 500 mean different things', () => {
  // "Their API changed" and "their server fell over" are the two cases, and the
  // status is what separates them. skyhook's outage was a 400.
  const t = failureTransition(rec(), 'Request failed with status code 400', 400, NOW, 3, W);
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


test('services the sweep hammers wait longer before calling it an outage', () => {
  // Pins the REASON, not the number. skyhook, TMDB and AniList are called in
  // bursts (a sweep, a cold season fetch) and each one's outage costs a night
  // of evidence or a stale cache, never a viewer's playback - so a short block
  // must not mail. Our own boxes keep the short default.
  const jellyfin = outageWindowFor(upstreamById('jellyfin')!);
  for (const id of ['skyhook', 'tmdb', 'anilist']) {
    assert.ok(outageWindowFor(upstreamById(id)!) > jellyfin, `${id} must wait longer than Jellyfin`);
  }
  assert.equal(jellyfin, MIN_OUTAGE_MS, 'an unset window is the default, not zero');
});

test("YouTube takes downloadHealth's verdict as it stands", () => {
  // downloadHealth has no time window and its composed record carries no
  // streak start; any window here would time the badge from the LAST failure
  // and paint a broken download path amber.
  assert.equal(outageWindowFor(upstreamById('youtube')!), 0);
  const composed = rec({ lastCheckedAt: NOW, consecutiveFailures: 3, lastFailAt: NOW });
  assert.equal(stateOf(composed, 3, NOW, 0), 'down');
});

test('the BADGE means what the EMAIL means - a long streak is not red on its own', () => {
  // The disagreement this closes: the alert gained a window and `stateOf` kept
  // the streak-alone rule, so skyhook - 66 ok and 16 failures in one evening,
  // all 500s, while working perfectly - painted a red Down badge for a service
  // the system had deliberately decided was fine and sent no mail about.
  assert.equal(
    stateOf(rec({ lastCheckedAt: NOW, consecutiveFailures: 9, failingSince: at(-2_000) }), 3, NOW, W),
    'failing',
    'failing for two seconds is a flaky upstream, not an outage',
  );
  assert.equal(
    stateOf(rec({ lastCheckedAt: NOW, consecutiveFailures: 3, failingSince: LONG_AGO }), 3, NOW, W),
    'down',
    'failing for the whole window is an outage, and it is red',
  );
  assert.equal(
    stateOf(rec({ lastCheckedAt: NOW, consecutiveFailures: 9, failingSince: at(-2_000), lastOkAt: at(-20 * 3600_000) }), 3, NOW, W),
    'failing',
    'an old last success does not make a two-second streak an outage',
  );
});

test('the badge and the alert are driven by ONE duration rule, not two copies', () => {
  // `failingLongEnough` is the single definition. Asserting the pieces agree is
  // weaker than asserting there is only one piece, so this pins the function
  // both callers use rather than re-deriving the arithmetic.
  assert.equal(failingLongEnough(at(-1_000), NOW, W), false);
  assert.equal(failingLongEnough(LONG_AGO, NOW, W), true);
  assert.equal(failingLongEnough(null, NOW, W), false, 'no streak has lasted nothing');
  assert.equal(failingLongEnough('garbage', NOW, W), true, 'a corrupt start must not mute an alert');

  for (const failingSince of [at(-1_000), LONG_AGO]) {
    const r = rec({ lastCheckedAt: NOW, consecutiveFailures: 3, failingSince });
    const badgeSaysDown = stateOf(r, 3, NOW, W) === 'down';
    const alertWouldFire = failureTransition(r, 'boom', 500, NOW, 3, W).crossed;
    assert.equal(badgeSaysDown, alertWouldFire, `badge and alert disagree for failingSince=${failingSince}`);
  }
});

// --- Scheduled maintenance holds the mail; it never drops it -----------------

test('a crossing during maintenance is held, and mails at the first failure after it', () => {
  // 2026-10-18: Jellyfin failing for the whole window during the appdata backup.
  const long = rec({ consecutiveFailures: 2, failCount: 2, failingSince: LONG_AGO });
  const held = failureTransition(long, 'ECONNREFUSED', null, NOW, 3, W, true);
  assert.equal(held.crossed, false, 'no mail inside the window');
  assert.equal(held.heldBack, true, 'and the caller is told it was held');
  assert.equal(held.next.downAlertedAt, null, 'nothing stamped, so it can still cross');
  assert.equal(held.next.consecutiveFailures, 3, 'the streak is still counted');

  const after = failureTransition(held.next, 'HTTP 503', 503, at(5 * 60_000), 3, W, false);
  assert.equal(after.crossed, true, 'still down after the window: mail now');
  assert.equal(after.heldBack, false);
});

test('a service that recovers inside the window sends nothing at all', () => {
  const long = rec({ consecutiveFailures: 2, failCount: 2, failingSince: LONG_AGO });
  const held = failureTransition(long, 'ECONNREFUSED', null, NOW, 3, W, true);
  const ok = okTransition(held.next, at(60_000), 3);
  assert.equal(ok.recovered, false, 'no "working again" for an outage nobody was told about');
});

test('outside maintenance nothing changes', () => {
  const long = rec({ consecutiveFailures: 2, failCount: 2, failingSince: LONG_AGO });
  const t = failureTransition(long, 'boom', 500, NOW, 3, W);
  assert.equal(t.crossed, true);
  assert.equal(t.heldBack, false);
});

test('only our own boxes wait for maintenance', () => {
  // The backup stops containers on this server. A third-party API failing
  // during it is a coincidence worth hearing about straight away.
  const aware = UPSTREAMS.filter((u) => u.maintenanceAware).map((u) => u.id).sort();
  assert.deepEqual(aware, ['jellyfin', 'sonarr']);
});
