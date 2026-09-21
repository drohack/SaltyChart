import { test } from 'node:test';
import assert from 'node:assert';
import {
  holdUntil, looksLikeStaleYtDlp, failureTransition, okTransition, normalizeFailKind,
  countsTowardBroken, BOT_WALL_HOLD_MS, BROKEN_AFTER, type DownloadHealth,
} from './downloadHealth';

// Fixed clock: the hold is time-relative and the assertions must not depend on
// how long the test took to reach them.
const NOW = 1_800_000_000_000;
const NOW_ISO = new Date(NOW).toISOString();

function health(over: Partial<DownloadHealth>): DownloadHealth {
  return {
    lastOkAt: null, lastFailAt: null, lastFailReason: null, lastFailKind: null,
    consecutiveFailures: 0, okCount: 0, failCount: 0, ...over,
  };
}

test('a bot wall one minute ago holds until lastFailAt + BOT_WALL_HOLD_MS', () => {
  const at = NOW - 60_000;
  const h = health({ lastFailKind: 'botwall', lastFailAt: new Date(at).toISOString() });
  assert.equal(holdUntil(h, NOW), new Date(at + BOT_WALL_HOLD_MS).toISOString());
});

test('a bot wall older than the hold window no longer holds', () => {
  const at = NOW - BOT_WALL_HOLD_MS - 1_000;
  const h = health({ lastFailKind: 'botwall', lastFailAt: new Date(at).toISOString() });
  assert.equal(holdUntil(h, NOW), null);
});

test('a forbidden (403) failure never holds downloads', () => {
  // The load-bearing asymmetry. A 403 is the stale-yt-dlp signature: each
  // attempt fails fast and harmlessly, and the daily updater or a deploy may
  // fix it at any moment. Holding on it would only hide the recovery - the
  // outage this whole file exists to make visible.
  const h = health({ lastFailKind: 'forbidden', lastFailAt: new Date(NOW - 60_000).toISOString(),
                     lastFailReason: 'HTTP Error 403: Forbidden', consecutiveFailures: 5 });
  assert.equal(holdUntil(h, NOW), null);
});

test('one bot wall is enough - no streak required', () => {
  // Unlike `broken` (which needs BROKEN_AFTER in a row, because one failure is
  // a private trailer), a bot wall is YouTube saying "you", not "that video".
  const h = health({ lastFailKind: 'botwall', lastFailAt: new Date(NOW - 1_000).toISOString(),
                     consecutiveFailures: 1 });
  assert.notEqual(holdUntil(h, NOW), null);
});

test('no failure at all means no hold', () => {
  assert.equal(holdUntil(health({}), NOW), null);
  assert.equal(holdUntil(health({ lastFailKind: 'botwall' }), NOW), null); // kind without a time
});

test('the stale-yt-dlp signature is a 403, not a bot wall', () => {
  assert.equal(looksLikeStaleYtDlp('ERROR: unable to download video data: HTTP Error 403: Forbidden'), true);
  assert.equal(looksLikeStaleYtDlp('Sign in to confirm you are not a bot'), false);
  assert.equal(looksLikeStaleYtDlp(null), false);
});

test('a bot wall delivered as a 403 gets no stale-yt-dlp hint', () => {
  // The daemon checks bot-wall phrases before the 403 status for exactly this
  // message shape; the hint must follow the same precedence or the admin page
  // recommends upgrading yt-dlp under a banner about being rate-limited.
  const mixed = 'HTTP Error 403: Forbidden. Sign in to confirm you are not a bot';
  assert.equal(looksLikeStaleYtDlp(mixed, 'botwall'), false);
  assert.equal(looksLikeStaleYtDlp(mixed, 'forbidden'), true);
  assert.equal(looksLikeStaleYtDlp('HTTP Error 403: Forbidden', undefined), true); // rows stored before `kind`
});

test('an unknown failure kind is stored as other', () => {
  assert.equal(normalizeFailKind('weird'), 'other');
  assert.equal(normalizeFailKind(undefined), 'other');
  assert.equal(normalizeFailKind(42), 'other');
  assert.equal(normalizeFailKind('botwall'), 'botwall');
});

test('the broken alert fires once, at the crossing, not on every failure after it', () => {
  // Streak 2 -> 3 is the edge. 3 -> 4 is not: mailing on every failure past the
  // threshold is how an alert becomes noise and gets muted.
  const two = health({ consecutiveFailures: BROKEN_AFTER - 1, failCount: 2 });
  const cross = failureTransition(two, 'HTTP Error 403: Forbidden', 'forbidden', NOW_ISO);
  assert.equal(cross.crossed, true);
  assert.equal(cross.next.consecutiveFailures, BROKEN_AFTER);
  assert.equal(cross.next.failCount, 3);
  const after = failureTransition(cross.next, 'HTTP Error 403: Forbidden', 'forbidden', NOW_ISO);
  assert.equal(after.crossed, false);
  assert.equal(after.next.consecutiveFailures, BROKEN_AFTER + 1);
  const first = failureTransition(health({}), 'x', 'other', NOW_ISO);
  assert.equal(first.crossed, false);
});

test('recovery is announced only when the path was broken', () => {
  const broken = health({ consecutiveFailures: BROKEN_AFTER, failCount: 3 });
  const r = okTransition(broken, NOW_ISO);
  assert.equal(r.recovered, true);
  assert.equal(r.next.consecutiveFailures, 0);
  assert.equal(r.next.okCount, 1);
  const unlucky = health({ consecutiveFailures: 1 });
  assert.equal(okTransition(unlucky, NOW_ISO).recovered, false);
});


test('a dead video is not evidence that downloading is broken', () => {
  // Measured on a real run: SUMMER 2026 failed FIVE trailers back to back -
  // Anpanman, Crayon Shin-chan, TOMICA and two more - every one of them
  // `Video unavailable`, against a BROKEN_AFTER of 3. Counting those would mail
  // "the download path is broken" while the path was working perfectly; the
  // same run downloaded 51 other trailers.
  //
  // A video that no longer exists says nothing in EITHER direction, so it must
  // not advance the streak and must not clear it either. The counter still
  // moves, because "how many trailers are simply gone" is worth seeing.
  assert.equal(countsTowardBroken('unavailable'), false);
  // And it is the ONLY kind spared - written as a sweep so a new FailKind added
  // later has to make this decision deliberately rather than inherit silence.
  const spared = (['botwall', 'forbidden', 'unavailable', 'other'] as const)
    .filter((k) => !countsTowardBroken(k));
  assert.deepEqual(spared, ['unavailable']);
});

test('a 403 and a bot wall still count, because both mean the PATH is failing', () => {
  // The other side of the exclusion: a stale yt-dlp (403 on every video) and a
  // bot wall are exactly what the streak exists to catch, and sparing them
  // would turn the alert off entirely.
  assert.equal(countsTowardBroken('forbidden'), true);
  assert.equal(countsTowardBroken('botwall'), true);
  assert.equal(countsTowardBroken('other'), true);
  // The streak arithmetic itself is unchanged for anything that counts.
  const a = failureTransition(health({ consecutiveFailures: 2, failCount: 2 }),
    'HTTP Error 403: Forbidden', 'forbidden', NOW_ISO);
  assert.equal(a.crossed, true, 'three consecutive 403s is a broken path');
});
