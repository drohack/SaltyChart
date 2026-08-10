import { Router } from 'express';
import prisma from '../db';
import { requireAuth, requireAdmin, AuthRequest } from '../middleware/auth';
import { resolveIdentity, identityReady, matchGrade } from '../lib/seriesIdentity';
import {
  selectForSonarr,
  selectForSonarrDetailed,
  seasonsForSonarr,
  DEFAULT_WITHIN_DAYS,
  type SeasonRef,
  type SonarrCandidate,
  type SonarrListItem,
  type ForcedInclude,
} from '../lib/sonarrList';
import {
  getSonarrConfig,
  clearSonarrConfigCache,
  fetchSnapshot,
  sonarrExclusions,
  sonarrTags,
  testSonarr,
  sonarrErrorInfo,
  TAG_DEFAULT,
  type SonarrConfig,
  type SonarrSnapshot,
} from '../lib/sonarrApi';
import { reconcileSeen, suppressedTvdbIds, type SeenRow } from '../lib/sonarrSeen';
import { isValidSeason, isValidYear, type Season } from '../lib/validateSeason';

/**
 * The Sonarr Custom List: which new seasonal series should be grabbed.
 *
 *   GET /api/sonarr/list  ->  [{ "title": "...", "tvdbId": 123456 }, ...]
 *
 * **Exactly one route in this file is public: `GET /list`.** Every other route
 * carries `requireAuth` + `requireAdmin`. A public router that quietly grows
 * admin data is a real trap, so if you add a route here, say which of the two it
 * is before you write the handler.
 *
 * The list is unauthenticated and a **bare array**, because that is the only
 * shape Sonarr's Custom List import accepts. It carries its own Monitor, Series
 * Type, root folder, quality profile and tags on the *Sonarr* side - so no
 * Sonarr **write** credentials exist anywhere in this codebase. Sonarr pulls
 * from us; we never push to it. The read-only client is `lib/sonarrApi.ts`.
 *
 * **Sonarr re-reads this on a short, hardcoded interval - minutes, not hours.**
 * Import List Sync is a scheduled task (~5 min) and is NOT configurable the way
 * Radarr's List Update Interval is (Sonarr#5927, Sonarr#5011). An earlier
 * version of this comment said "every 6 hours", which was wrong and load-bearing
 * in two places: it made the rate-limit headroom look tighter than it is, and it
 * implied our own snapshot could notice a deletion before Sonarr re-added it.
 * It cannot - see `lib/sonarrSeen.ts`. Confirm the exact figure for the
 * installed version in Sonarr -> System -> Tasks before quoting one.
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
 * **Why relations decide scope but never identity.** `lib/sonarrList.ts` drops an
 * entry with a `PREQUEL` or `PARENT` edge. `lib/remoteIdentity.ts` records that
 * an `isRelation` guard was tried for *matching* and was wrong, because mapping a
 * sequel onto its parent is correct there. Both are right: that one asks "is this
 * the same series", this one asks "do we choose to auto-add it". A false skip
 * here costs nothing - anyone can still request the show in Seerr.
 *
 * **Why deletions suppress.** If a series is deleted from Sonarr without an
 * Import List Exclusion, this list re-proposes it and Sonarr re-grabs it - every
 * few minutes, forever. `lib/sonarrSeen.ts` observes "we proposed it, Sonarr
 * held it, it is gone" and stops proposing. That cannot beat the poll, so
 * Sonarr's own exclusion stays the primary defence (Maintainerr's
 * `listExclusions` is mandatory); this bounds an unbounded loop to one extra
 * grab.
 *
 * **This route must never trigger a cold AniList fetch.** It reads `SeasonCache`
 * and nothing else, and it serves a stale row happily. AniList's ~30/min budget
 * is shared with every viewer and the whole house's IP, and Sonarr re-reads this
 * every few minutes - a poll that could miss-and-fetch is how that budget gets
 * burned. The identity sweep follows the same rule.
 */

const router = Router();

/** Where the last snapshot's outcome is persisted, for the admin status line. */
const SNAPSHOT_KEY = 'sonarrSnapshotStatus';

/** Master switch: is the list actually served to Sonarr? */
const PUBLISH_KEY = 'sonarrListEnabled';

/**
 * **Off unless explicitly turned on**, and the default is the point.
 *
 * Everything else here is reviewable before it acts; this is the one thing that
 * causes downloads, so it fails closed. A fresh deployment, a restored backup
 * and a wiped `AppConfig` all serve an empty list rather than quietly handing
 * Sonarr forty series to grab.
 *
 * Paused means the list is **empty**, not erroring: an empty Custom List adds
 * nothing and Sonarr logs nothing, whereas a 503 every few minutes is noise
 * that trains you to ignore the log. It is inert only because Clean Library
 * Level stays Disabled - if that is ever changed, an empty list starts
 * unmonitoring things, and this decision has to be revisited.
 *
 * `?explain=1` and `/report` deliberately ignore this and keep showing the full
 * proposal, because reviewing what *would* be served while nothing is being
 * served is exactly what the pause is for.
 */
async function listEnabled(): Promise<boolean> {
  const row = await prisma.appConfig.findUnique({ where: { key: PUBLISH_KEY } });
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
  /** Held tvdbIds carrying our import-list tag. */
  taggedIds?: number[];
  orphans?: ReturnType<typeof reconcileSeen>['orphans'];
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

async function loadSeen(): Promise<SeenRow[]> {
  const rows = await prisma.sonarrSeen.findMany();
  return rows.map((r) => ({
    tvdbId: r.tvdbId,
    anilistId: r.anilistId ?? null,
    title: r.title ?? '',
    firstHeldAt: r.firstHeldAt ?? null,
    lastHeldAt: r.lastHeldAt ?? null,
    goneAt: r.goneAt ?? null,
    taggedByUs: !!r.taggedByUs,
  }));
}

interface Assembled {
  refs: SeasonRef[];
  perSeason: Array<{ season: string; year: number; cached: number }>;
  entries: unknown[];
  items: SonarrListItem[];
  rejected: ReturnType<typeof selectForSonarrDetailed>['rejected'];
  /** tvdbId -> anilistId for everything proposed, for the snapshot to key on. */
  proposedBy: Map<number, number>;
  seen: SeenRow[];
}

/**
 * Everything both `/list` and `/report` need, computed once.
 *
 * Sharing this is the point: two assemblies of "what would we propose" would
 * eventually disagree, and the one the page showed would not be the one Sonarr
 * fetched.
 */
async function assemble(refs: SeasonRef[], now: Date): Promise<Assembled> {
  const entries: unknown[] = [];
  const perSeason: Assembled['perSeason'] = [];
  for (const ref of refs) {
    const rows = await readCachedSeason(ref);
    perSeason.push({ season: ref.season, year: ref.year, cached: rows.length });
    entries.push(...rows);
  }

  const [forceInclude, seen] = await Promise.all([loadIncludes(), loadSeen()]);
  const suppressed = suppressedTvdbIds(
    seen,
    new Set([...forceInclude.values()].map((f) => f.tvdbId))
  );
  const { items, rejected } = selectForSonarrDetailed(entries, resolveIdentity, now, {
    suppressed,
    forceInclude,
  });

  // Which AniList entry produced each proposed tvdbId. The snapshot stores it so
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

  return { refs, perSeason, entries, items, rejected, proposedBy, seen };
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
 * Read Sonarr once and fold the result into `SonarrSeen`.
 *
 * Exported because two callers need it: the hourly timer in `index.ts` and the
 * admin's *Run snapshot now* button - the same shape as the identity sweep's
 * `triggerSweep`.
 *
 * Everything that decides whether a row changes lives in `reconcileSeen`, which
 * is pure and unit-tested. In particular this function does NOT decide that an
 * empty library means everything was deleted; it just hands over what it got.
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
  const tagId = tags?.find((t) => t.label.toLowerCase() === cfg.tag.toLowerCase())?.id ?? null;

  const result = reconcileSeen({
    prior: assembled.seen,
    snapshot,
    proposed: assembled.proposedBy,
    currentIdentity: currentIdentityMap(assembled.entries),
    tagId,
    now,
  });

  for (const row of result.upserts) {
    await prisma.sonarrSeen.upsert({
      where: { tvdbId: row.tvdbId },
      update: { ...row },
      create: { ...row },
    });
  }

  if (result.suppressed.length) {
    console.log(
      `[sonarr] ${result.suppressed.length} series deleted from Sonarr - no longer proposing: ` +
        result.suppressed.join(', ')
    );
  }

  // Exclusions are read here rather than in `/report` for the same reason the
  // ids are cached: the report must not make a page load wait on Sonarr.
  const exclusions = snapshot.ok ? await sonarrExclusions(cfg) : null;

  const status: SnapshotStatus = {
    at: now.toISOString(),
    ok: snapshot.ok && !result.skipped,
    seriesCount: snapshot.series.length,
    ...(snapshot.error ? { error: snapshot.error } : {}),
    ...(result.skipped ? { skipped: result.skipped } : {}),
    // Only recorded on a run we trust. A failed or empty read must not
    // overwrite a good set with an empty one - the report would then show
    // everything as "will be added", which is the same class of lie the
    // suppression guards exist to prevent.
    ...(snapshot.ok && !result.skipped
      ? {
          heldIds: snapshot.series.map((s) => s.tvdbId),
          taggedIds:
            tagId === null ? [] : snapshot.series.filter((s) => s.tags.includes(tagId)).map((s) => s.tvdbId),
          ...(exclusions ? { excludedIds: exclusions.map((e) => e.tvdbId) } : {}),
          orphans: result.orphans,
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

/** Both or neither, and both valid. Shared by `/list` and `/report`. */
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

// ---------------------------------------------------------------------------
// PUBLIC - the only one. Sonarr reads this unattended.
// ---------------------------------------------------------------------------
router.get('/list', async (req, res) => {
  const { season, year } = req.query as { season?: string; year?: string };
  const override = seasonOverride(season, year);
  if ('error' in override) {
    return res.status(400).json({ error: override.error, code: 'BAD_REQUEST' });
  }

  // Before the community map has loaded, every identity lookup returns "no id"
  // for the wrong reason - not "unmapped" but "not read yet" - so a poll in the
  // seconds after a restart would hand Sonarr a truncated list it has no way to
  // recognise as truncated. 503 makes a failed poll visible in Sonarr's log
  // instead of looking authoritative. Same shape as `routes/anime.ts` uses when
  // AniList is unavailable.
  if (!identityReady()) {
    res.setHeader('Retry-After', '60');
    return res.status(503).json({
      error: 'Identity data is still loading; try again shortly',
      code: 'UPSTREAM_ERROR',
    });
  }

  try {
    const now = new Date();

    // Paused: answer the empty list immediately, without even assembling one.
    // `explain` still falls through, so the admin page can review a paused list.
    if (!req.query.explain && !(await listEnabled())) {
      return res.json([]);
    }

    const a = await assemble(override.refs ?? seasonsForSonarr(now), now);

    // `?explain=1` is the filter breakdown with no Sonarr data in it, kept
    // public because it describes only our own decision. The admin `/report`
    // below is the same computation plus what Sonarr actually did.
    if (req.query.explain) {
      const counts: Record<string, number> = {};
      for (const r of a.rejected) counts[r.reason] = (counts[r.reason] ?? 0) + 1;
      return res.json({
        seasons: a.perSeason,
        withinDays: DEFAULT_WITHIN_DAYS,
        proposed: a.items.map((i) => describeProposed(i, a.entries)),
        rejected: a.rejected.map((r) => ({ ...describe(r.entry), reason: r.reason })),
        counts: { proposed: a.items.length, rejected: counts },
      });
    }

    return res.json(a.items);
  } catch (err) {
    console.error('[sonarr] list failed', err);
    return res.status(500).json({ error: 'Internal server error', code: 'SERVER_ERROR' });
  }
});

/**
 * Fields the admin page reads that `sonarrList.ts` does not filter on, so they
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

function describeProposed(item: SonarrListItem, entries: unknown[]) {
  const e = entries.find((raw) => {
    const c = raw as CacheEntry;
    const t = c?.title?.english || c?.title?.romaji || c?.title?.native;
    return t?.trim() === item.title;
  }) as CacheEntry | undefined;
  return {
    ...item,
    ...(e ? describe(e) : {}),
    title: item.title,
    episodes: e?.episodes ?? null,
  };
}

// ---------------------------------------------------------------------------
// ADMIN - everything below requires the admin account.
// ---------------------------------------------------------------------------

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
    const published = await listEnabled();

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

    const state = (tvdbId: number) => {
      if (!observed) return 'unknown';
      if (heldIds.has(tvdbId)) return taggedIds.has(tvdbId) ? 'addedByUs' : 'heldAlready';
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
        tag: cfg?.tag ?? TAG_DEFAULT,
        tagHeldCount: taggedIds.size,
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
      suppressed: a.seen
        .filter((s) => s.goneAt !== null)
        .map((s) => ({
          tvdbId: s.tvdbId,
          anilistId: s.anilistId,
          title: s.title,
          lastHeldAt: s.lastHeldAt,
          goneAt: s.goneAt,
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
 * Turning it on is the moment this feature starts costing disk, so it is its
 * own explicit action rather than a side effect of saving credentials.
 */
router.put('/publish', requireAuth, requireAdmin, async (req, res) => {
  const enabled = req.body?.enabled;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be a boolean', code: 'BAD_REQUEST' });
  }
  const value = enabled ? 'true' : 'false';
  await prisma.appConfig.upsert({
    where: { key: PUBLISH_KEY },
    update: { value },
    create: { key: PUBLISH_KEY, value },
  });
  console.log(`[sonarr] list publishing ${enabled ? 'ENABLED' : 'paused'}`);
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

/** Admin: read config - the URL and tag only; the key is never sent back. */
router.get('/config', requireAuth, requireAdmin, async (_req, res) => {
  const rows = await prisma.appConfig.findMany({
    where: { key: { in: ['sonarrUrl', 'sonarrApiKey', 'sonarrTag'] } },
  });
  res.json({
    url: rows.find((r) => r.key === 'sonarrUrl')?.value ?? '',
    apiKeySet: !!rows.find((r) => r.key === 'sonarrApiKey')?.value,
    tag: rows.find((r) => r.key === 'sonarrTag')?.value || TAG_DEFAULT,
  });
});

router.put('/config', requireAuth, requireAdmin, async (req, res) => {
  const { url, apiKey, tag } = req.body ?? {};
  const write = async (key: string, value: string) => {
    await prisma.appConfig.upsert({ where: { key }, update: { value }, create: { key, value } });
  };
  // An empty key or URL means "keep what is stored": Save on a blank form once
  // replaced a working Jellyfin address with a placeholder, and this is the same
  // form. An empty tag is different - it falls back to the default rather than
  // being a meaningful choice - so it is only written when non-empty.
  if (typeof url === 'string' && url.trim()) await write('sonarrUrl', url.trim().replace(/\/+$/, ''));
  if (typeof apiKey === 'string' && apiKey.trim()) await write('sonarrApiKey', apiKey.trim());
  if (typeof tag === 'string' && tag.trim()) await write('sonarrTag', tag.trim());
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
      ? { url: url.trim().replace(/\/+$/, ''), apiKey: apiKey.trim(), tag: stored?.tag ?? TAG_DEFAULT }
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
