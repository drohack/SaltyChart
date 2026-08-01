import { test } from 'node:test';
import assert from 'node:assert';
import { backoffFor, readBudget, DEFAULT_LOCKOUT_MS, MAX_ATTEMPTS } from './anilistRateLimit';

const NOW = 1_800_000_000_000; // fixed; the reset branch is clock-dependent

test('Retry-After wins, and is seconds', () => {
  const d = backoffFor({ 'retry-after': '45' }, 1, NOW);
  assert.equal(d.waitMs, 45_000);
  assert.equal(d.source, 'retry-after');
});

test('Retry-After beats X-RateLimit-Reset when both are present', () => {
  // A 429 carries both. Retry-After is the direct instruction; the reset
  // timestamp is a derived one, and they can disagree at a window boundary.
  const d = backoffFor(
    { 'retry-after': '30', 'x-ratelimit-reset': String((NOW + 5_000) / 1000) },
    1,
    NOW
  );
  assert.equal(d.waitMs, 30_000);
  assert.equal(d.source, 'retry-after');
});

test('X-RateLimit-Reset is a Unix timestamp in seconds, not a duration', () => {
  const d = backoffFor({ 'x-ratelimit-reset': String(NOW / 1000 + 20) }, 1, NOW);
  assert.equal(d.waitMs, 20_000);
  assert.equal(d.source, 'reset');
});

test('a reset timestamp in the past floors instead of retrying instantly', () => {
  // Clock skew, or the window rolling over mid-burst. An instant retry just
  // burns an attempt while the limit is still in force.
  const d = backoffFor({ 'x-ratelimit-reset': String(NOW / 1000 - 120) }, 2, NOW);
  assert.ok(d.waitMs >= 4_000, `expected a floored wait, got ${d.waitMs}`);
});

test('a headerless 429 waits the documented one-minute lockout', () => {
  // THE BUG: this used to wait 15s on the first attempt. AniList's documented
  // timeout is 60s, so every retry landed inside the lockout, achieved nothing,
  // and burned the attempt budget — a cold fetch spent 90s to still fail.
  const d = backoffFor({}, 1, NOW);
  assert.equal(d.waitMs, DEFAULT_LOCKOUT_MS);
  assert.equal(d.source, 'default');
});

test('no attempt ever waits less than the lockout when there are no headers', () => {
  for (const attempt of [1, 2, 3, 4]) {
    const d = backoffFor({}, attempt, NOW);
    assert.ok(
      d.waitMs >= DEFAULT_LOCKOUT_MS,
      `attempt ${attempt} waited ${d.waitMs}ms, inside the 60s lockout`
    );
  }
});

test('the worst-case total hang stays close to one lockout, not several', () => {
  // The property a viewer actually feels. Waits are a full 60s window each now,
  // so attempts multiply straight into hang time — at 4 attempts someone waits
  // three minutes and still gets an error. Raising MAX_ATTEMPTS without redoing
  // this arithmetic re-creates the original bug in a new form.
  let total = 0;
  for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
    total += backoffFor({}, attempt, NOW).waitMs;
  }
  assert.ok(
    total <= 90_000,
    `worst case waits ${total / 1000}s before failing — too long to hold a request open`
  );
});

test('malformed header values fall through rather than producing NaN', () => {
  // A NaN wait becomes `setTimeout(NaN)` — which fires immediately, i.e. a
  // hot retry loop against a server that just rate-limited us.
  for (const bad of ['', 'soon', undefined, null]) {
    const d = backoffFor({ 'retry-after': bad }, 1, NOW);
    assert.ok(Number.isFinite(d.waitMs), `"${bad}" produced ${d.waitMs}`);
    assert.ok(d.waitMs > 0);
  }
});

test('the budget is read from the headers AniList sends on every response', () => {
  const b = readBudget({ 'x-ratelimit-remaining': '13', 'x-ratelimit-limit': '30' });
  assert.equal(b.remaining, 13);
  assert.equal(b.limit, 30);
});

test('a missing budget reads as null, never as zero', () => {
  // Zero would mean "no budget left" and would suppress refreshes forever.
  const b = readBudget({});
  assert.equal(b.remaining, null);
  assert.equal(b.limit, null);
});

test('a genuine zero budget is preserved', () => {
  const b = readBudget({ 'x-ratelimit-remaining': '0' });
  assert.equal(b.remaining, 0);
});
