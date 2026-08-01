/**
 * Reading AniList's rate-limit headers, and deciding how long to wait after a 429.
 *
 * Pure, so it can be unit-tested — the bug this exists to fix cost a viewer a
 * three-minute wait and was invisible in every integration test, because it only
 * shows up as "slow" rather than "wrong".
 *
 * What AniList documents:
 *   - 90 req/min nominally, currently degraded to 30
 *   - `X-RateLimit-Limit` / `X-RateLimit-Remaining` on EVERY response
 *   - `Retry-After` (seconds) and `X-RateLimit-Reset` (Unix seconds) on a 429
 *   - exceeding the limit earns a **1 minute** timeout
 *   - a separate, undocumented burst limiter also exists
 */

/** Header bag as axios hands it to us: lower-cased keys, string-ish values. */
export type HeaderBag = Record<string, unknown>;

export type WaitSource = 'retry-after' | 'reset' | 'default';

export interface BackoffDecision {
  waitMs: number;
  /** Which header decided this, for the log line. */
  source: WaitSource;
}

/**
 * AniList's documented lockout is one minute, so that is the only sensible
 * guess when a 429 arrives with no headers to read.
 */
export const DEFAULT_LOCKOUT_MS = 60_000;

/**
 * Attempts before giving up — deliberately small, and it must stay that way.
 *
 * Waits are now a full lockout each, so attempts multiply directly into how long
 * a request can hang: at 4 attempts a viewer waits three minutes and then gets an
 * error anyway. That is the exact failure this change exists to remove, so the
 * budget went *down*, not up. Two attempts is one retry after the window has
 * had a chance to clear, and a worst case of ~60 s.
 *
 * Giving up quickly is safe because nothing depends on this call succeeding:
 * a cached season is already served stale, and the per-key cooldown stops the
 * failure turning into a retry storm.
 */
export const MAX_ATTEMPTS = 2;

function num(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(Array.isArray(value) ? value[0] : value);
  return Number.isFinite(n) ? n : null;
}

/**
 * How long to wait before retrying a 429.
 *
 * `attempt` is 1-based. `now` is injectable so the reset-timestamp branch can be
 * tested without freezing the clock.
 */
export function backoffFor(headers: HeaderBag, attempt: number, now: number = Date.now()): BackoffDecision {
  const retryAfter = num(headers['retry-after']);
  const reset = num(headers['x-ratelimit-reset']);

  let waitMs: number;
  let source: WaitSource;

  if (retryAfter != null) {
    waitMs = retryAfter * 1000;
    source = 'retry-after';
  } else if (reset != null) {
    waitMs = reset * 1000 - now; // header is Unix *seconds*
    source = 'reset';
  } else {
    // A flat lockout, not an escalating guess. The old `15_000 * attempt` put
    // every retry *inside* AniList's one-minute timeout, so all three attempts
    // were spent failing and the caller waited 90 s to be told no.
    waitMs = DEFAULT_LOCKOUT_MS;
    source = 'default';
  }

  // Floor it. A reset timestamp already in the past (clock skew, or the window
  // rolling over mid-burst) yields a negative or zero wait, and retrying
  // instantly just burns an attempt while the limit is still in force.
  waitMs = Math.max(waitMs, 2_000 * attempt);

  return { waitMs, source };
}

export interface RateLimitBudget {
  remaining: number | null;
  limit: number | null;
}

/**
 * The budget AniList reports on every response.
 *
 * This is the number the pacing should be built on. Anything else is a guess at
 * a value the API is already telling us.
 */
export function readBudget(headers: HeaderBag): RateLimitBudget {
  return {
    remaining: num(headers['x-ratelimit-remaining']),
    limit: num(headers['x-ratelimit-limit']),
  };
}
