import { anilistDateToMs } from './episodeMatch';
import { VALID_SEASONS, type Season } from './validateSeason';

// ---------------------------------------------------------------------------
// Which seasonal entries should Sonarr auto-add?
//
// Pure and I/O-free on purpose: the resolver is injected, so every rule below
// is unit-testable without a database, a network, or a warm cache. The route
// (routes/sonarr.ts) holds no judgement at all - it reads SeasonCache, calls
// this, and serialises. The route's header docstring is where the *why* of the
// whole feature lives; this file explains only its own predicates.
//
// The question here is SCOPE - which shows do we choose to auto-add - and it is
// deliberately not the question lib/animeMatch.ts and lib/remoteIdentity.ts
// answer, which is IDENTITY: is this the right series. The two use overlapping
// evidence and must not borrow each other's rules; where that matters it is
// commented at the predicate.
// ---------------------------------------------------------------------------

/** One row of the array Sonarr's Custom List consumes. Nothing else is read. */
export interface SonarrListItem {
  title: string;
  tvdbId: number;
}

/**
 * The bits of an identity this module needs.
 *
 * Structurally a subset of `Identity` (lib/seriesIdentity.ts), declared here so
 * this module imports nothing that touches the DB - `resolveIdentity` passes
 * straight in as the `resolve` argument.
 */
export interface SonarrIdentity {
  tvdbId: string | null;
  pending: boolean;
  rejected: boolean;
}

/**
 * The fields of a `SeasonCache` entry this module reads.
 *
 * All optional: the cache holds parsed upstream JSON, so any field can be
 * missing or the wrong shape on some row, and a throw here would 500 a route
 * Sonarr polls every six hours.
 */
export interface SonarrCandidate {
  id?: number;
  title?: { english?: string | null; romaji?: string | null; native?: string | null } | null;
  format?: string | null;
  isAdult?: boolean | null;
  status?: string | null;
  startDate?: { year?: number | null; month?: number | null; day?: number | null } | null;
  relations?: { edges?: Array<{ relationType?: string | null } | null> | null } | null;
}

/**
 * How far ahead of a premiere we hand a show to Sonarr.
 *
 * Two weeks is lead time, not a coverage gate: measured 2026-08-06 against the
 * live cache, 71% of the next season's entries already carried a TVDB id eight
 * weeks out and 76% five months out, so waiting buys almost nothing. What it
 * buys is not asking Sonarr - which searches Anime-type series episode by
 * episode across every alias - to hunt for a series that has no episodes yet,
 * for months on end.
 *
 * Deliberately NOT `LOOKAHEAD_DAYS` (frontend/src/stores/season.ts), which
 * governs what the *site displays* and is a different question with its own
 * history. Coupling them would let a display tweak silently change what gets
 * downloaded.
 */
export const DEFAULT_WITHIN_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Sonarr is a TV app and TVDB is a TV database; movies are a Radarr topic. */
const WANTED_FORMATS = new Set(['TV', 'TV_SHORT']);

/**
 * Statuses that mean "this has already started broadcasting".
 *
 * `HIATUS` belongs here: it aired and paused, so a season 1 exists to grab.
 * `CANCELLED` does not - there is nothing to get - and it is listed explicitly
 * below rather than left to the date branch, where a cancelled show with a past
 * start date would read as airing.
 */
const AIRED_STATUSES = new Set(['RELEASING', 'FINISHED', 'HIATUS']);

export interface SeasonRef {
  season: Season;
  year: number;
}

/**
 * The current season by calendar, and the one after it.
 *
 * Strictly calendar-derived - no look-ahead, no "we're nearly there" fudge.
 * Narrowing to what is actually close to airing is `isWithinAirWindow`'s job,
 * and keeping that in one place is what stops this becoming a second copy of
 * the site's display heuristic.
 *
 * **UTC getters, not local ones.** `anilistDateToMs` builds UTC timestamps, so
 * reading the month in server-local time mixes two calendars: west of UTC the
 * first hours of a season start read as the *previous* season, and
 * `2026-01-01T00:00:00Z` resolves to FALL **2025**. A draft of this function
 * used `getMonth()`/`getFullYear()` and the rollover test below caught it; in
 * production it would have been silent, serving the wrong two seasons for a few
 * hours, four times a year.
 */
export function seasonsForSonarr(now: Date): [SeasonRef, SeasonRef] {
  const idx = Math.floor(now.getUTCMonth() / 3); // 0..3, matching VALID_SEASONS order
  const current: SeasonRef = { season: VALID_SEASONS[idx], year: now.getUTCFullYear() };
  const nextIdx = (idx + 1) % 4;
  const next: SeasonRef = {
    season: VALID_SEASONS[nextIdx],
    year: nextIdx === 0 ? current.year + 1 : current.year,
  };
  return [current, next];
}

/**
 * Only TV and TV_SHORT.
 *
 * An explicit allow-list: a format AniList adds later must be opted into rather
 * than inherited. MOVIE is excluded by choice *and* by force - only ~3% of
 * MOVIE entries carry a TVDB id at all, because TVDB is a TV database.
 */
export function isWantedFormat(entry: SonarrCandidate): boolean {
  return WANTED_FORMATS.has(String(entry.format ?? ''));
}

/**
 * Nothing aired before this: no `PREQUEL` and no `PARENT` relation edge.
 *
 * **Do not reuse the sequel predicates in `AnimeGridTranslate.svelte`,
 * `tools/local_translate.py` or `backend/scripts/batch_translate.py`.** All
 * three test "has ANY of SEQUEL/PREQUEL/SIDE_STORY", which hides a genuine
 * season 1 merely for *having* a sequel - the opposite of what is wanted here.
 * (They also list `SPINOFF`; AniList spells it `SPIN_OFF`, so that key is dead
 * and spin-offs are never tagged. A real bug, but fixing it would change what
 * the site's Hide-sequels toggle hides, so it is not this module's to fix.)
 *
 * **Deliberate deviation from a documented measurement - flagged so nobody
 * "corrects" it.** `remoteIdentity.ts` records that an `isRelation` guard on
 * PARENT/PREQUEL was tried, was wrong, and was removed: relation type does not
 * separate right from wrong, air date does, by three orders of magnitude. That
 * finding is about IDENTITY - is this search result the right series - where
 * mapping a sequel onto its parent is *correct*, because TVDB and TMDB put
 * seasons inside one series. This predicate answers SCOPE instead, and a false
 * skip costs nothing: the show simply isn't auto-added, and anyone can still
 * request it in Seerr.
 *
 * For the same reason `detectSeasonNumber()` is NOT used as a second signal -
 * it is exactly the title heuristic that warning is about, it has documented
 * blind spots (`Part 2`, roman numerals, bare trailing digits, named arcs), and
 * split cours legitimately share one TVDB season, so a "2" in a title against
 * season 1 in TVDB is normal rather than an error.
 *
 * Validated 2026-08-06 against the live cache: of 66 entries that survived this
 * across the current and next seasons, the remaining relation sets were only
 * ADAPTATION / ALTERNATIVE / OTHER / CHARACTER, and none had a title matching
 * `2nd|3rd|Season 2|Part 2|Final Season`.
 */
export function isFirstSeason(entry: SonarrCandidate): boolean {
  const edges = entry.relations?.edges;
  if (!Array.isArray(edges)) return true;
  for (const edge of edges) {
    const t = edge?.relationType;
    if (t === 'PREQUEL' || t === 'PARENT') return false;
  }
  return true;
}

/**
 * Has it aired, or will it within `withinDays`?
 *
 * Mirrors the convention `isUnaired()` encodes in
 * `frontend/src/stores/jellyfin.ts`: **status is authoritative when present,
 * `startDate` is the fallback, and a partial date means the earliest day it
 * could mean** - which is what `anilistDateToMs` already does. Those rules were
 * measured, not guessed, and there is no `shared/` directory, so if this and the
 * frontend helper ever disagree about a partial date the site and the feed
 * disagree about whether a show has aired.
 *
 * The one adaptation: `isUnaired` asks "has it aired", which a status alone can
 * answer. This asks "will it air soon", which it cannot - so a
 * `NOT_YET_RELEASED` entry still has to be judged on its date. An entry with
 * neither an aired status nor a usable date is excluded: an undated future
 * series has nothing for Sonarr to monitor, and the six-hourly re-poll picks it
 * up as soon as it gains a date.
 *
 * There is **no lower bound**, deliberately. The season scoping is the past-side
 * bound. Evicting a show once it is N days into its run would drop exactly the
 * entries whose TVDB id only appears *after* they premiere - the coverage curve
 * that makes this a list re-polled forever rather than a one-shot sync.
 */
export function isWithinAirWindow(
  entry: SonarrCandidate,
  now: Date,
  withinDays: number = DEFAULT_WITHIN_DAYS
): boolean {
  const status = entry.status ?? null;
  if (status && AIRED_STATUSES.has(status)) return true;
  if (status === 'CANCELLED') return false;
  const startMs = anilistDateToMs(entry.startDate ?? null);
  if (startMs === null) return false;
  return startMs <= now.getTime() + withinDays * DAY_MS;
}

/**
 * The TVDB id we are willing to hand Sonarr, or null.
 *
 * **The filter is `tvdbId && !pending && !rejected` - NOT `confirmed`.** A
 * community-map row comes back unconfirmed by construction (`source: 'map'`),
 * so requiring confirmation would discard the ~94% of TV the map answers, for
 * no gain.
 *
 * `pending` IS excluded, and that is the one place this is stricter than the
 * site. The UI treats an unverified resolver id as positive-only because a bad
 * guess there is cosmetic - a Watch button that doesn't work. Here a bad guess
 * downloads a whole season of the wrong series.
 */
export function usableTvdbId(identity: SonarrIdentity | null | undefined): number | null {
  if (!identity || identity.pending || identity.rejected) return null;
  if (!identity.tvdbId) return null;
  // `Identity.tvdbId` is a string. Coerce, and refuse anything that isn't a
  // positive integer rather than letting `NaN` or `0` reach Sonarr as a row it
  // would silently fail to look up.
  const n = Number(identity.tvdbId);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * English, then romaji, then native.
 *
 * Display only - Sonarr matches on the id and uses this for the list preview,
 * so the goal is simply the name a human will recognise in that preview.
 */
export function pickTitle(entry: SonarrCandidate): string | null {
  const t = entry.title ?? {};
  const chosen = t.english || t.romaji || t.native;
  return typeof chosen === 'string' && chosen.trim() ? chosen.trim() : null;
}

/** Why an entry did not make the list. Ordered as the gates run. */
export type RejectReason =
  | 'malformed'
  | 'format'
  | 'adult'
  | 'notFirstSeason'
  | 'outsideAirWindow'
  | 'noAnilistId'
  | 'noUsableTvdbId'
  | 'duplicateTvdbId'
  | 'noTitle';

export interface SonarrSelection {
  items: SonarrListItem[];
  /** Every entry that did not make it, with the gate that stopped it. */
  rejected: Array<{ entry: SonarrCandidate; reason: RejectReason }>;
}

export interface SelectOptions {
  /** Defaults to `DEFAULT_WITHIN_DAYS`. */
  withinDays?: number;
}

/**
 * The full result, including why each entry was dropped.
 *
 * The reasons exist for `tools/sonarr_dryrun.py`, and they are the difference
 * between a reviewable dry run and an unreviewable one: "39 proposed" tells you
 * nothing, "46 dropped on format, 24 on a PREQUEL/PARENT edge, 2 with no TVDB
 * id" tells you whether the filter is doing what you think.
 *
 * `shows` is parsed `SeasonCache.data` and therefore untrusted upstream JSON;
 * every predicate above tolerates a missing or wrong-typed field.
 *
 * The gates run cheap-first, so the expensive one - the injected resolver, which
 * walks the override map and then the community map - is only reached by entries
 * that could still qualify.
 */
export function selectForSonarrDetailed(
  shows: unknown[],
  resolve: (anilistId: number) => SonarrIdentity,
  now: Date,
  opts?: SelectOptions
): SonarrSelection {
  const withinDays = opts?.withinDays ?? DEFAULT_WITHIN_DAYS;
  const items: SonarrListItem[] = [];
  const rejected: SonarrSelection['rejected'] = [];
  // Several AniList ids legitimately map to one TVDB id - seasons and split
  // cours of one series - and `resolveIdentity` does not dedupe. Measured over
  // the current and next seasons on 2026-08-06 there were no collisions, so this
  // is insurance rather than a fix for an observed bug. It is kept because the
  // shape is real and a duplicate row is a thing Sonarr should never be sent.
  const seen = new Set<number>();

  for (const raw of Array.isArray(shows) ? shows : []) {
    const entry = (raw && typeof raw === 'object' ? raw : {}) as SonarrCandidate;
    const drop = (reason: RejectReason) => rejected.push({ entry, reason });

    if (!raw || typeof raw !== 'object') {
      drop('malformed');
      continue;
    }
    if (!isWantedFormat(entry)) {
      drop('format');
      continue;
    }
    // Checked explicitly, and NOT inherited from the fact that the identity
    // sweep skips adult entries: that skips *lookups*. It removes nothing from
    // SeasonCache, and an adult entry can still carry a TVDB id straight from
    // the community map.
    if (entry.isAdult) {
      drop('adult');
      continue;
    }
    if (!isFirstSeason(entry)) {
      drop('notFirstSeason');
      continue;
    }
    if (!isWithinAirWindow(entry, now, withinDays)) {
      drop('outsideAirWindow');
      continue;
    }

    const anilistId = entry.id;
    if (typeof anilistId !== 'number' || !Number.isInteger(anilistId)) {
      drop('noAnilistId');
      continue;
    }

    const tvdbId = usableTvdbId(resolve(anilistId));
    if (tvdbId === null) {
      drop('noUsableTvdbId');
      continue;
    }
    if (seen.has(tvdbId)) {
      drop('duplicateTvdbId');
      continue;
    }

    const title = pickTitle(entry);
    if (!title) {
      drop('noTitle');
      continue;
    }

    seen.add(tvdbId);
    items.push({ title, tvdbId });
  }

  return { items, rejected };
}

/** Just the list. What the route serves; see `selectForSonarrDetailed`. */
export function selectForSonarr(
  shows: unknown[],
  resolve: (anilistId: number) => SonarrIdentity,
  now: Date,
  opts?: SelectOptions
): SonarrListItem[] {
  return selectForSonarrDetailed(shows, resolve, now, opts).items;
}
