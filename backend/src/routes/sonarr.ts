import { Router } from 'express';
import prisma from '../db';
import { requireAuth, requireAdmin, AuthRequest } from '../middleware/auth';
import { resolveIdentity, identityReady, matchGrade } from '../lib/seriesIdentity';
import {
  selectForSonarrDetailed,
  seasonsForSonarr,
  DEFAULT_WITHIN_DAYS,
  type SeasonRef,
  type SonarrCandidate,
  type SonarrPushItem,
  type ForcedInclude,
} from '../lib/sonarrSelect';
import {
  getSonarrConfig,
  clearSonarrConfigCache,
  fetchSnapshot,
  sonarrExclusions,
  sonarrTags,
  sonarrRootFolders,
  sonarrQualityProfiles,
  sonarrLookup,
  addSeries,
  testSonarr,
  sonarrErrorInfo,
  pushConfigProblems,
  parseTagList,
  TAGS_DEFAULT,
  MARKER_TAG_DEFAULT,
  withMarker,
  type SonarrConfig,
  type SonarrSnapshot,
} from '../lib/sonarrApi';
import {
  planPushRun,
  newlyHeldToRecord,
  classifyAddError,
  findOrphans,
  sonarrValidationMessages,
  type PushRow,
  type PushStatus,
  type PushCandidate,
  type SkipReason,
  type Orphan,
} from '../lib/sonarrPush';
import { isValidSeason, isValidYear, type Season } from '../lib/validateSeason';

/**
 * Sonarr auto-add: which new seasonal series should be grabbed, added once each.
 *
 *   POST /api/sonarr/push          -> add the pending candidates, at most `cap`
 *   GET  /api/sonarr/push/preview  -> the same plan, nothing written
 *
 * **Every route in this file requires `requireAuth` + `requireAdmin`.** There is
 * no public route here at all - the one that existed, `GET /list`, was the
 * Custom List Sonarr polled, and it went away with the list. If you add a route,
 * it is admin-only unless you can argue otherwise in writing.
 *
 * **We push; Sonarr does not pull.** The earlier design served a Custom List and
 * let Sonarr's Import List Sync (~5 min, hardcoded - Sonarr#5927) reconcile
 * against it. That is a *declarative set*, so anything deleted from Sonarr came
 * straight back on the next poll, for as long as its season stayed in scope. The
 * full argument, including why retiring entries from the list would have been
 * worse rather than better, is in `lib/sonarrPush.ts`.
 *
 * **One add per series, ever.** A terminal `SonarrPush` row means we never look
 * at that tvdbId again, so a deletion - by Maintainerr, by a human, for any
 * reason - is permanent without us having to observe it. The only second attempt
 * is a *different* tvdbId arriving from a corrected identity.
 *
 * The rationale, kept here because this is the one place it is all true at once:
 *
 * **Why whole first seasons and not just the pilot.** Downloading only episode 1
 * leaves the season `PARTIALLY_AVAILABLE` in Seerr, and Seerr *refuses* a request
 * for such a season - verified in `server/entity/MediaRequest.ts` at tag v3.4.1,
 * where seasons are excluded unless their status is `UNKNOWN` or `DELETED` and it
 * then throws `NoSeasonsAvailableError`. It is blocked in Seerr's UI too and
 * closed upstream as working-as-intended. So a pilot-only list would remove the
 * only route users have to ask for the rest. Monitoring the whole season still
 * delivers E01 on air day, because Sonarr grabs each episode as it airs.
 *
 * **Why `pending` identities are excluded.** Everywhere else in this app an
 * unverified resolver id is treated as positive-only, because a bad guess costs a
 * Watch button that doesn't work. Here a bad guess downloads a whole season of
 * the wrong series, so the filter is `tvdbId && !pending && !rejected`. It is
 * deliberately NOT `confirmed`: a community-map row is unconfirmed by
 * construction, and requiring confirmation would discard the ~94% of TV the map
 * answers.
 *
 * **Why relations decide scope but never identity.** `lib/sonarrSelect.ts` drops
 * an entry with a `PREQUEL` or `PARENT` edge. `lib/remoteIdentity.ts` records that
 * an `isRelation` guard was tried for *matching* and was wrong, because mapping a
 * sequel onto its parent is correct there. Both are right: that one asks "is this
 * the same series", this one asks "do we choose to auto-add it". A false skip
 * here costs nothing - anyone can still request the show in Seerr.
 *
 * **Why we do not delete, and never will from here.** Cleanup is Maintainerr's,
 * decided from Tautulli watch data we do not have. Two systems that can both
 * delete, neither knowing why the other did, is a bad place to end up. Our
 * contribution is simply never re-adding what it removed, which the terminal row
 * gives us for free. Maintainerr writing a Sonarr Import List Exclusion is now
 * belt-and-braces rather than mandatory - it was mandatory only because the list
 * would otherwise have re-added things.
 *
 * **This route must never trigger a cold AniList fetch.** It reads `SeasonCache`
 * and nothing else, and it serves a stale row happily. AniList's ~30/min budget
 * is shared with every viewer and the whole house's IP. Less pressing than when
 * Sonarr polled this every few minutes, but the rule is unchanged: the identity
 * sweep follows it too, and a scheduled job that can miss-and-fetch is exactly
 * how that budget gets burned unattended.
 */

const router = Router();

/** Where the last snapshot's outcome is persisted, for the admin status line. */
const SNAPSHOT_KEY = 'sonarrSnapshotStatus';

/** Master switch: may we actually add series to Sonarr? */
const PUSH_KEY = 'sonarrPushEnabled';

/**
 * How many series one run may add. A blast radius, not a rate limit.
 *
 * Nothing searches on add, so a large run costs indexers nothing; what the cap
 * bounds is a misconfiguration. The overflow is *deferred and reported*, never
 * dropped - `planPushRun` returns it and both the preview and the run response
 * carry the count.
 */
const DEFAULT_CAP = 10;

/**
 * **Off unless explicitly turned on**, and the default is the point.
 *
 * Everything else here is reviewable before it acts; this is the one thing that
 * writes to Sonarr, so it fails closed. A fresh deployment, a restored backup
 * and a wiped `AppConfig` all add nothing.
 *
 * Deliberately a NEW key rather than a rename of the Custom List era's
 * `sonarrListEnabled`: reusing it would have inherited an existing `true` and
 * turned a list that merely *offered* series into a job that *adds* them, on the
 * first restart after deploy, with nobody having chosen that.
 *
 * `/push/preview` and `/report` ignore this and keep showing the full plan,
 * because reviewing what *would* happen while nothing happens is what the pause
 * is for.
 */
async function pushEnabled(): Promise<boolean> {
  const row = await prisma.appConfig.findUnique({ where: { key: PUSH_KEY } });
  return row?.value === 'true';
}

/**
 * The last snapshot's outcome, and the Sonarr-side facts it observed.
 *
 * The ids are cached here on purpose. `/api/v3/series` returns this
 * deployment's whole library - **2,324 series, measured at 14.7 s** - and the
 * report used to call it on every page load, which meant opening the admin page
 * pulled the entire Sonarr library and then lost a race against its own 15 s
 * client timeout. The page now reads what the hourly snapshot already fetched
 * and says how old it is, with *Run snapshot now* to refresh. Same instinct as
 * every other upstream answer in this app: cache it, show its age, never make
 * someone wait on it.
 */
interface SnapshotStatus {
  at: string;
  ok: boolean;
  seriesCount: number;
  error?: string;
  /** Why a run deliberately changed nothing, when it did. */
  skipped?: string;
  /** tvdbIds Sonarr held at snapshot time. */
  heldIds?: number[];
  /** tvdbIds on Sonarr's Import List Exclusions. */
  excludedIds?: number[];
  /** Held tvdbIds carrying our tag - i.e. ones we added. */
  taggedIds?: number[];
  orphans?: Orphan[];
}

/**
 * The freshness of the cached season is irrelevant here, so unlike
 * `routes/anime.ts` there is no TTL comparison at all - which also means there
 * is no second copy of `SEASON_TTL_SECONDS` (module-private over there) to drift
 * out of step. A season we have never fetched simply contributes nothing.
 *
 * The `''` format key is the no-format-filter row, mirroring the convention in
 * `routes/anime.ts`: SQLite forbids NULL in a composite primary key, so the
 * unfiltered season is stored under an empty string. Reading the `'TV'` row
 * instead would silently drop every TV_SHORT.
 */
async function readCachedSeason(ref: SeasonRef): Promise<unknown[]> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT data
       FROM   "SeasonCache"
       WHERE  season = ?
       AND    year   = ?
       AND    format = ?
       LIMIT  1`,
    ref.season,
    ref.year,
    ''
  )) as { data: string }[];

  if (!rows.length) return [];
  try {
    const parsed = JSON.parse(rows[0].data);
    // A cached-but-empty season is a real row (SUMMER 2027 was one), and it
    // means "we asked and there is nothing yet" - not "not cached".
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // A corrupt row degrades to "this season contributes nothing", never a 500
    // on a list Sonarr treats as authoritative.
    console.warn(`[sonarr] unparseable SeasonCache row for ${ref.season} ${ref.year}`);
    return [];
  }
}

/** anilistId -> tvdbId for the force-include overlay. Tiny; read per request. */
async function loadIncludes(): Promise<Map<number, ForcedInclude>> {
  const rows = await prisma.sonarrInclude.findMany();
  return new Map(
    rows.map((r) => [
      r.anilistId,
      { tvdbId: r.tvdbId, acknowledgedUnverified: !!r.acknowledgedUnverified },
    ])
  );
}

async function loadPushRows(): Promise<PushRow[]> {
  const rows = await prisma.sonarrPush.findMany();
  return rows.map((r) => ({
    tvdbId: r.tvdbId,
    anilistId: r.anilistId ?? null,
    title: r.title ?? '',
    status: r.status as PushStatus,
    sonarrSeriesId: r.sonarrSeriesId ?? null,
    pushedAt: r.pushedAt ?? null,
    attempts: r.attempts ?? 0,
    lastAttemptAt: r.lastAttemptAt ?? null,
    lastError: r.lastError ?? null,
  }));
}

async function recordPush(row: PushRow): Promise<void> {
  const data = {
    anilistId: row.anilistId,
    title: row.title,
    status: row.status,
    sonarrSeriesId: row.sonarrSeriesId,
    pushedAt: row.pushedAt,
    attempts: row.attempts,
    lastAttemptAt: row.lastAttemptAt,
    lastError: row.lastError,
  };
  await prisma.sonarrPush.upsert({
    where: { tvdbId: row.tvdbId },
    update: data,
    create: { tvdbId: row.tvdbId, ...data },
  });
}

/**
 * Our configured tag labels, resolved to Sonarr's numeric ids.
 *
 * Sonarr's add endpoint takes tag *ids*; creating a missing tag would be a
 * second write verb, so labels have to exist there already. A label that does
 * not resolve is reported as `missing` and **blocks the push** rather than being
 * quietly dropped: an untagged series is invisible to Maintainerr's scoping, so
 * the failure would be silent and only discovered by a cleanup that never ran.
 */
function resolveTagIds(
  labels: string[],
  tags: { id: number; label: string }[] | null
): { ids: number[]; missing: string[] } {
  if (!tags) return { ids: [], missing: [] };   // could not ask; not "all missing"
  const byLabel = new Map(tags.map((t) => [t.label.toLowerCase(), t.id]));
  const ids: number[] = [];
  const missing: string[] = [];
  for (const label of labels) {
    const id = byLabel.get(label.toLowerCase());
    if (id === undefined) missing.push(label);
    else ids.push(id);
  }
  return { ids, missing };
}

interface Assembled {
  refs: SeasonRef[];
  perSeason: Array<{ season: string; year: number; cached: number }>;
  entries: unknown[];
  items: SonarrPushItem[];
  rejected: ReturnType<typeof selectForSonarrDetailed>['rejected'];
  /** tvdbId -> anilistId for every candidate, so a push records what it was for. */
  proposedBy: Map<number, number>;
  pushes: PushRow[];
}

/**
 * Everything `/push`, `/push/preview` and `/report` need, computed once.
 *
 * Sharing this is the point: two assemblies of "what would we add" would
 * eventually disagree, and the one the page showed would not be the one that
 * ran.
 */
async function assemble(refs: SeasonRef[], now: Date): Promise<Assembled> {
  const entries: unknown[] = [];
  const perSeason: Assembled['perSeason'] = [];
  for (const ref of refs) {
    const rows = await readCachedSeason(ref);
    perSeason.push({ season: ref.season, year: ref.year, cached: rows.length });
    entries.push(...rows);
  }

  const [forceInclude, pushes] = await Promise.all([loadIncludes(), loadPushRows()]);
  const { items, rejected } = selectForSonarrDetailed(entries, resolveIdentity, now, {
    forceInclude,
  });

  // Which AniList entry produced each candidate tvdbId. Stored with the push so
  // an identity corrected later is visible as an orphan rather than as a second
  // series nobody can explain.
  const proposedBy = new Map<number, number>();
  const titleToId = new Map<string, number>();
  for (const raw of entries) {
    const e = raw as SonarrCandidate;
    const t = e?.title?.english || e?.title?.romaji || e?.title?.native;
    if (t && typeof e?.id === 'number') titleToId.set(t.trim(), e.id);
  }
  for (const it of items) {
    const aid = titleToId.get(it.title);
    if (aid !== undefined) proposedBy.set(it.tvdbId, aid);
  }

  return { refs, perSeason, entries, items, rejected, proposedBy, pushes };
}

/** anilistId -> the tvdbId it resolves to *now*, for orphan detection. */
function currentIdentityMap(entries: unknown[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const raw of entries) {
    const e = raw as SonarrCandidate;
    if (typeof e?.id !== 'number') continue;
    const id = resolveIdentity(e.id);
    const n = Number(id.tvdbId);
    if (Number.isInteger(n) && n > 0) out.set(e.id, n);
  }
  return out;
}

/** Oldest / newest of a nullable date list, as ISO, or null when there are none. */
function earliest(dates: (Date | null)[]): string | null {
  const t = dates.filter((d): d is Date => !!d).map((d) => d.getTime());
  return t.length ? new Date(Math.min(...t)).toISOString() : null;
}

function latest(dates: (Date | null)[]): string | null {
  const t = dates.filter((d): d is Date => !!d).map((d) => d.getTime());
  return t.length ? new Date(Math.max(...t)).toISOString() : null;
}

async function readSnapshotStatus(): Promise<SnapshotStatus | null> {
  const row = await prisma.appConfig.findUnique({ where: { key: SNAPSHOT_KEY } });
  if (!row?.value) return null;
  try {
    return JSON.parse(row.value) as SnapshotStatus;
  } catch {
    return null;   // a corrupt row reads as "never ran", never as a throw
  }
}

/**
 * Read Sonarr once and cache what it holds.
 *
 * Exported because two callers need it: the hourly timer in `index.ts` and the
 * admin's *Run snapshot now* button - the same shape as the identity sweep's
 * `triggerSweep`.
 *
 * **This no longer decides anything.** Under the Custom List it drove the
 * suppression that was supposed to stop deleted series being re-added; that
 * mechanism is gone, because a terminal `SonarrPush` row does the job without
 * needing to catch a deletion at all. What is left is a cache and a display: the
 * held set that keeps `/push` from re-adding what Sonarr already has, the
 * exclusions, and the tag counts.
 *
 * **An empty or failed read is still never treated as "everything was deleted".**
 * It records nothing rather than overwriting a good held set with an empty one -
 * which would make `/report` show the whole library as "will be added" and let
 * one bad read turn into a burst of duplicate adds.
 */
export async function runSonarrSnapshot(): Promise<SnapshotStatus> {
  const now = new Date();
  const cfg = await getSonarrConfig();
  if (!cfg) {
    return { at: now.toISOString(), ok: false, seriesCount: 0, error: 'Sonarr is not configured' };
  }

  const snapshot: SonarrSnapshot = await fetchSnapshot(cfg);
  const [assembled, tags] = await Promise.all([
    assemble(seasonsForSonarr(now), now),
    snapshot.ok ? sonarrTags(cfg) : Promise.resolve(null),
  ]);
  // **The marker tag only**, never the whole applied set. `anime` is applied too
  // and sits on 692 series here, so counting any of our tags reported shows the
  // owner had for years as ours - measured on the live instance 2026-08-10.
  const markerId = resolveTagIds([cfg.markerTag], tags).ids[0] ?? null;

  // A read that returned nothing is "could not ask", not "the library is empty".
  // The precedent is real: an analysis script written during this feature's
  // design read the wrong key, got an empty set, and confidently reported all 39
  // candidates as new. Same bug, and here it would cause 39 duplicate adds.
  const skipped =
    snapshot.ok && snapshot.series.length === 0
      ? 'snapshot returned an empty library - treated as "could not ask", never as mass deletion'
      : undefined;
  const trusted = snapshot.ok && !skipped;

  const heldIds = new Set(snapshot.series.map((s) => s.tvdbId));
  const orphans = trusted
    ? findOrphans(assembled.pushes, currentIdentityMap(assembled.entries), heldIds)
    : [];

  // Exclusions are read here rather than in `/report` for the same reason the
  // ids are cached: the report must not make a page load wait on Sonarr.
  const exclusions = trusted ? await sonarrExclusions(cfg) : null;

  const status: SnapshotStatus = {
    at: now.toISOString(),
    ok: trusted,
    seriesCount: snapshot.series.length,
    ...(snapshot.error ? { error: snapshot.error } : {}),
    ...(skipped ? { skipped } : {}),
    ...(trusted
      ? {
          heldIds: [...heldIds],
          taggedIds:
            markerId === null
              ? []
              : snapshot.series.filter((s) => s.tags.includes(markerId)).map((s) => s.tvdbId),
          ...(exclusions ? { excludedIds: exclusions.map((e) => e.tvdbId) } : {}),
          orphans,
        }
      : {}),
  };
  await prisma.appConfig.upsert({
    where: { key: SNAPSHOT_KEY },
    update: { value: JSON.stringify(status) },
    create: { key: SNAPSHOT_KEY, value: JSON.stringify(status) },
  });
  return status;
}

/** Both or neither, and both valid. Shared by `/push`, `/push/preview` and `/report`. */
function seasonOverride(
  season: string | undefined,
  year: string | undefined
): { error: string } | { refs: SeasonRef[] | null } {
  if ((season && !year) || (!season && year)) {
    return { error: 'Provide both "season" and "year", or neither' };
  }
  if (season && year) {
    if (!isValidSeason(season) || !isValidYear(year)) return { error: 'Invalid season or year' };
    return { refs: [{ season: season.toUpperCase() as Season, year: Number(year) }] };
  }
  return { refs: null };
}

/**
 * Fields the admin page reads that `sonarrSelect.ts` does not filter on, so they
 * are not in `SonarrCandidate`: the episode count sizes the download estimate,
 * the cover and season label the rows, and the relation nodes answer "do I
 * already own the previous season of this".
 */
type CacheEntry = SonarrCandidate & {
  episodes?: number | null;
  season?: string | null;
  seasonYear?: number | null;
  coverImage?: { medium?: string | null; large?: string | null } | null;
};

function describe(e: CacheEntry) {
  // `tvdbId` and `episodes` are here so a rejected row carries the SAME shape as
  // a proposed one - the two tables share a fixed column layout, and a column
  // that exists in one and not the other is what made them fail to line up.
  // Null is normal on a `noUsableTvdbId` row, and renders blank.
  const identity = typeof e.id === 'number' ? resolveIdentity(e.id) : null;
  const tvdb = identity ? Number(identity.tvdbId) : NaN;
  return {
    anilistId: e.id ?? null,
    // How well we know this is the right series. Same ladder the Watch pop-up's
    // correction picker uses - one definition, in lib/seriesIdentity.ts.
    grade: identity ? matchGrade(identity) : 'none',
    unverified: !!identity && (identity.pending || identity.rejected),
    matchedTitle: identity?.matchedTitle ?? null,
    gradeNote: identity?.note ?? null,
    tvdbId: Number.isInteger(tvdb) && tvdb > 0 ? tvdb : null,
    episodes: e.episodes ?? null,
    title: e.title?.english || e.title?.romaji || e.title?.native || null,
    format: e.format ?? null,
    status: e.status ?? null,
    startDate: e.startDate ?? null,
    // Season and year so the page can group; without them it showed two
    // seasons mixed together and could not answer "what is this proposing?".
    season: e.season ?? null,
    year: e.seasonYear ?? null,
    // Already in SeasonCache - a poster costs no extra fetch, and telling
    // franchise entries apart by title alone is guesswork.
    cover: e.coverImage?.medium ?? null,
  };
}

/**
 * For an entry dropped as a sequel: is the thing it follows already held?
 *
 * That single fact separates "season 2 of a show I own" from "season 2 of a
 * franchise I don't follow" - measured 2026-08-09 across the current and next
 * seasons, it splits 50 dropped sequels into 25 and 24. Purely informational:
 * the first-seasons-only rule does not change, and nothing here auto-includes.
 */
function describeParent(e: CacheEntry, held: Set<number>) {
  const edges = e.relations?.edges;
  if (!Array.isArray(edges)) return null;
  for (const edge of edges) {
    const t = edge?.relationType;
    if (t !== 'PREQUEL' && t !== 'PARENT') continue;
    const node = (edge as { node?: { id?: number; title?: { romaji?: string } } }).node;
    if (typeof node?.id !== 'number') continue;
    const tvdbId = Number(resolveIdentity(node.id).tvdbId);
    if (!Number.isInteger(tvdbId) || tvdbId <= 0) continue;
    return { title: node.title?.romaji ?? null, tvdbId, held: held.has(tvdbId) };
  }
  return null;
}

function describeProposed(item: SonarrPushItem, entries: unknown[]) {
  const e = entries.find((raw) => {
    const c = raw as CacheEntry;
    const t = c?.title?.english || c?.title?.romaji || c?.title?.native;
    return t?.trim() === item.title;
  }) as CacheEntry | undefined;
  return {
    ...item,
    ...(e ? describe(e) : {}),
    // **After the spread, both of them.** `describe()` re-resolves identity and
    // returns null when it has no id - which is exactly the case for a
    // force-included entry, whose whole point is carrying an id the resolver
    // does not have. Letting that overwrite the real one blanked the id in the
    // table and would now hand `null` to the push.
    tvdbId: item.tvdbId,
    title: item.title,
    episodes: e?.episodes ?? null,
  };
}

// ---------------------------------------------------------------------------
// ADMIN - every route below requires the admin account. There are no others.
// ---------------------------------------------------------------------------

interface PushPlan {
  enabled: boolean;
  cap: number;
  /** Reasons a push cannot run at all. Empty means it can. */
  problems: string[];
  toPush: Array<ReturnType<typeof describeProposed>>;
  deferred: Array<ReturnType<typeof describeProposed>>;
  skipped: Array<ReturnType<typeof describeProposed> & { reason: string }>;
  /**
   * The same `toPush`, unadorned. The loop iterates this rather than the
   * described rows so that what gets added is the plan's own decision, not
   * whatever survived being reshaped for display.
   */
  raw: PushCandidate[];
  /** The skips, unadorned, so `alreadyHeld` can be recorded as terminal. */
  skippedRaw: Array<{ candidate: PushCandidate; reason: SkipReason }>;
  /** tvdbIds that already have a stored row, so recording never rewrites one. */
  priorIds: number[];
}

/**
 * What a push would do, computed without touching Sonarr.
 *
 * Shared by `/push/preview` and `/push` so the dry run and the run cannot
 * disagree - the same mistake as having two assemblies of the candidate set,
 * one shown and one executed.
 */
async function buildPushPlan(refs: SeasonRef[], now: Date, cap: number): Promise<PushPlan> {
  const cfg = await getSonarrConfig();
  const [a, status, enabled] = await Promise.all([
    assemble(refs, now),
    readSnapshotStatus(),
    pushEnabled(),
  ]);

  const observed = !!status?.ok && Array.isArray(status?.heldIds);
  const held = new Set(status?.heldIds ?? []);
  const excluded = new Set(status?.excludedIds ?? []);
  const priors = new Map(a.pushes.map((p) => [p.tvdbId, p]));

  const candidates = a.items.map((i) => ({
    tvdbId: i.tvdbId,
    anilistId: a.proposedBy.get(i.tvdbId) ?? null,
    title: i.title,
  }));
  const plan = planPushRun(candidates, priors, held, excluded, cap);

  const problems = pushConfigProblems(cfg);
  // **Refuse to add when we cannot tell what Sonarr already holds.** Without the
  // held set every series in the library looks like a new candidate. Sonarr
  // would answer 400 "already added" and we would record that correctly, so this
  // is a noise-and-writes guard rather than a correctness one - but "unknown is
  // not the same as absent" is the rule everywhere else in this codebase, and a
  // snapshot is one button away.
  //
  // Caveat worth knowing: a genuinely empty Sonarr reads as "could not ask" (see
  // `runSonarrSnapshot`), so a brand new install would need that guard revisited
  // before the first push could run.
  if (!observed) problems.push('no trusted Sonarr snapshot yet - run a snapshot first');
  if (!identityReady()) problems.push('identity data is still loading');

  const describeOne = (c: PushCandidate) => describeProposed({ tvdbId: c.tvdbId, title: c.title }, a.entries);
  return {
    enabled,
    cap,
    problems,
    toPush: plan.toPush.map(describeOne),
    deferred: plan.deferred.map(describeOne),
    skipped: plan.skipped.map((s) => ({ ...describeOne(s.candidate), reason: s.reason })),
    raw: plan.toPush,
    skippedRaw: plan.skipped,
    priorIds: [...priors.keys()],
  };
}

function capFrom(raw: unknown): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n <= 200 ? n : DEFAULT_CAP;
}

/**
 * The dry run. **Writes nothing, to us or to Sonarr.**
 *
 * Deliberately does not perform the TVDB lookup either, even though that is a
 * read: the lookup is one round trip per candidate and this is a page load. A
 * bad id therefore shows up as a `lookupFailed` row after a real push rather
 * than here - which is why that status is retryable and visible on the page.
 */
router.get('/push/preview', requireAuth, requireAdmin, async (req, res) => {
  const { season, year } = req.query as { season?: string; year?: string };
  const override = seasonOverride(season, year);
  if ('error' in override) {
    return res.status(400).json({ error: override.error, code: 'BAD_REQUEST' });
  }
  try {
    const now = new Date();
    const plan = await buildPushPlan(override.refs ?? seasonsForSonarr(now), now, capFrom(req.query.cap));
    // The three internal fields are the run loop's input, not the page's.
    const { raw, skippedRaw, priorIds, ...shown } = plan;
    void raw; void skippedRaw; void priorIds;
    return res.json(shown);
  } catch (err) {
    console.error('[sonarr] push preview failed', err);
    return res.status(500).json({ error: 'Internal server error', code: 'SERVER_ERROR' });
  }
});

/**
 * Add the pending candidates to Sonarr. **The only thing here that writes.**
 *
 * Gated three ways, and the order matters: the master switch, then the config
 * completeness check, then the tag resolution. Each refuses before a single
 * `POST /api/v3/series` goes out, so a misconfiguration cannot half-run.
 *
 * One series per iteration, sequentially. Nothing here needs to be fast - it is
 * a scheduled job and an admin button - and a loop that fails on row 4 has
 * already committed rows 1 to 3, which the per-row record makes recoverable.
 */
export interface PushRunResult {
  ran: boolean;
  reason?: string;
  pushed: number;
  failed: number;
  deferred: number;
  results: Array<{ tvdbId: number; title: string; status: PushStatus; detail?: string }>;
  plan: Omit<PushPlan, 'raw' | 'skippedRaw' | 'priorIds'>;
}

/**
 * Do the adds. Exported because two callers need it: the daily timer in
 * `index.ts` and the admin's *Push now* button - the same shape as
 * `runSonarrSnapshot`.
 *
 * **Reads the master switch itself.** The caller must not pre-check it, because
 * then there would be two places that decide whether this writes and only one of
 * them would be tested.
 */
export async function runScheduledPush(cap: number = DEFAULT_CAP): Promise<PushRunResult> {
  const now = new Date();
  const cfg = await getSonarrConfig();
  const plan = await buildPushPlan(seasonsForSonarr(now), now, cap);
  const { raw, skippedRaw, priorIds, ...shown } = plan;
  const refuse = (reason: string): PushRunResult => ({
    ran: false,
    reason,
    pushed: 0,
    failed: 0,
    deferred: plan.deferred.length,
    results: [],
    plan: shown,
  });

  // Paused is a normal answer, not an error: the page shows it as a state.
  if (!plan.enabled) return refuse('paused');
  if (plan.problems.length) return refuse(plan.problems.join('; '));

  const tags = await sonarrTags(cfg!);
  if (!tags) return refuse('could not read tags from Sonarr');
  const { ids: tagIds, missing } = resolveTagIds(cfg!.tags, tags);
  // Refusing outright rather than adding untagged: an untagged series is
  // invisible to Maintainerr's scoping, so the mistake would surface months
  // later as a cleanup that quietly did nothing.
  if (missing.length) return refuse(`create these tags in Sonarr first: ${missing.join(', ')}`);

  const results: PushRunResult['results'] = [];
  let pushed = 0;
  let failed = 0;

  // **Record the ones Sonarr already holds, before adding anything.**
  //
  // Without this they are re-decided from the live library on every run, so
  // deleting a series you owned before this feature existed would turn it into
  // a fresh candidate and we would add it back - the exact loop the terminal row
  // exists to prevent, surviving in the one place it was easy to overlook.
  // Caught by running a real push twice against the live instance, not by any
  // test: with 36 held series and 3 candidates, nothing on screen looked wrong.
  //
  // Deliberately after the gates above, so a paused or misconfigured run still
  // writes absolutely nothing.
  for (const c of newlyHeldToRecord(plan.skippedRaw, new Set(plan.priorIds))) {
    await recordPush({
      tvdbId: c.tvdbId,
      anilistId: c.anilistId,
      title: c.title,
      status: 'alreadyHeld',
      sonarrSeriesId: null,
      pushedAt: null,
      attempts: 0,
      lastAttemptAt: now,
      lastError: null,
    });
  }

  for (const { tvdbId, title, anilistId } of plan.raw) {
      const base = {
        tvdbId,
        anilistId,
        title,
        sonarrSeriesId: null as number | null,
        pushedAt: null as Date | null,
        attempts: 1,
        lastAttemptAt: now,
        lastError: null as string | null,
      };

      let lookup: unknown | null = null;
      try {
        lookup = await sonarrLookup(cfg!, tvdbId);
      } catch (err) {
        // A transport failure is not "Sonarr does not know this id" - recording
        // it as `lookupFailed` would be a lie about the id. Both are retryable,
        // but only one of them means someone should look at the match.
        await recordPush({ ...base, status: 'failed', lastError: `lookup: ${sonarrErrorInfo(err)}` });
        results.push({ tvdbId, title, status: 'failed', detail: 'lookup failed' });
        failed++;
        continue;
      }

      if (!lookup) {
        await recordPush({
          ...base,
          status: 'lookupFailed',
          lastError: 'Sonarr does not know this TVDB id',
        });
        results.push({ tvdbId, title, status: 'lookupFailed', detail: 'Sonarr does not know this TVDB id' });
        failed++;
        continue;
      }

      const add = await addSeries(cfg!, lookup, tagIds);
      if (add.ok) {
        await recordPush({ ...base, status: 'pushed', sonarrSeriesId: add.seriesId ?? null, pushedAt: now });
        results.push({ tvdbId, title, status: 'pushed' });
        pushed++;
        continue;
      }

      const kind = classifyAddError(add);
      const detail = sonarrValidationMessages(add.body)[0] ?? add.error ?? 'unknown error';
      if (kind === 'alreadyExists') {
        // Terminal, NOT a failure. Our held set comes from a cached snapshot, so
        // a series added between snapshots lands here; recording it as failed
        // would leave it retryable and it would be retried on every run forever.
        await recordPush({ ...base, status: 'alreadyHeld', lastError: detail });
        results.push({ tvdbId, title, status: 'alreadyHeld', detail });
        continue;
      }
      await recordPush({ ...base, status: 'failed', lastError: detail });
      results.push({ tvdbId, title, status: 'failed', detail });
      failed++;
    }

  if (pushed || failed) {
    console.log(
      `[sonarr] push: ${pushed} added, ${failed} failed, ${plan.deferred.length} deferred by the cap of ${cap}`
    );
  }
  return {
    ran: true,
    pushed,
    failed,
    // Never silently truncated: whatever the cap held back is reported here so
    // "nothing left" and "10 left, come back tomorrow" cannot look the same.
    deferred: plan.deferred.length,
    results,
    plan: shown,
  };
}

router.post('/push', requireAuth, requireAdmin, async (req, res) => {
  try {
    return res.json(await runScheduledPush(capFrom(req.body?.cap)));
  } catch (err) {
    console.error('[sonarr] push failed', err);
    return res.status(500).json({ error: 'Internal server error', code: 'SERVER_ERROR' });
  }
});

/**
 * Everything the admin page needs, in one payload.
 *
 * **Degradation is load-bearing.** When Sonarr is unreachable this still
 * returns the whole proposal side - which needs no Sonarr at all - with
 * `sonarr.reachable: false`. The page must not go blank because Sonarr is down,
 * the same discipline as the Jellyfin availability path where `unknown` means
 * "couldn't ask" and never "not in the library".
 */
router.get('/report', requireAuth, requireAdmin, async (req, res) => {
  const { season, year } = req.query as { season?: string; year?: string };
  const override = seasonOverride(season, year);
  if ('error' in override) {
    return res.status(400).json({ error: override.error, code: 'BAD_REQUEST' });
  }

  try {
    const now = new Date();
    const cfg = await getSonarrConfig();
    const a = await assemble(override.refs ?? seasonsForSonarr(now), now);
    const status = await readSnapshotStatus();
    const published = await pushEnabled();

    // Read what the last snapshot observed - this path makes NO Sonarr calls.
    // It used to fetch `/api/v3/series` on every page load, which on this
    // deployment is 2,324 series and 14.7 s, so opening the page pulled the
    // whole library and then lost a race against its own 15 s client timeout.
    // See `SnapshotStatus`.
    const heldIds = new Set(status?.heldIds ?? []);
    const excludedIds = new Set(status?.excludedIds ?? []);
    const taggedIds = new Set(status?.taggedIds ?? []);
    const orphans = status?.orphans ?? [];
    // "We have a trustworthy observation", NOT "Sonarr is up right now". The
    // page renders the snapshot's age beside these so stale ids are never
    // mistaken for live truth.
    const observed = !!status?.ok && Array.isArray(status?.heldIds);

    const counts: Record<string, number> = {};
    for (const r of a.rejected) counts[r.reason] = (counts[r.reason] ?? 0) + 1;

    // Our own record beats the library, and it has to: a series we pushed and
    // that has since been deleted is `pushedAlready`, not `willBeAdded`. Reading
    // the library alone would show it as pending forever, which is precisely the
    // confusion the terminal row exists to remove.
    //
    // **"We added this" has two sources, and it needs both.**
    //
    // `SonarrPush` is the precise one - a row exists only because Sonarr
    // answered 201. But it lives in one database, and a database does not follow
    // you from dev to production or survive a restore from an old backup. The
    // marker tag lives in Sonarr beside the series, so it answers the same
    // question when the row is gone.
    //
    // It must be the MARKER tag alone. Asking "does it carry any of our tags"
    // was wrong for a measured reason: we also apply `anime`, and `anime` is on
    // **692 series** here, so two shows the owner had for years rendered as
    // added by us - the page claiming credit for someone else's library.
    const pushedBy = new Map(a.pushes.map((p) => [p.tvdbId, p]));
    const state = (tvdbId: number) => {
      const prior = pushedBy.get(tvdbId);
      if (prior?.status === 'pushed') return 'pushedAlready';
      if (prior?.status === 'lookupFailed') return 'lookupFailed';
      if (prior?.status === 'failed') return 'failed';
      if (!observed) return 'unknown';
      // Marker-tagged wins over "already held": both are held, but one of them
      // we (or a deliberate hand-tag) put there.
      if (taggedIds.has(tvdbId)) return 'addedByUs';
      if (heldIds.has(tvdbId) || prior?.status === 'alreadyHeld') return 'heldAlready';
      if (excludedIds.has(tvdbId)) return 'excludedInSonarr';
      return 'willBeAdded';
    };

    return res.json({
      // `published` is the first thing the page reads: every other number here
      // describes what WOULD happen, and this says whether it will.
      published,
      config: {
        configured: !!cfg,
        url: cfg?.url ?? '',
        tags: cfg?.tags ?? TAGS_DEFAULT,
        markerTag: cfg?.markerTag ?? MARKER_TAG_DEFAULT,
        // "Of the series we have a RECORD of adding, how many carry the marker?"
        // Anything less than all of them means the tag is not being applied, and
        // Maintainerr's scoping will silently cover less than you think - the
        // one failure that only shows up months later as a cleanup that did
        // nothing. Deliberately not "how many tagged series exist": that is 692
        // for `anime` and says nothing about us.
        taggedOfOurs: a.pushes.filter((p) => p.status === 'pushed' && taggedIds.has(p.tvdbId)).length,
        rootFolderPath: cfg?.rootFolderPath ?? '',
        qualityProfileId: cfg?.qualityProfileId ?? 0,
        seriesType: cfg?.seriesType ?? 'standard',
        // What stops a push before it starts. Shown as setup steps rather than
        // discovered by pressing the button and reading an error.
        problems: pushConfigProblems(cfg),
      },
      snapshot: status,
      sonarr: { observed, held: heldIds.size, excluded: excludedIds.size, at: status?.at ?? null },
      seasons: a.perSeason,
      withinDays: DEFAULT_WITHIN_DAYS,
      proposed: a.items.map((i) => ({ ...describeProposed(i, a.entries), state: state(i.tvdbId) })),
      rejected: a.rejected.map((r) => ({
        ...describe(r.entry),
        reason: r.reason,
        // Only the sequel rejections carry this; everything else gets null and
        // the page renders nothing rather than an empty label.
        parent: r.reason === 'notFirstSeason' ? describeParent(r.entry, heldIds) : null,
      })),
      // What has actually happened, from the rows already loaded above.
      //
      // **`pushedAt` means we added it, and nothing else does.** The Custom List
      // era reported `firstHeldAt`, which was "when a snapshot first saw it" -
      // on this deployment all 36 rows shared one instant, the moment the first
      // snapshot ran, for series that had been in the library for months.
      // Presenting that as "added" was a confident, plausible lie about
      // someone's own library, and a `pushed` row cannot make it: it exists only
      // because `POST /api/v3/series` returned 201 to us.
      history: {
        // Series Sonarr says are ours, whoever recorded it. The union is the
        // honest headline precisely because neither source is complete: the
        // record misses anything added before this database existed, and the tag
        // misses anything since deleted (a series that is gone carries no tag).
        ours: new Set([
          ...a.pushes.filter((p) => p.status === 'pushed').map((p) => p.tvdbId),
          ...taggedIds,
        ]).size,
        /** Marker-tagged and still held. Survives losing the database. */
        tagged: taggedIds.size,
        pushed: a.pushes.filter((p) => p.status === 'pushed').length,
        // Distinct from `pushed`: these were in Sonarr before we got there. The
        // two are separated on purpose so "we added 36 series" can never be
        // rendered from a library we did not build.
        alreadyHeld: a.pushes.filter((p) => p.status === 'alreadyHeld').length,
        needsAttention: a.pushes.filter((p) => p.status === 'lookupFailed' || p.status === 'failed').length,
        firstPushAt: earliest(a.pushes.map((p) => p.pushedAt)),
        lastPushAt: latest(a.pushes.map((p) => p.pushedAt)),
      },
      // Everything we tried, newest attempt first. `lookupFailed` and `failed`
      // are the actionable ones - both mean nothing was added and both will be
      // retried, so a row that persists here is a matching problem to fix.
      pushes: a.pushes
        .slice()
        .sort((x, y) => (y.lastAttemptAt?.getTime() ?? 0) - (x.lastAttemptAt?.getTime() ?? 0))
        .map((p) => ({
          tvdbId: p.tvdbId,
          anilistId: p.anilistId,
          title: p.title,
          status: p.status,
          sonarrSeriesId: p.sonarrSeriesId,
          pushedAt: p.pushedAt,
          attempts: p.attempts,
          lastAttemptAt: p.lastAttemptAt,
          lastError: p.lastError,
        })),
      orphans,
      counts: { proposed: a.items.length, rejected: counts },
    });
  } catch (err) {
    console.error('[sonarr] report failed', err);
    return res.status(500).json({ error: 'Internal server error', code: 'SERVER_ERROR' });
  }
});

/**
 * The master switch. `{ enabled: boolean }`.
 *
 * Turning it on is the moment this feature starts writing to Sonarr and costing
 * disk, so it is its own explicit action rather than a side effect of saving
 * credentials.
 */
router.put('/enabled', requireAuth, requireAdmin, async (req, res) => {
  const enabled = req.body?.enabled;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be a boolean', code: 'BAD_REQUEST' });
  }
  const value = enabled ? 'true' : 'false';
  await prisma.appConfig.upsert({
    where: { key: PUSH_KEY },
    update: { value },
    create: { key: PUSH_KEY, value },
  });
  console.log(`[sonarr] pushing ${enabled ? 'ENABLED' : 'paused'}`);
  return res.json({ enabled });
});

/** Run the snapshot now, rather than waiting for the hourly timer. */
router.post('/snapshot', requireAuth, requireAdmin, async (_req, res) => {
  try {
    return res.json(await runSonarrSnapshot());
  } catch (err) {
    console.error('[sonarr] snapshot failed', err);
    return res.status(500).json({ error: 'Internal server error', code: 'SERVER_ERROR' });
  }
});

/**
 * Force-include an entry the filter dropped, or undo a suppression.
 *
 * `tvdbId` may be omitted when identity already knows one - the common case is
 * an entry dropped on *format* (a full-length ONA), which resolves perfectly
 * well. It is required when identity has nothing, because a list row without an
 * id is not a row.
 */
router.post('/include', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  const { anilistId, tvdbId, note } = req.body ?? {};
  if (!Number.isInteger(anilistId) || anilistId <= 0) {
    return res.status(400).json({ error: 'anilistId is required', code: 'BAD_REQUEST' });
  }
  let id = Number(tvdbId);
  if (!Number.isInteger(id) || id <= 0) {
    id = Number(resolveIdentity(anilistId).tvdbId);
  }
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({
      error: 'No TVDB id for this entry - resolve it on /admin/matching first, or send one',
      code: 'BAD_REQUEST',
    });
  }
  // An override may outrank the identity filter, but not blindly. Refuse a
  // pending or rejected identity until the caller says they have seen the
  // grade - 409 rather than 400 because the request is well-formed and the
  // conflict is with what we know, and it carries the grade so the UI can ask
  // a specific question instead of a generic "are you sure".
  const identity = resolveIdentity(anilistId);
  const unverified = identity.pending || identity.rejected;
  const acknowledge = req.body?.acknowledgeUnverified === true;
  if (unverified && !acknowledge) {
    return res.status(409).json({
      error:
        'This entry\'s identity is unverified - including it could add the wrong series. ' +
        'Re-send with acknowledgeUnverified to override.',
      code: 'UNVERIFIED_MATCH',
      grade: matchGrade(identity),
      matchedTitle: identity.matchedTitle,
      note: identity.note,
    });
  }

  const user = req.userId ? await prisma.user.findUnique({ where: { id: req.userId } }) : null;
  const data = {
    tvdbId: id,
    acknowledgedUnverified: unverified && acknowledge,
    // The provenance is worth keeping: a year from now "why is this on the
    // list" should be answerable without guessing.
    note:
      note ??
      (unverified ? `included despite an unverified match (${matchGrade(identity)})` : null),
    addedBy: user?.username ?? null,
  };
  await prisma.sonarrInclude.upsert({
    where: { anilistId },
    update: data,
    create: { anilistId, ...data },
  });
  return res.json({ anilistId, tvdbId: id, acknowledgedUnverified: data.acknowledgedUnverified });
});

router.delete('/include/:anilistId', requireAuth, requireAdmin, async (req, res) => {
  const anilistId = Number(req.params.anilistId);
  if (!Number.isInteger(anilistId)) {
    return res.status(400).json({ error: 'Invalid anilistId', code: 'BAD_REQUEST' });
  }
  await prisma.sonarrInclude.deleteMany({ where: { anilistId } });
  return res.json({ ok: true });
});

/** Admin: read config. The key itself is never sent back, only whether it is set. */
router.get('/config', requireAuth, requireAdmin, async (_req, res) => {
  const cfg = await getSonarrConfig();
  const keyRow = await prisma.appConfig.findUnique({ where: { key: 'sonarrApiKey' } });
  res.json({
    url: cfg?.url ?? '',
    apiKeySet: !!keyRow?.value,
    tags: cfg?.tags ?? TAGS_DEFAULT,
    markerTag: cfg?.markerTag ?? MARKER_TAG_DEFAULT,
    rootFolderPath: cfg?.rootFolderPath ?? '',
    qualityProfileId: cfg?.qualityProfileId ?? 0,
    seriesType: cfg?.seriesType ?? 'standard',
    seasonFolder: cfg?.seasonFolder ?? true,
    problems: pushConfigProblems(cfg),
  });
});

/**
 * The root folders and quality profiles Sonarr offers, for the setup dropdowns.
 *
 * Dropdowns rather than text fields because `rootFolderPath` has to match one of
 * Sonarr's own paths *exactly* - a stored `/media/Anime/` against Sonarr's
 * `/media/Anime` is rejected at add time, which is a long way from where the
 * typo was made.
 */
router.get('/config/options', requireAuth, requireAdmin, async (_req, res) => {
  const cfg = await getSonarrConfig();
  if (!cfg) return res.json({ ok: false, error: 'Sonarr is not configured' });
  const [folders, profiles, tags] = await Promise.all([
    sonarrRootFolders(cfg),
    sonarrQualityProfiles(cfg),
    sonarrTags(cfg),
  ]);
  if (!folders || !profiles) {
    return res.json({ ok: false, error: 'Could not read root folders or quality profiles' });
  }
  return res.json({
    ok: true,
    rootFolders: folders,
    qualityProfiles: profiles,
    tags: (tags ?? []).map((t) => t.label).sort(),
    // Which of the configured labels Sonarr does not have. Surfaced here so the
    // setup form can say so, instead of the push refusing later for a reason
    // that lives on a different page.
    missingTags: resolveTagIds(cfg.tags, tags).missing,
  });
});

router.put('/config', requireAuth, requireAdmin, async (req, res) => {
  const { url, apiKey, tags, markerTag, rootFolderPath, qualityProfileId, seriesType, seasonFolder } =
    req.body ?? {};
  const write = async (key: string, value: string) => {
    await prisma.appConfig.upsert({ where: { key }, update: { value }, create: { key, value } });
  };
  // An empty key or URL means "keep what is stored": Save on a blank form once
  // replaced a working Jellyfin address with a placeholder, and this is the same
  // form. The same reasoning covers the rest - a field the form did not send is
  // not a field the admin cleared.
  if (typeof url === 'string' && url.trim()) await write('sonarrUrl', url.trim().replace(/\/+$/, ''));
  if (typeof apiKey === 'string' && apiKey.trim()) await write('sonarrApiKey', apiKey.trim());
  if (typeof markerTag === 'string' && markerTag.trim()) {
    await write('sonarrMarkerTag', markerTag.trim());
  }
  // The marker is forced in on save as well as on read, so a hand-edited config
  // cannot leave us adding series that carry no record of being ours.
  const marker = (typeof markerTag === 'string' && markerTag.trim()) || (await getSonarrConfig())?.markerTag || MARKER_TAG_DEFAULT;
  if (typeof tags === 'string' && tags.trim()) {
    await write('sonarrTags', withMarker(parseTagList(tags), marker).join(','));
  } else if (Array.isArray(tags) && tags.length) {
    const list = tags.map(String).map((t) => t.trim()).filter(Boolean);
    await write('sonarrTags', withMarker(list, marker).join(','));
  }
  if (typeof rootFolderPath === 'string' && rootFolderPath.trim()) {
    await write('sonarrRootFolder', rootFolderPath.trim().replace(/\/+$/, ''));
  }
  if (Number.isInteger(qualityProfileId) && qualityProfileId > 0) {
    await write('sonarrQualityProfileId', String(qualityProfileId));
  }
  if (seriesType === 'standard' || seriesType === 'anime') await write('sonarrSeriesType', seriesType);
  if (typeof seasonFolder === 'boolean') await write('sonarrSeasonFolder', String(seasonFolder));
  clearSonarrConfigCache();
  return res.json({ ok: true });
});

/**
 * Admin: prove the credentials work.
 *
 * Hits authenticated `/system/status`, so green means the key is accepted - not
 * merely that something answered on the port.
 */
router.post('/config/test', requireAuth, requireAdmin, async (req, res) => {
  const { url, apiKey } = req.body ?? {};
  const stored = await getSonarrConfig();
  const cfg: SonarrConfig | null =
    typeof url === 'string' && url.trim() && typeof apiKey === 'string' && apiKey.trim()
      ? {
          ...(stored ?? {
            tags: TAGS_DEFAULT,
            markerTag: MARKER_TAG_DEFAULT,
            rootFolderPath: '',
            qualityProfileId: 0,
            seriesType: 'standard',
            seasonFolder: true,
          }),
          url: url.trim().replace(/\/+$/, ''),
          apiKey: apiKey.trim(),
        }
      : stored;
  if (!cfg) {
    return res.json({ ok: false, error: 'Sonarr is not configured' });
  }
  try {
    return res.json(await testSonarr(cfg));
  } catch (err) {
    // testSonarr already scrubs, but a throw from anywhere else must not carry
    // an axios config (and its X-Api-Key header) into the response.
    return res.json({ ok: false, error: sonarrErrorInfo(err) });
  }
});

export default router;
