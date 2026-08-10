// ---------------------------------------------------------------------------
// Did something we added get deleted - and should we stop proposing it?
//
// The failure this closes: a series is deleted from Sonarr without an Import
// List Exclusion being set, so our list proposes it again and Sonarr grabs it
// again. Forever. Maintainerr sets the exclusion when it does the deleting; a
// human deleting by hand has a checkbox that is easy to miss.
//
// **We cannot win the race.** Sonarr's Import List Sync is a hardcoded
// ~5-minute task, so by the time any snapshot of ours notices a deletion the
// series is already back. The honest value of this module is bounding an
// *unbounded* loop to *one extra grab*. Sonarr's own exclusion is the primary
// defence and is why Maintainerr's `listExclusions` is mandatory, not advisory.
//
// This is deliberately a pure function with no I/O: the caller reads Sonarr and
// writes the DB, and every rule below is unit-tested without either. It is also
// why the module imports nothing - the structural types below are satisfied by
// `SonarrSeries` from `lib/sonarrApi.ts` without creating a dependency on it.
// ---------------------------------------------------------------------------

/** One stored row: what we know about a tvdbId we have proposed and seen held. */
export interface SeenRow {
  tvdbId: number;
  /** The AniList entry this was added *for*, which is what makes orphans visible. */
  anilistId: number | null;
  title: string;
  firstHeldAt: Date | null;
  lastHeldAt: Date | null;
  /** Non-null IS the suppression. Set when something we saw held goes missing. */
  goneAt: Date | null;
  /** Does the held series carry our import-list tag? Display + Maintainerr scoping. */
  taggedByUs: boolean;
}

/** The fields of a held series this module reads. `SonarrSeries` satisfies it. */
export interface HeldSeries {
  tvdbId: number;
  title: string;
  tags: number[];
}

/** The result of one read of Sonarr's library. `SonarrSnapshot` satisfies it. */
export interface SnapshotLike {
  ok: boolean;
  series: HeldSeries[];
  error?: string;
}

/**
 * Sonarr holds a series we added for an AniList entry that has since been
 * re-identified. Nothing on our side removes it, and we now also propose the
 * corrected id - so the library ends up with both.
 */
export interface Orphan {
  /** The series Sonarr holds and should not. */
  tvdbId: number;
  title: string;
  /** The AniList entry it was added for. */
  anilistId: number;
  /** What that entry resolves to now. */
  nowTvdbId: number;
}

export interface ReconcileInput {
  prior: SeenRow[];
  snapshot: SnapshotLike;
  /** tvdbId -> anilistId for everything currently proposed. */
  proposed: Map<number, number>;
  /** anilistId -> the tvdbId it resolves to *now*, for orphan detection. */
  currentIdentity: Map<number, number>;
  /** Sonarr's id for our tag, or null when the tag does not exist there yet. */
  tagId: number | null;
  now: Date;
}

export interface ReconcileResult {
  /** Rows to write. Empty when the snapshot could not be trusted. */
  upserts: SeenRow[];
  /** tvdbIds newly suppressed by this run - i.e. newly observed as deleted. */
  suppressed: number[];
  orphans: Orphan[];
  /** Non-null when the run deliberately changed nothing, and why. */
  skipped: string | null;
}

/**
 * Fold one Sonarr snapshot into what we already knew.
 *
 * Rules, in order, each with its own test:
 *
 *  1. Proposed and now held -> record it; a re-appearance clears `goneAt`, so
 *     re-adding something by hand un-suppresses it.
 *  2. Previously held and no longer held -> set `goneAt`. **That is the
 *     suppression.** Nobody deletes by accident, so this needs no confirmation
 *     step and no human in the loop.
 *  3. A failed snapshot changes NOTHING - not one row.
 *  4. **An empty library is treated as a failure, never as mass deletion.**
 *     This is the most dangerous line in the feature: one bad read would
 *     otherwise suppress the entire list permanently, and the failure would look
 *     exactly like "the list correctly has nothing to add". The precedent is
 *     real - an analysis script written during this feature's design read the
 *     wrong key out of the library blob, got an empty set, and confidently
 *     reported all 39 proposals as new grabs. Same bug, opposite sign. An
 *     genuinely empty Sonarr costs us nothing here: we would have no prior held
 *     rows either, so there is nothing to suppress.
 *  5. Suppression keys on "we proposed it and it was held", NOT on the tag.
 *     Otherwise deleting a show you had added by hand lets us silently
 *     re-acquire it: we propose it, Sonarr adds it (and only then tags it), and
 *     it is back without anyone asking.
 */
export function reconcileSeen(input: ReconcileInput): ReconcileResult {
  const { prior, snapshot, proposed, currentIdentity, tagId, now } = input;

  if (!snapshot.ok) {
    return { upserts: [], suppressed: [], orphans: [], skipped: `snapshot failed: ${snapshot.error ?? 'unknown'}` };
  }
  if (snapshot.series.length === 0) {
    return {
      upserts: [],
      suppressed: [],
      orphans: [],
      skipped: 'snapshot returned an empty library - treated as "could not ask", never as mass deletion',
    };
  }

  const held = new Map<number, HeldSeries>();
  for (const s of snapshot.series) held.set(s.tvdbId, s);

  const priorBy = new Map<number, SeenRow>();
  for (const row of prior) priorBy.set(row.tvdbId, row);

  const upserts: SeenRow[] = [];
  const suppressed: number[] = [];
  const orphans: Orphan[] = [];

  // Rule 1 - anything we propose that Sonarr currently holds.
  for (const [tvdbId, anilistId] of proposed) {
    const hit = held.get(tvdbId);
    if (!hit) continue;
    const existing = priorBy.get(tvdbId);
    upserts.push({
      tvdbId,
      anilistId,
      title: hit.title || existing?.title || '',
      firstHeldAt: existing?.firstHeldAt ?? now,
      lastHeldAt: now,
      goneAt: null,
      taggedByUs: tagId !== null && hit.tags.includes(tagId),
    });
  }

  // Rule 2 - anything we have seen held that Sonarr no longer holds.
  for (const row of prior) {
    if (row.lastHeldAt === null) continue;   // never actually held; nothing to lose
    if (held.has(row.tvdbId)) continue;      // still there
    if (row.goneAt !== null) continue;       // already suppressed, don't re-report
    upserts.push({ ...row, goneAt: now });
    suppressed.push(row.tvdbId);
  }

  // Orphans - held for an entry that has since been re-identified. Reported
  // rather than acted on: removing it needs write credentials we deliberately
  // do not take, so this is the one thing here that requires a human.
  for (const row of prior) {
    if (row.anilistId === null) continue;
    if (!held.has(row.tvdbId)) continue;     // nothing to delete
    const nowTvdbId = currentIdentity.get(row.anilistId);
    if (nowTvdbId === undefined || nowTvdbId === row.tvdbId) continue;
    orphans.push({
      tvdbId: row.tvdbId,
      title: held.get(row.tvdbId)?.title || row.title,
      anilistId: row.anilistId,
      nowTvdbId,
    });
  }

  return { upserts, suppressed, orphans, skipped: null };
}

/**
 * The tvdbIds the list must stop proposing.
 *
 * Force-includes win: that is how a suppression is undone, and it is the only
 * direction of override this feature has - "never add this" is Sonarr's
 * exclusion, which is global and beats us anyway.
 */
export function suppressedTvdbIds(rows: SeenRow[], forceIncluded: Set<number>): Set<number> {
  const out = new Set<number>();
  for (const row of rows) {
    if (row.goneAt === null) continue;
    if (forceIncluded.has(row.tvdbId)) continue;
    out.add(row.tvdbId);
  }
  return out;
}
