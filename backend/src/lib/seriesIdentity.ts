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
//   1. our override table  - always wins, and is how a bad match gets fixed once
//   2. the community map   - answers 94% of TV, 0% of the rest
//   3. a remote lookup we make ourselves (see remoteIdentity.ts), which fills
//      about half of what the map misses and is POSITIVE-ONLY
//   4. nothing             - and only then may titles be consulted
//
// The override table is an *overlay*, not a mirror. Copying all 7,179 map rows
// into it would mean maintaining a second stale copy of something already
// correct; rows exist only where we know better than the map or the map is
// silent.
// ---------------------------------------------------------------------------

export interface Identity {
  tvdbId: string | null;
  /** TMDB id, namespaced - `kind` must be checked before comparing. */
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
   * because confirming a *good* title match also leaves the id boxes empty -
   * the two states are indistinguishable otherwise, and guessing wrong makes
   * the Reject button appear to work while the Watch button stays put. That
   * exact bug shipped for about ten minutes and was caught in a browser, not
   * by any type or build check.
   */
  rejected: boolean;
  /**
   * The ids here are a suggestion the resolver could not verify.
   *
   * It had no air date to check against - usually because we do not hold the
   * candidate - so the match rests on a search result alone. The ids are still
   * used: `matchSeries` treats a `remote` id as positive-only, so it can add a
   * Watch button and never remove one. What `pending` buys is honesty - the UI
   * marks it unverified and /admin/matching lists it for a one-click confirm.
   */
  pending: boolean;
  /** What the resolver matched against, so a reviewer needn't re-search. */
  matchedTitle: string | null;
  /** The lookup's top candidates (up to eight), best-first. Drives the review picker. */
  candidates: RemoteChoice[] | null;
  /** How the id was arrived at, e.g. "remote: air date 3d". Shown when reviewing. */
  note: string | null;
  /** Release year from whatever source named the identity. Display only. */
  year: number | null;
  /**
   * Which resolver wrote this row (see RESOLVER_VERSION).
   *
   * Absent or null on rows stored before the stamp existed, and on identities
   * the community map supplied (nothing stored, nothing to re-grade). It is
   * what lets a matcher improvement reach rows already decided: the sweep skips
   * any entry that carries an id, so without this a better ladder fixed only
   * NEW lookups.
   */
  resolverVersion?: number | null;
}

/** One option the remote lookup returned. Mirrors `RemoteCandidate`. */
export interface RemoteChoice {
  tvdbId: string | null;
  tmdbId: string | null;
  tmdbKind: 'tv' | 'movie' | null;
  matchedTitle: string;
  exact: boolean;
  year: number | null;
  /** Present on rows stored since the lookup gained posters; older rows lack it. */
  image?: string | null;
  /**
   * Day-precision premiere (`yyyy-mm-dd`). Present (possibly null) on rows
   * stored since the resolver read dates; its ABSENCE is how the sweep's
   * re-grade pass recognises a row decided blind to them.
   */
  premiereDate?: string | null;
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
  year: null,
  resolverVersion: null,
};

/**
 * In-memory copy of the override table.
 *
 * Small by construction (corrections only), read on every availability lookup,
 * and - like every other cache here - loaded from the DB at boot, because the
 * load these caches guard against is *caused* by restarts.
 */
let _overrides = new Map<number, Identity>();
let _loaded = false;

/**
 * Run when an identity row is written or removed, with the anilistId.
 *
 * The availability cache in routes/jellyfin.ts embeds identity answers, so an
 * identity write must bust (and re-persist) the cached verdict - the route
 * handlers used to do this themselves, which left the daily sweep's writes
 * uncovered and never rewrote the persisted blob, so a restart inside the
 * debounce window resurrected the pre-correction verdict. The cache registers
 * here instead; every writer - admin PUT/DELETE and all three sweep call
 * sites - then notifies without knowing the cache exists.
 */
const _changeListeners: Array<(anilistId: number) => void> = [];

export function onIdentityChanged(cb: (anilistId: number) => void): void {
  _changeListeners.push(cb);
}

function notifyIdentityChanged(anilistId: number): void {
  for (const cb of _changeListeners) {
    try {
      cb(anilistId);
    } catch {
      // A listener must never break the write it is reacting to.
    }
  }
}

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
        year: r.year ?? null,
        resolverVersion: (r as { resolverVersion?: number | null }).resolverVersion ?? null,
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
  // Pending rows are returned too, and that is deliberate: a remote id is
  // positive-only - see `pending` on Identity above.
  //
  // A row with NO ids is different, and must not win. The resolver writes one
  // to record "we looked and found nothing", so it doesn't re-search the same
  // dead end daily - but that is bookkeeping, not an answer. Returning it early
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
    year: null,
    // The map isn't a stored decision, so there is nothing to re-grade.
    resolverVersion: null,
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
 * Before the map has loaded, every lookup returns "no id" for the wrong reason -
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
  /** Release year from the source that named the identity. Display only. */
  year?: number | null;
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
    year: input.year ?? null,
    // Stamped on every write, so "which resolver decided this" is never a
    // guess and the regrade pass can select on it.
    resolverVersion: RESOLVER_VERSION,
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
    year: data.year,
    resolverVersion: data.resolverVersion,
  };
  _overrides.set(input.anilistId, identity);
  notifyIdentityChanged(input.anilistId);
  return identity;
}

/** What a caller may send when editing an identity row. */
export interface IdentityPatch {
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
  year?: number | null;
  source?: 'manual' | 'remote';
}

/**
 * Merge an edit onto the stored row: absent means "keep what's stored",
 * an explicit value (including null) means "change it".
 *
 * Only provenance/display fields are preserved - `note`, `matchedTitle`,
 * `candidates`, `year`, `source`. Everything else passes through exactly as sent, because the review
 * page always sends the id/flag fields it means. Without this, one click of
 * Confirm relabelled a resolver id as a human decision (`source` defaulted back
 * to 'manual') and erased which rung of the ladder accepted it (`note` -> null)
 * - the review page destroyed its own evidence.
 *
 * This lives here and NOT inside `setIdentityOverride`, whose absent-means-null
 * contract the sweep depends on: its "no match" bookkeeping write omits
 * `candidates` precisely because a row that means "we found nothing" must not
 * keep a stale candidate list.
 */
export function mergeIdentityPatch(existing: Identity | null, patch: IdentityPatch): IdentityPatch {
  if (!existing) return patch;
  return {
    ...patch,
    note: patch.note !== undefined ? patch.note : existing.note,
    matchedTitle: patch.matchedTitle !== undefined ? patch.matchedTitle : existing.matchedTitle,
    candidates: patch.candidates !== undefined ? patch.candidates : existing.candidates,
    year: patch.year !== undefined ? patch.year : existing.year,
    source: patch.source !== undefined ? patch.source : (existing.source === 'remote' ? 'remote' : 'manual'),
  };
}

export async function clearIdentityOverride(anilistId: number): Promise<void> {
  await prisma.seriesIdentity.deleteMany({ where: { anilistId } });
  _overrides.delete(anilistId);
  notifyIdentityChanged(anilistId);
}

export async function listIdentityOverrides() {
  return prisma.seriesIdentity.findMany({ orderBy: { updatedAt: 'desc' } });
}

export function identityOverrideCount(): number {
  return _overrides.size;
}

/**
 * The stored row exactly as written - bookkeeping rows included.
 *
 * `resolveIdentity` withholds an id-less bookkeeping row so it can't shadow
 * the community map (pending rows with ids it returns - they're positive-only).
 * The admin page needs the raw truth either way: it exists to show what was
 * recorded, so it reads through here instead.
 */
export function rawIdentityOverride(anilistId: number): Identity | null {
  return _overrides.get(anilistId) ?? null;
}

/**
 * The resolver's own version. **Bump it whenever a change would decide an
 * already-stored row differently** - a new/changed acceptance rung, a change to
 * how candidates are ranked or merged. Rows stamped below it are re-resolved by
 * `regradeStoredRows`, which stamps them current, so the pass drains and stops.
 *
 * History, so a reader can tell what a stamp means:
 *   1 - first stamped resolver: air-date ladder, premiere-date ranking outside
 *       tolerance, cross-provider candidate merge on an id reference.
 *   2 - the TVDB season premiere is consulted BEFORE accepting on title text,
 *       and is now fetched for that shape rather than only to rescue a
 *       rejection. Every row stamped 1 that reads `remote: exact title` is a
 *       candidate to become `remote: tvdb season premiere Nd`, i.e. weak ->
 *       dateVerified. Audit behind it: tools/audit_premiere_dates.py.
 *   3 - that fetch also covers a candidate whose date REFUTES, which is what a
 *       SEQUEL always looks like: a search result carries the series' first-ever
 *       air date, so season 2 measures years "off" its own parent. Measured on
 *       FALL 2026 - 27 of 33 pending rows were sequels, and Aoashi 2nd Season /
 *       Tokyo Revengers S4 / Black Clover 2nd Season sat 1,639d / 2,013d /
 *       3,597d from the series date while landing 0d from their own season
 *       premiere. Rows stamped 2 that are pending sequels re-decide under this.
 *   4 - that fetch also reaches a TMDB-ONLY candidate, by cross-walking its
 *       TMDB id to a TVDB one through the community map. Until then the season
 *       rung was gated on the candidate already carrying a TVDB id, so half the
 *       search results could never be dated by it - the id was filled in by
 *       `completeIdentityIds` afterwards, which made the row look as though it
 *       had been available. Measured on FALL 2026: `Kizu darake Seijo yori
 *       Houfuku wo Komete Season2` sat `unverified` while TVDB's season 2
 *       premiere matched its AniList premiere to the day.
 */
export const RESOLVER_VERSION = 4;

/**
 * Did a DATE vouch for this resolver id, as opposed to title text or a year?
 *
 * The rung is recorded in the note at accept time, and only three of them are
 * date evidence. That distinction is the strongest signal in this codebase -
 * correct matches land 0-31 days from the AniList premiere and wrong ones
 * 62-21,929, with nothing in between - so a date-verified resolver row is as
 * settled as a community-map id.
 *
 * `exact title` and `release year` are deliberately NOT dates: an exact title
 * 1,012 days from the premiere is the Echo class, and a +/-1 production year is
 * nearly free for an unrelated sibling.
 */
const DATE_RUNGS = ['remote: air date', 'remote: premiere date', 'remote: tvdb season premiere'];

export function isDateVerified(note: string | null | undefined): boolean {
  const n = note ?? '';
  return DATE_RUNGS.some((r) => n.startsWith(r));
}

/**
 * How well do we actually know this identity?
 *
 * Ordered strongest first. The distinctions are not cosmetic - each one was
 * learned from a real mistake, and they are recorded here so both the viewer's
 * correction picker and the Sonarr admin page read the same vocabulary:
 *
 *  - `confirmed` / `adminOverride` - a human decided. Permanent.
 *  - `map`        - a community-map pair. Unconfirmed by construction, and
 *                   still the most reliable thing we have (94% of TV).
 *  - `dateVerified` - a resolver id a DATE vouched for. As settled as a map id:
 *                   correct results land 0-31 days from the AniList premiere
 *                   and wrong ones 62-21,929, with nothing in between.
 *  - `viewerPick` - a viewer's correction. Deliberately NOT confident: it is
 *                   unconfirmed by construction and queued for review. Treating
 *                   it as settled once hid the picker - and the undo inside it -
 *                   the instant anyone used it.
 *  - `weak`       - a resolver id accepted on title text or a +/-1 release year.
 *                   The Echo class: an exact title 1,012 days from the premiere.
 *  - `none`       - no id at all.
 */
export type MatchGrade =
  | 'confirmed'
  | 'adminOverride'
  | 'map'
  | 'dateVerified'
  | 'viewerPick'
  | 'weak'
  | 'none';

/**
 * 31 days - the same gap as `AIR_DATE_TOLERANCE_MS`. Correct matches land 0-31d
 * from the entry's premiere and wrong ones 62d and out, with nothing between.
 */
export const CANDIDATE_TOLERANCE_MS = 31 * 86_400_000;

/**
 * Did the entry's own premiere date SEPARATE a multi-candidate row?
 *
 * `/admin/matching` queues every row carrying more than one candidate, and that
 * rule is right for the case it was written for - Echo's three candidates are
 * all titled "Echo" and are three different films. But it also fired on rows a
 * date had already settled TO THE DAY, so the reviewer's queue filled with
 * Confirm clicks on matches nothing disputed: 142 of the 170 premiere-date-rung
 * multi-candidate rows stored here, measured 2026-09-21.
 *
 * It lives HERE, beside `matchGrade`, for the reason that function does: the
 * page asked the same question and a correctness rule with two copies is one
 * that can disagree with itself. The page renders this verdict; it never
 * computes one.
 *
 * Three conditions, each excluding a case that measurement found:
 *
 *  - EXACTLY ONE candidate inside tolerance. 21 rows have two or more, which is
 *    the date failing to discriminate - precisely the reviews worth having.
 *  - NO undated sibling. 7 rows have one, among them `Cyborg 009: Nemesis`,
 *    which exists twice in TVDB with one copy undated. Nothing proves the two
 *    are the same show, which is why `mergeCrossReferencedCandidates` refuses
 *    to merge them either; settling it here would undo that decision by a side
 *    door.
 *  - the STORED PICK is that candidate. 1 of the 146 otherwise-separable rows
 *    had stored a refuted one, and settling it would pin a match the date
 *    actively disagrees with.
 *
 * Two shapes are left alone BY CONSTRUCTION rather than by a special case, and
 * both matter. Echo's nearest candidate is 46 days out, so nothing lands inside
 * and the row stays queued. And a row accepted on the TVDB *season* premiere
 * carries that evidence in the season date, not in any candidate's own
 * `premiereDate` - so no candidate reads as inside and this returns false. That
 * rung was not measured for this rule and must not be settled on evidence this
 * function cannot see.
 */
export function dateSettlesCandidates(
  candidates: Array<{ tvdbId?: string | null; tmdbId?: string | null; premiereDate?: string | null }>
    | null | undefined,
  airDateMs: number | null | undefined,
  stored: { tvdbId?: string | null; tmdbId?: string | null }
): boolean {
  const cands = candidates ?? [];
  if (cands.length <= 1 || airDateMs == null) return false;
  let winner: { tvdbId?: string | null; tmdbId?: string | null } | null = null;
  for (const c of cands) {
    const prem = c.premiereDate ? Date.parse(c.premiereDate) : NaN;
    // An undated sibling settles nothing: "we do not know when it aired" is not
    // evidence against it, and reading it as such is the `unknown` mistake.
    if (!Number.isFinite(prem)) return false;
    if (Math.abs(prem - airDateMs) > CANDIDATE_TOLERANCE_MS) continue;
    if (winner) return false;
    winner = c;
  }
  if (!winner) return false;
  return (!!stored.tvdbId && winner.tvdbId === stored.tvdbId)
    || (!!stored.tmdbId && winner.tmdbId === stored.tmdbId);
}

export function matchGrade(identity: Identity): MatchGrade {
  if (identity.confirmed) return 'confirmed';
  if (identity.source === 'manual') {
    return (identity.note ?? '').startsWith('viewer:') ? 'viewerPick' : 'adminOverride';
  }
  if (identity.source === 'map') return 'map';
  if (identity.source === 'remote') {
    return isDateVerified(identity.note) ? 'dateVerified' : 'weak';
  }
  return 'none';
}

/**
 * Do we actually KNOW which show this is?
 *
 * The single definition, so the Watch pop-up's correction picker and the Sonarr
 * page cannot drift apart on what "certain" means. A rejection counts: "this is
 * definitively not in the library" is knowledge too, and it must suppress the
 * title fallback rather than invite a correction.
 */
export function isIdConfident(identity: Identity): boolean {
  if (identity.rejected) return true;
  const grade = matchGrade(identity);
  return grade === 'confirmed' || grade === 'adminOverride' || grade === 'map' || grade === 'dateVerified';
}

/**
 * Is this stored row from an older resolver, and safe to re-decide?
 *
 * Only rows the machine decided and that carry an id: a human decision is
 * permanent, and an id-less bookkeeping row is already re-asked by the main
 * sweep on its retry tier (regrading it too would spend the budget twice).
 */
export function needsRegrade(
  row: {
    source: string;
    confirmed: boolean;
    rejected: boolean;
    tvdbId: string | null;
    tmdbId: string | null;
    resolverVersion?: number | null;
  },
  currentVersion: number = RESOLVER_VERSION
): boolean {
  if (row.source !== 'remote' || row.confirmed || row.rejected) return false;
  if (!row.tvdbId && !row.tmdbId) return false;
  return (row.resolverVersion ?? 0) < currentVersion;
}

/**
 * Should the remote resolver look at this entry again?
 *
 * True when we still have no usable id and no human has settled it. A recorded
 * miss does NOT make an entry permanently off-limits - that was the bug: the
 * sweep filtered on "has any identity row", so a single failed search retired
 * the entry forever and the tiered retry below it could never fire. TMDB gains
 * records as a show approaches airing, which is exactly when it matters.
 */
export function needsRemoteLookup(anilistId: number): boolean {
  const o = _overrides.get(anilistId);
  if (o?.confirmed || o?.rejected) return false;      // a human has decided
  if (o?.tvdbId || o?.tmdbId) return false;           // we already have an id
  // No override worth keeping - but the map may still know it.
  return !tvdbIdForAnilist(anilistId) && !tmdbRefForAnilist(anilistId);
}

/**
 * Test seam: set the in-memory overrides directly.
 *
 * The real loader reads the DB. These invariants are about *precedence* - which
 * source answers when several could - and that is pure logic worth testing
 * without a database.
 */
export function __setOverridesForTest(rows: Record<number, Identity>): void {
  _overrides = new Map(Object.entries(rows).map(([k, v]) => [Number(k), v]));
  _loaded = true;
}
