import prisma from '../db';
import { tvdbIdForAnilist, tmdbRefForAnilist, anilistTvdbMapReady } from './anilistTvdbMap';

// ---------------------------------------------------------------------------
// Which real series is this AniList entry?
//
// Identity and availability are different questions, and conflating them is
// what made this code generate a new false positive every few weeks. Identity
// is a permanent fact; availability changes every time something is grabbed or
// deleted. This module owns the first one.
//
// Resolution order:
//   1. our override table  — always wins, and is how a bad match gets fixed once
//   2. the community map   — answers 94% of TV, 0% of the rest
//   3. a remote lookup we make ourselves (see remoteIdentity.ts), which fills
//      about half of what the map misses and is POSITIVE-ONLY
//   4. nothing             — and only then may titles be consulted
//
// The override table is an *overlay*, not a mirror. Copying all 7,179 map rows
// into it would mean maintaining a second stale copy of something already
// correct; rows exist only where we know better than the map or the map is
// silent.
// ---------------------------------------------------------------------------

export interface Identity {
  tvdbId: string | null;
  /** TMDB id, namespaced — `kind` must be checked before comparing. */
  tmdbId: string | null;
  tmdbKind: 'tv' | 'movie' | null;
  /** Where the answer came from. `manual` means a human decided it. */
  source: 'manual' | 'map' | 'remote' | 'none';
  /** True only for a human-confirmed row. Drives the admin review list. */
  confirmed: boolean;
  /**
   * "This entry is definitively NOT in the library."
   *
   * Its own field rather than an inference from "confirmed with no ids",
   * because confirming a *good* title match also leaves the id boxes empty —
   * the two states are indistinguishable otherwise, and guessing wrong makes
   * the Reject button appear to work while the Watch button stays put. That
   * exact bug shipped for about ten minutes and was caught in a browser, not
   * by any type or build check.
   */
  rejected: boolean;
  /**
   * The ids here are a suggestion the resolver could not verify.
   *
   * It had no air date to check against — usually because we do not hold the
   * candidate — so the match rests on a search result alone. The ids are still
   * used: `matchSeries` treats a `remote` id as positive-only, so it can add a
   * Watch button and never remove one. What `pending` buys is honesty — the UI
   * marks it unverified and /admin/matching lists it for a one-click confirm.
   */
  pending: boolean;
  /** What the resolver matched against, so a reviewer needn't re-search. */
  matchedTitle: string | null;
  /** Every candidate the lookup returned, best-first. Drives the review picker. */
  candidates: RemoteChoice[] | null;
  /** How the id was arrived at, e.g. "remote: air date 3d". Shown when reviewing. */
  note: string | null;
}

/** One option the remote lookup returned. Mirrors `RemoteCandidate`. */
export interface RemoteChoice {
  tvdbId: string | null;
  tmdbId: string | null;
  tmdbKind: 'tv' | 'movie' | null;
  matchedTitle: string;
  exact: boolean;
  year: number | null;
}

const NONE: Identity = {
  tvdbId: null,
  tmdbId: null,
  tmdbKind: null,
  source: 'none',
  confirmed: false,
  rejected: false,
  pending: false,
  matchedTitle: null,
  candidates: null,
  note: null,
};

/**
 * In-memory copy of the override table.
 *
 * Small by construction (corrections only), read on every availability lookup,
 * and — like every other cache here — loaded from the DB at boot, because the
 * load these caches guard against is *caused* by restarts.
 */
let _overrides = new Map<number, Identity>();
let _loaded = false;

export async function loadIdentityOverrides(): Promise<void> {
  try {
    const rows = await prisma.seriesIdentity.findMany();
    const next = new Map<number, Identity>();
    for (const r of rows) {
      next.set(r.anilistId, {
        tvdbId: r.tvdbId ?? null,
        tmdbId: r.tmdbId ?? null,
        tmdbKind: (r.tmdbKind as 'tv' | 'movie' | null) ?? null,
        source: (r.source === 'remote' ? 'remote' : 'manual'),
        confirmed: !!r.confirmed,
        rejected: !!r.rejected,
        pending: !!r.pending,
        matchedTitle: r.matchedTitle ?? null,
        candidates: parseCandidates(r.candidates),
        note: r.note ?? null,
      });
    }
    _overrides = next;
    _loaded = true;
    if (next.size) console.log(`[identity] ${next.size} override(s) loaded`);
  } catch (err: any) {
    // Degraded, not broken: without overrides we fall back to the community map,
    // which is what shipped before this table existed.
    console.warn('[identity] could not load overrides:', err?.message ?? err);
    _loaded = true;
  }
}

/**
 * Resolve one AniList id to the ids the library and *arr apps understand.
 *
 * Synchronous on purpose: it runs inside the per-show availability loop, and an
 * await here would put a DB round-trip between a viewer and every Watch button.
 */
export function resolveIdentity(anilistId: number): Identity {
  const override = _overrides.get(anilistId);
  // Pending rows are returned too, and that is deliberate. They used to be
  // withheld because an unreviewed id could suppress a working match — but that
  // risk now lives where it belongs: `matchSeries` treats a `remote` id as
  // positive-only, so it can add a Watch button and never take one away.
  //
  // A row with NO ids is different, and must not win. The resolver writes one
  // to record "we looked and found nothing", so it doesn't re-search the same
  // dead end daily — but that is bookkeeping, not an answer. Returning it early
  // shadowed the community map *permanently*: once we had looked and failed,
  // Fribb adding the pair the next week could never take effect, because our
  // empty row answered first. A human decision (confirmed, or an explicit
  // rejection) is a real answer and still wins.
  const isBookkeeping =
    !!override && !override.tvdbId && !override.tmdbId && !override.confirmed && !override.rejected;
  if (override && !isBookkeeping) return override;

  const tvdbId = tvdbIdForAnilist(anilistId);
  const tmdb = tmdbRefForAnilist(anilistId);
  if (!tvdbId && !tmdb) return NONE;
  return {
    tvdbId,
    tmdbId: tmdb?.id ?? null,
    tmdbKind: tmdb?.kind ?? null,
    source: 'map',
    confirmed: false,
    rejected: false,
    pending: false,
    matchedTitle: null,
    candidates: null,
    note: null,
  };
}

/** Stored as JSON; a malformed row must degrade to "no options", never throw. */
function parseCandidates(raw: string | null | undefined): RemoteChoice[] | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as RemoteChoice[]) : null;
  } catch {
    return null;
  }
}

/**
 * Is an identity answer trustworthy enough to *cache*, and to reject a title
 * match on?
 *
 * Before the map has loaded, every lookup returns "no id" for the wrong reason —
 * not "this entry is unmapped" but "we haven't read the map yet". Treating that
 * as negative evidence would reject good title matches for the first seconds
 * after every restart, and caching it would pin the mistake for an hour.
 */
export function identityReady(): boolean {
  return _loaded && anilistTvdbMapReady();
}

export async function setIdentityOverride(input: {
  anilistId: number;
  tvdbId?: string | null;
  tmdbId?: string | null;
  tmdbKind?: 'tv' | 'movie' | null;
  confirmed?: boolean;
  rejected?: boolean;
  pending?: boolean;
  matchedTitle?: string | null;
  candidates?: RemoteChoice[] | null;
  note?: string | null;
  /** Who wrote it: a human on /admin/matching, or the background resolver. */
  source?: 'manual' | 'remote';
}): Promise<Identity> {
  const data = {
    tvdbId: input.tvdbId ?? null,
    tmdbId: input.tmdbId ?? null,
    tmdbKind: input.tmdbKind ?? null,
    source: input.source ?? 'manual',
    confirmed: input.confirmed ?? false,
    rejected: input.rejected ?? false,
    pending: input.pending ?? false,
    matchedTitle: input.matchedTitle ?? null,
    candidates: input.candidates ? JSON.stringify(input.candidates) : null,
    note: input.note ?? null,
    updatedAt: new Date(),
  };
  await prisma.seriesIdentity.upsert({
    where: { anilistId: input.anilistId },
    update: data,
    create: { anilistId: input.anilistId, ...data },
  });
  const identity: Identity = {
    tvdbId: data.tvdbId,
    tmdbId: data.tmdbId,
    tmdbKind: data.tmdbKind,
    source: data.source as 'manual' | 'remote',
    confirmed: data.confirmed,
    rejected: data.rejected,
    pending: data.pending,
    matchedTitle: data.matchedTitle,
    candidates: input.candidates ?? null,
    note: data.note,
  };
  _overrides.set(input.anilistId, identity);
  return identity;
}

export async function clearIdentityOverride(anilistId: number): Promise<void> {
  await prisma.seriesIdentity.deleteMany({ where: { anilistId } });
  _overrides.delete(anilistId);
}

export async function listIdentityOverrides() {
  return prisma.seriesIdentity.findMany({ orderBy: { updatedAt: 'desc' } });
}

export function identityOverrideCount(): number {
  return _overrides.size;
}

/**
 * The stored row exactly as written, pending included.
 *
 * `resolveIdentity` deliberately hides pending rows, because matching must not
 * use an unreviewed id. The admin page needs the opposite — it exists to *show*
 * those suggestions — so it reads through here instead.
 */
export function rawIdentityOverride(anilistId: number): Identity | null {
  return _overrides.get(anilistId) ?? null;
}

/**
 * Should the remote resolver look at this entry again?
 *
 * True when we still have no usable id and no human has settled it. A recorded
 * miss does NOT make an entry permanently off-limits — that was the bug: the
 * sweep filtered on "has any identity row", so a single failed search retired
 * the entry forever and the tiered retry below it could never fire. TMDB gains
 * records as a show approaches airing, which is exactly when it matters.
 */
export function needsRemoteLookup(anilistId: number): boolean {
  const o = _overrides.get(anilistId);
  if (o?.confirmed || o?.rejected) return false;      // a human has decided
  if (o?.tvdbId || o?.tmdbId) return false;           // we already have an id
  // No override worth keeping — but the map may still know it.
  return !tvdbIdForAnilist(anilistId) && !tmdbRefForAnilist(anilistId);
}

/**
 * Test seam: set the in-memory overrides directly.
 *
 * The real loader reads the DB. These invariants are about *precedence* — which
 * source answers when several could — and that is pure logic worth testing
 * without a database.
 */
export function __setOverridesForTest(rows: Record<number, Identity>): void {
  _overrides = new Map(Object.entries(rows).map(([k, v]) => [Number(k), v]));
  _loaded = true;
}
