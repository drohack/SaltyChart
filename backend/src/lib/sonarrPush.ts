// ---------------------------------------------------------------------------
// Should we add this series to Sonarr, and what does a failed add mean?
//
// **Why a push and not a list.** SaltyChart used to serve a Custom List that
// Sonarr polled every ~5 minutes. A Custom List is a *declarative set* - "this
// is everything that should exist" - and Sonarr reconciles against it, so a
// series deleted from Sonarr was re-added on the next poll and re-added again
// after the next deletion, for as long as its season stayed on the list (3 to 6
// months, since `isWithinAirWindow` stays true once a show has aired). Watching
// for the deletion could not fix that: the observation is hourly against a
// 5-minute poll, so a still-listed series is only ever seen *held*.
//
// Removing entries once added would have worked, but only by accident. Sonarr's
// `config/importlist.listSyncLevel` exists precisely because a list is a desired
// state: when enabled it unmonitors or tags library series that have fallen off
// every import list. It is **global**, shared with whatever other lists the
// server has, and there is an open bug where dropping one series unmonitors all
// of them (Sonarr#7555). Correctness would have depended on a switch that is not
// ours to hold still.
//
// `POST /api/v3/series` has none of that. There is no standing list, so nothing
// to re-propose, nothing to retire, and `listSyncLevel` cannot touch us.
//
// **One and done.** A terminal row here means we never consider that tvdbId
// again - deleted later by Maintainerr, by a human, for any reason, it stays
// gone. Retries exist only for the case where the add did not happen:
// a wrong id, or Sonarr being unreachable.
//
// Pure and I/O-free, like `sonarrSelect.ts`: the caller talks to Sonarr and
// writes the DB, and every rule below is unit-tested without either.
// ---------------------------------------------------------------------------

/**
 * The recorded outcome for one tvdbId.
 *
 * `pushed` and `alreadyHeld` are **terminal** - they are the one-and-done
 * guarantee. `lookupFailed` and `failed` are retryable, because in both cases
 * nothing was added and the cause is something that can be fixed: a corrected
 * identity, or Sonarr coming back.
 */
export type PushStatus = 'pushed' | 'alreadyHeld' | 'lookupFailed' | 'failed';

const TERMINAL: ReadonlySet<PushStatus> = new Set<PushStatus>(['pushed', 'alreadyHeld']);

export function isTerminal(status: PushStatus): boolean {
  return TERMINAL.has(status);
}

/** One stored row. Mirrors the `SonarrPush` model. */
export interface PushRow {
  tvdbId: number;
  anilistId: number | null;
  title: string;
  status: PushStatus;
  sonarrSeriesId: number | null;
  pushedAt: Date | null;
  attempts: number;
  lastAttemptAt: Date | null;
  lastError: string | null;
}

export type SkipReason =
  /** A terminal row exists. The whole point of the feature. */
  | 'alreadyPushed'
  /** Sonarr holds this tvdbId already - someone added it by hand, or we did before we recorded. */
  | 'alreadyHeld'
  /** On Sonarr's Import List Exclusions: a human said no, so we do not argue. */
  | 'excluded';

export type PushDecision = { action: 'push' } | { action: 'skip'; reason: SkipReason };

export interface PushCandidate {
  tvdbId: number;
  anilistId: number | null;
  title: string;
}

/**
 * Decide what to do with one candidate.
 *
 * Order is cheapest-and-most-decisive first, and it matters:
 *
 *  1. **A terminal row wins over everything.** This is what makes a deletion
 *     permanent, and checking it first means no amount of library churn can
 *     resurrect an entry.
 *  2. **Sonarr already holds it** -> `alreadyHeld`, which the caller records as
 *     terminal. This is how the series already in the library retire without
 *     ever being pushed.
 *  3. **On the exclusion list** -> skip, but deliberately *not* recorded. An
 *     exclusion is a human decision that can be undone in Sonarr, and pinning a
 *     terminal row here would outlive it. Re-checking costs nothing; both sets
 *     come from a snapshot the caller already has.
 */
export function decidePush(
  candidate: PushCandidate,
  prior: PushRow | undefined,
  held: ReadonlySet<number>,
  excluded: ReadonlySet<number>
): PushDecision {
  if (prior && isTerminal(prior.status)) {
    return { action: 'skip', reason: prior.status === 'pushed' ? 'alreadyPushed' : 'alreadyHeld' };
  }
  if (held.has(candidate.tvdbId)) return { action: 'skip', reason: 'alreadyHeld' };
  if (excluded.has(candidate.tvdbId)) return { action: 'skip', reason: 'excluded' };
  return { action: 'push' };
}

export interface RunPlan {
  /** Candidates to actually add, in order, already cut to the cap. */
  toPush: PushCandidate[];
  /** Held back by the cap. **Never silently dropped** - the caller reports this. */
  deferred: PushCandidate[];
  skipped: { candidate: PushCandidate; reason: SkipReason }[];
}

/**
 * Turn a season's candidates into one run's work.
 *
 * The cap is a blast-radius limit, not a rate limit: nothing searches on add, so
 * a large run is cheap for indexers. It is the difference between a
 * misconfiguration adding 10 series and adding every candidate of two seasons.
 *
 * `deferred` is returned rather than discarded because a truncated collection
 * that looks complete is a bug this repo has shipped before - a `slice(0, 100)`
 * once made a review page report "nothing needs review" for a third of a season.
 */
export function planPushRun(
  candidates: PushCandidate[],
  priors: Map<number, PushRow>,
  held: ReadonlySet<number>,
  excluded: ReadonlySet<number>,
  cap: number
): RunPlan {
  const plan: RunPlan = { toPush: [], deferred: [], skipped: [] };
  for (const candidate of candidates) {
    const decision = decidePush(candidate, priors.get(candidate.tvdbId), held, excluded);
    if (decision.action === 'skip') {
      plan.skipped.push({ candidate, reason: decision.reason });
    } else if (plan.toPush.length < cap) {
      plan.toPush.push(candidate);
    } else {
      plan.deferred.push(candidate);
    }
  }
  return plan;
}

/**
 * A series we added for an AniList entry that has since been re-identified.
 *
 * Nothing on our side removes it, and the corrected id is now a fresh candidate
 * - so left alone the library ends up holding both. Reported rather than acted
 * on: removing it needs a delete verb we deliberately do not have, so this is
 * the one thing here that requires a human.
 */
export interface Orphan {
  tvdbId: number;
  title: string;
  anilistId: number;
  /** What that AniList entry resolves to now. */
  nowTvdbId: number;
}

export function findOrphans(
  rows: PushRow[],
  currentIdentity: ReadonlyMap<number, number>,
  held: ReadonlySet<number>
): Orphan[] {
  const out: Orphan[] = [];
  for (const row of rows) {
    if (row.anilistId === null) continue;
    // Only a series Sonarr still holds can be an orphan; one already gone is
    // just history, and reporting it would ask someone to delete nothing.
    if (!held.has(row.tvdbId)) continue;
    const nowTvdbId = currentIdentity.get(row.anilistId);
    if (nowTvdbId === undefined || nowTvdbId === row.tvdbId) continue;
    out.push({ tvdbId: row.tvdbId, title: row.title, anilistId: row.anilistId, nowTvdbId });
  }
  return out;
}

/**
 * Which skips deserve a terminal row of their own.
 *
 * Series Sonarr already holds are skipped from the *live* snapshot, so without
 * recording them they are re-decided every run - and deleting one you owned
 * before this feature existed would turn it into a fresh candidate and we would
 * add it back. That is the loop this whole design removes, surviving in the one
 * place it was easy to overlook: it was found by running a real push twice
 * against the live instance, not by any test, because with 36 held series and 3
 * candidates nothing on screen looked wrong.
 *
 * `excluded` is deliberately NOT recorded - a Sonarr exclusion is a human
 * decision that can be undone there, and a terminal row here would outlive it.
 */
export function newlyHeldToRecord(
  skipped: Array<{ candidate: PushCandidate; reason: SkipReason }>,
  priorIds: ReadonlySet<number>
): PushCandidate[] {
  const out: PushCandidate[] = [];
  const seen = new Set<number>();
  for (const s of skipped) {
    if (s.reason !== 'alreadyHeld') continue;
    if (priorIds.has(s.candidate.tvdbId) || seen.has(s.candidate.tvdbId)) continue;
    seen.add(s.candidate.tvdbId);
    out.push(s.candidate);
  }
  return out;
}

/**
 * What a failed `POST /api/v3/series` means.
 *
 * `alreadyExists` is the one that matters. Our "does Sonarr hold it" check reads
 * a cached snapshot, so a series added between snapshots comes back here as a
 * 400 rather than being filtered out. Recording that as a *failure* would leave
 * it retryable, and it would be retried on every run forever - the re-add loop
 * rebuilt in a new place. It is recorded as `alreadyHeld`, which is terminal.
 *
 * Sonarr answers with an array of `{ errorMessage, propertyName }`; the message
 * has been worded differently across versions, so this matches on the stable
 * part rather than the whole string.
 */
export type AddFailureKind = 'alreadyExists' | 'invalid' | 'retryable';

export function classifyAddError(res: { status?: number; body?: unknown }): AddFailureKind {
  if (sonarrValidationMessages(res.body).some((m) => /already\s*(been\s*)?(added|exists)/i.test(m))) {
    return 'alreadyExists';
  }
  const status = res.status ?? 0;
  // 4xx is Sonarr refusing the payload - retrying an identical body cannot help.
  // Anything else (5xx, a timeout with no status at all) might.
  if (status >= 400 && status < 500) return 'invalid';
  return 'retryable';
}

/** The human-readable half of a Sonarr validation response, for display and matching. */
export function sonarrValidationMessages(body: unknown): string[] {
  if (!Array.isArray(body)) return [];
  return body
    .map((e: any) => (typeof e?.errorMessage === 'string' ? e.errorMessage : ''))
    .filter(Boolean);
}
