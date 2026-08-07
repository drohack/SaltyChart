import { Router } from 'express';
import prisma from '../db';
import { resolveIdentity, identityReady } from '../lib/seriesIdentity';
import {
  selectForSonarr,
  selectForSonarrDetailed,
  seasonsForSonarr,
  DEFAULT_WITHIN_DAYS,
  type SeasonRef,
  type SonarrCandidate,
} from '../lib/sonarrList';
import { isValidSeason, isValidYear, type Season } from '../lib/validateSeason';

/**
 * The Sonarr Custom List: which new seasonal series should be grabbed.
 *
 *   GET /api/sonarr/list  ->  [{ "title": "...", "tvdbId": 123456 }, ...]
 *
 * Unauthenticated and a **bare array**, because that is the only shape Sonarr's
 * Custom List import accepts. Sonarr polls it every 6 hours and carries its own
 * Monitor, Series Type, root folder, quality profile and tags - so no Sonarr
 * credentials exist anywhere in this codebase. Sonarr pulls from us; we never
 * push to it.
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
 * **This route must never trigger a cold AniList fetch.** It reads `SeasonCache`
 * and nothing else, and it serves a stale row happily. AniList's ~30/min budget
 * is shared with every viewer and the whole house's IP; a six-hourly poll that
 * could miss-and-fetch is how that gets tripped. The identity sweep follows the
 * same rule.
 */

const router = Router();

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

router.get('/list', async (req, res) => {
  const { season, year } = req.query as { season?: string; year?: string };

  // Optional override, for the test and the dry-run tool. Both or neither: a
  // lone `?season=` would otherwise silently serve the calendar default and
  // make a failing assertion look like a filter bug.
  if ((season && !year) || (!season && year)) {
    return res.status(400).json({
      error: 'Provide both "season" and "year", or neither',
      code: 'BAD_REQUEST',
    });
  }
  if (season && year && (!isValidSeason(season) || !isValidYear(year))) {
    return res.status(400).json({ error: 'Invalid season or year', code: 'BAD_REQUEST' });
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
    const refs: SeasonRef[] =
      season && year
        ? [{ season: season.toUpperCase() as Season, year: Number(year) }]
        : seasonsForSonarr(now);

    // Both seasons are selected over as ONE list, so the dedupe sees a split
    // cour that straddles the boundary. Concatenating after selection would let
    // one TVDB id through twice.
    const entries: unknown[] = [];
    const perSeason: Array<{ season: string; year: number; cached: number }> = [];
    for (const ref of refs) {
      const rows = await readCachedSeason(ref);
      perSeason.push({ season: ref.season, year: ref.year, cached: rows.length });
      entries.push(...rows);
    }

    // `?explain=1` answers "why is this list the shape it is", for
    // `tools/sonarr_dryrun.py` (and, later, an admin view). It exists so the
    // dry run does not have to reimplement the filter in Python - a second copy
    // would drift from this one and start describing a program we don't ship.
    //
    // Deliberately an OBJECT, so it can never be mistaken for the list itself:
    // Sonarr requests the bare URL and would reject this outright. A count
    // alone is not reviewable - "39 proposed" tells you nothing, "24 dropped on
    // a PREQUEL/PARENT edge" tells you whether the filter is sane.
    if (req.query.explain) {
      const { items, rejected } = selectForSonarrDetailed(entries, resolveIdentity, now);
      const counts: Record<string, number> = {};
      for (const r of rejected) counts[r.reason] = (counts[r.reason] ?? 0) + 1;
      // `episodes` is not a field `sonarrList.ts` filters on, so it is not in
      // `SonarrCandidate`; it is read here only to size the download estimate.
      type CacheEntry = SonarrCandidate & { episodes?: number | null };
      const describe = (e: CacheEntry) => ({
        anilistId: e.id ?? null,
        title: e.title?.english || e.title?.romaji || e.title?.native || null,
        format: e.format ?? null,
        status: e.status ?? null,
        startDate: e.startDate ?? null,
      });
      const byTitle = new Map<string, CacheEntry>();
      for (const raw of entries) {
        const e = raw as CacheEntry;
        const t = e?.title?.english || e?.title?.romaji || e?.title?.native;
        if (t) byTitle.set(t.trim(), e);
      }
      return res.json({
        seasons: perSeason,
        withinDays: DEFAULT_WITHIN_DAYS,
        proposed: items.map((i) => {
          const e = byTitle.get(i.title);
          return { ...i, ...(e ? describe(e) : {}), title: i.title, episodes: e?.episodes ?? null };
        }),
        rejected: rejected.map((r) => ({ ...describe(r.entry), reason: r.reason })),
        counts: { proposed: items.length, rejected: counts },
      });
    }

    return res.json(selectForSonarr(entries, resolveIdentity, now));
  } catch (err) {
    console.error('[sonarr] list failed', err);
    return res.status(500).json({ error: 'Internal server error', code: 'SERVER_ERROR' });
  }
});

export default router;
