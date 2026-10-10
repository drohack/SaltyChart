import prisma from '../db';
import {
  auditSeries,
  compareRows,
  type JellyfinEpisodeLite,
  type SeriesAudit,
  type SeriesState,
  type SonarrEpisodeLite,
  type SubState,
} from './libraryAudit';

// ---------------------------------------------------------------------------
// The library check: audit English subtitles across the series we added, and
// nudge Jellyfin about any file Sonarr has replaced since Jellyfin last looked.
//
// **Why SaltyChart nudges Jellyfin at all.** Sonarr upgrades files - under the
// "Anime Dual Audio" profile that is the point - and deletes the old one. Until
// Jellyfin rescans, its item still names the deleted file, so every segment
// 500s; after the rescan the episode has a NEW item id (Jellyfin derives ids
// from the path: PANDOROBO S01E01 went 605851d7... -> 0c176725... on 2026-10-09)
// and every cached reference to the old one is dead. Jellyfin's own scan runs
// every 12 h here and realtime monitoring is off.
//
// Sonarr's Connect -> Emby/Jellyfin "Update Library" would fix the first half,
// and is **deliberately off**: the owner does not want Jellyfin told about every
// import. This replaces it with something narrower - only series whose files
// actually changed, once a day on the scheduled job, or when an admin presses
// Refresh Jellyfin on /admin/sonarr.
//
// **What it writes: one Jellyfin `Refresh` per stale series, nothing else.** No
// Sonarr writes (`sonarrApi.ts` keeps exactly one write verb), no file changes.
// ---------------------------------------------------------------------------

/** AppConfig key holding the last check. Display-only; nothing decides from it. */
export const LIBRARY_AUDIT_KEY = 'libraryAudit';

const CONCURRENCY = 4;
/** After a refresh, how long to watch for Jellyfin to catch up: 8 x 15 s. */
const POLL_TRIES = 8;
/**
 * A library scan for a brand-new show folder takes longer than one series
 * refresh, so it gets a longer window: 20 x 15 s = 5 minutes.
 */
const NEW_SERIES_POLL_TRIES = 20;
const POLL_INTERVAL_MS = 15_000;

/** `schedule` = the daily job in index.ts; `admin` = the Refresh Jellyfin button. */
export type Trigger = 'schedule' | 'admin';

/** One series we added, as the last Sonarr snapshot saw it. */
export interface OurSeries {
  sonarrId: number;
  tvdbId: number;
  title: string;
  titleSlug: string | null;
  qualityProfileId: number | null;
  episodeFileCount: number;
}

export interface LibraryRow {
  sonarrId: number;
  tvdbId: number;
  title: string;
  titleSlug: string | null;
  qualityProfileId: number | null;
  /** Jellyfin's series item id, or null when no Jellyfin series carries this TVDB id. */
  jellyfinId: string | null;
  state: SeriesState | 'error';
  error?: string;
  audit?: SeriesAudit;
}

export interface LibraryAudit {
  at: string;
  trigger: Trigger;
  rows: LibraryRow[];
  totals: {
    series: number;
    episodes: number;
    counts: Record<SubState, number>;
    dubbed: number;
    stale: number;
    seriesStale: number;
    seriesMissing: number;
    /** Checked from Sonarr's codes only - no Jellyfin series to compare. */
    unmatched: number;
    errors: number;
  };
  refresh: {
    requested: Array<{ jellyfinId: string; title: string }>;
    failed: Array<{ jellyfinId: string; title: string; error: string }>;
    /** False while we are still watching Jellyfin catch up. */
    settled: boolean;
    /** Requested, watched for the whole poll window, and still stale. */
    stillStale: string[];
    /**
     * Shows Sonarr has files for that Jellyfin had no series for at all - a
     * new folder no scan had reached. The TV libraries were scanned for them.
     */
    newSeries?: { scanned: string[]; found: string[]; stillMissing: string[]; error?: string };
  } | null;
}

/** What is persisted: the last good audit, plus the last failure if a later run had one. */
export interface StoredLibraryAudit {
  last: LibraryAudit | null;
  lastError: string | null;
  lastAttemptAt: string | null;
}

/** Everything the check needs from outside, injected so the rules stay testable. */
export interface LibraryCheckDeps {
  /** From the cached snapshot; null when no snapshot has recorded it yet. */
  ours: OurSeries[] | null;
  readSonarrEpisodes(sonarrId: number): Promise<SonarrEpisodeLite[] | null>;
  /** Null when Jellyfin is not configured - the audit then runs from Sonarr alone. */
  jellyfin: {
    seriesByTvdb: Map<string, string>;
    episodes(seriesItemId: string): Promise<JellyfinEpisodeLite[]>;
    refresh(seriesItemId: string): Promise<void>;
    /** Drop every cached availability verdict pointing into this series. */
    forget(seriesItemId: string): void;
    /** Scan Jellyfin's TV libraries for new show folders; returns their names. */
    scanLibraries(): Promise<string[]>;
    /** Re-read Jellyfin's series list into `seriesByTvdb`. */
    reindex(): Promise<void>;
    /** Drop cached "not in the library" verdicts, so a show that just appeared is looked up again. */
    forgetMissing(): void;
  } | null;
  sleep?: (ms: number) => Promise<void>;
}

/** May a check start now? One at a time - a second request joins the first. */
export function decideStart(running: boolean): 'start' | 'running' {
  return running ? 'running' : 'start';
}

/**
 * Which series to ask Jellyfin to refresh: stale ones it holds, and nothing
 * else. Refreshing every series would be a full-library scan by another name -
 * the per-import churn the owner turned down, multiplied.
 */
export function seriesToRefresh(rows: LibraryRow[]): Array<{ jellyfinId: string; title: string }> {
  return rows
    .filter((r) => r.state === 'stale' && r.jellyfinId)
    .map((r) => ({ jellyfinId: r.jellyfinId!, title: r.title }));
}

/**
 * Shows Sonarr has files for that Jellyfin has no series for at all.
 *
 * Refreshing a series cannot help these - there is no series to refresh. It is
 * a new folder no library scan has reached yet, and until one does the show is
 * "not in the library" on Randomize: A Certain Dark Item, 2026-10-10, added to
 * Sonarr under /media/TV Shows at 05:20 with no Jellyfin series hours later.
 * Only rows with files on disk count - a show with nothing downloaded is not
 * missing from Jellyfin, it is missing from disk.
 */
export function seriesMissingFromJellyfin(
  rows: LibraryRow[]
): Array<{ sonarrId: number; tvdbId: number; title: string }> {
  return rows
    .filter((r) => !r.jellyfinId && (r.audit?.episodes ?? 0) > 0)
    .map((r) => ({ sonarrId: r.sonarrId, tvdbId: r.tvdbId, title: r.title }));
}

export function totalsOf(rows: LibraryRow[]): LibraryAudit['totals'] {
  const counts: Record<SubState, number> = { fullEng: 0, signsOnly: 0, engAudio: 0, none: 0, unknown: 0 };
  let episodes = 0;
  let stale = 0;
  let dubbed = 0;
  for (const r of rows) {
    if (!r.audit) continue;
    episodes += r.audit.episodes;
    stale += r.audit.stale;
    dubbed += r.audit.dubbed ?? 0;
    for (const k of Object.keys(counts) as SubState[]) counts[k] += r.audit.counts[k];
  }
  return {
    series: rows.length,
    episodes,
    counts,
    dubbed,
    stale,
    seriesStale: rows.filter((r) => r.state === 'stale').length,
    seriesMissing: rows.filter((r) => r.state === 'missing').length,
    unmatched: rows.filter((r) => r.audit?.source === 'sonarr').length,
    errors: rows.filter((r) => r.state === 'error').length,
  };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

const errText = (err: any) => String(err?.message ?? err).slice(0, 200);

async function auditOne(
  s: OurSeries,
  deps: LibraryCheckDeps,
  sonarrEpisodes?: SonarrEpisodeLite[]
): Promise<{ row: LibraryRow; sonarrEpisodes: SonarrEpisodeLite[] | null }> {
  const jellyfinId = deps.jellyfin?.seriesByTvdb.get(String(s.tvdbId)) ?? null;
  const base = {
    sonarrId: s.sonarrId,
    tvdbId: s.tvdbId,
    title: s.title,
    titleSlug: s.titleSlug,
    qualityProfileId: s.qualityProfileId,
    jellyfinId,
  };
  const eps = sonarrEpisodes ?? (await deps.readSonarrEpisodes(s.sonarrId));
  if (!eps) {
    // "Could not ask" - never folded into a subtitle count, which would read
    // as either fine or broken and be wrong both ways.
    return { row: { ...base, state: 'error', error: 'Sonarr did not answer' }, sonarrEpisodes: null };
  }
  let jf: JellyfinEpisodeLite[] | null = null;
  let jfError: string | undefined;
  if (deps.jellyfin && jellyfinId) {
    try {
      jf = await deps.jellyfin.episodes(jellyfinId);
    } catch (err) {
      // Fall back to Sonarr's codes rather than losing the row, and say so.
      jfError = `Jellyfin did not answer: ${errText(err)}`;
    }
  }
  const audit = auditSeries(eps, jf);
  return {
    row: { ...base, state: audit.state, audit, ...(jfError ? { error: jfError } : {}) },
    sonarrEpisodes: eps,
  };
}

async function readStored(): Promise<StoredLibraryAudit> {
  const row = await prisma.appConfig.findUnique({ where: { key: LIBRARY_AUDIT_KEY } });
  if (!row?.value) return { last: null, lastError: null, lastAttemptAt: null };
  try {
    return JSON.parse(row.value) as StoredLibraryAudit;
  } catch {
    return { last: null, lastError: null, lastAttemptAt: null }; // corrupt reads as "never ran"
  }
}

async function writeStored(v: StoredLibraryAudit): Promise<void> {
  const value = JSON.stringify(v);
  await prisma.appConfig.upsert({
    where: { key: LIBRARY_AUDIT_KEY },
    update: { value },
    create: { key: LIBRARY_AUDIT_KEY, value },
  });
}

/** The last check, for `/api/sonarr/report`. Never throws. */
export async function readLibraryAudit(): Promise<StoredLibraryAudit> {
  try {
    return await readStored();
  } catch {
    return { last: null, lastError: null, lastAttemptAt: null };
  }
}

/** A failed run keeps the last good audit on screen and records why this one failed. */
async function recordFailure(error: string, at: Date): Promise<void> {
  const prev = await readStored().catch(() => ({ last: null } as StoredLibraryAudit));
  await writeStored({ last: prev.last, lastError: error, lastAttemptAt: at.toISOString() });
}

let _running = false;

export function libraryCheckRunning(): boolean {
  return _running;
}

export interface StartResult {
  status: 'started' | 'running';
  /**
   * Resolves once the audit is stored and any refreshes are REQUESTED - not when
   * Jellyfin has caught up, which is watched in the background for up to two
   * minutes. Absent unless this call started the run.
   */
  firstPass?: Promise<StoredLibraryAudit>;
}

/**
 * Start a check unless one is running. Never throws and never makes the caller
 * wait for Jellyfin to finish rescanning.
 */
export function startLibraryCheck(trigger: Trigger, makeDeps: () => Promise<LibraryCheckDeps>): StartResult {
  if (decideStart(_running) !== 'start') return { status: 'running' };
  // Set synchronously, before the first await, so a second request arriving in
  // the same tick sees it - the same discipline as the identity sweep's guard.
  _running = true;

  let resolveFirst!: (v: StoredLibraryAudit) => void;
  const firstPass = new Promise<StoredLibraryAudit>((r) => (resolveFirst = r));

  void (async () => {
    const at = new Date();
    try {
      const deps = await makeDeps();
      if (!deps.ours) {
        await recordFailure('No Sonarr snapshot lists our series yet - run "Re-read Sonarr" first', at);
        resolveFirst(await readStored());
        return;
      }
      const ours = deps.ours.filter((s) => s.episodeFileCount > 0);
      const results = await mapLimit(ours, CONCURRENCY, (s) => auditOne(s, deps));
      const rows = results.map((r) => r.row).sort(compareRows);
      const sonarrById = new Map(results.map((r) => [r.row.sonarrId, r.sonarrEpisodes]));

      const toRefresh = deps.jellyfin ? seriesToRefresh(rows) : [];
      const requested: Array<{ jellyfinId: string; title: string }> = [];
      const failed: Array<{ jellyfinId: string; title: string; error: string }> = [];
      for (const t of toRefresh) {
        try {
          await deps.jellyfin!.refresh(t.jellyfinId);
          requested.push(t);
        } catch (err) {
          failed.push({ ...t, error: errText(err) });
        }
      }
      // A show Jellyfin has never seen cannot be refreshed - it needs a scan of
      // the library its folder lives in. Only when one exists, so this is not a
      // scan per check: on a normal day the list is empty.
      const missing = deps.jellyfin ? seriesMissingFromJellyfin(rows) : [];
      let scanned: string[] = [];
      let scanError: string | undefined;
      if (missing.length) {
        try {
          scanned = await deps.jellyfin!.scanLibraries();
        } catch (err) {
          scanError = errText(err);
        }
      }
      if (requested.length || failed.length || missing.length) {
        console.log(
          `[library] ${trigger} check: asked Jellyfin to refresh ${requested.length} series` +
            (failed.length ? `, ${failed.length} refresh request(s) failed` : '') +
            (missing.length
              ? `; ${missing.length} show(s) not in Jellyfin at all, scanned ${scanned.join(', ') || 'nothing'}` +
                (scanError ? ` (scan failed: ${scanError})` : '')
              : '')
        );
      }

      const newSeries = missing.length
        ? {
            scanned,
            found: [] as string[],
            stillMissing: missing.map((m) => m.title),
            ...(scanError ? { error: scanError } : {}),
          }
        : undefined;
      const audit: LibraryAudit = {
        at: at.toISOString(),
        trigger,
        rows,
        totals: totalsOf(rows),
        refresh:
          requested.length || failed.length || missing.length
            ? {
                requested,
                failed,
                settled: requested.length === 0 && scanned.length === 0,
                stillStale: [],
                ...(newSeries ? { newSeries } : {}),
              }
            : null,
      };
      await writeStored({ last: audit, lastError: null, lastAttemptAt: at.toISOString() });
      resolveFirst(await readStored());

      if (!requested.length && !scanned.length) return;

      // Watch Jellyfin catch up. Cached availability is dropped only once its
      // path matches Sonarr's: dropping it the moment we ask would let the next
      // viewer re-cache the OLD item for another hour, because Jellyfin is still
      // serving it until the refresh lands. `ITEM_GONE` on /playback is the
      // backstop for anything still cached when the old item disappears.
      const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
      const pending = new Map(requested.map((t) => [t.jellyfinId, t]));
      const pendingNew = new Map(scanned.length ? missing.map((m) => [m.sonarrId, m]) : []);
      for (let i = 0; i < NEW_SERIES_POLL_TRIES && (pending.size || pendingNew.size); i++) {
        await sleep(POLL_INTERVAL_MS);
        if (i >= POLL_TRIES) pending.clear(); // the stale window is shorter; what is left stays stale
        for (const [jellyfinId] of [...pending]) {
          const row = rows.find((r) => r.jellyfinId === jellyfinId);
          if (!row) {
            pending.delete(jellyfinId);
            continue;
          }
          const ours1 = ours.find((s) => s.sonarrId === row.sonarrId)!;
          const again = await auditOne(ours1, deps, sonarrById.get(row.sonarrId) ?? undefined);
          if (again.row.audit && again.row.audit.stale === 0) {
            Object.assign(row, again.row);
            deps.jellyfin!.forget(jellyfinId);
            pending.delete(jellyfinId);
          }
        }
        if (pendingNew.size) {
          await deps.jellyfin!.reindex();
          let foundAny = false;
          for (const [sonarrId, m] of [...pendingNew]) {
            if (!deps.jellyfin!.seriesByTvdb.has(String(m.tvdbId))) continue;
            const row = rows.find((r) => r.sonarrId === sonarrId);
            const ours1 = ours.find((x) => x.sonarrId === sonarrId);
            if (row && ours1) {
              const again = await auditOne(ours1, deps, sonarrById.get(sonarrId) ?? undefined);
              Object.assign(row, again.row);
            }
            newSeries!.found.push(m.title);
            pendingNew.delete(sonarrId);
            foundAny = true;
          }
          // The show is in the library now, but Randomize was told it is not and
          // that answer is cached for 10 minutes - drop it so the next look-up
          // finds the episode.
          if (foundAny) deps.jellyfin!.forgetMissing();
        }
      }
      rows.sort(compareRows);
      audit.totals = totalsOf(rows);
      const stillStale = requested
        .filter((t) => rows.find((r) => r.jellyfinId === t.jellyfinId)?.audit?.stale)
        .map((t) => t.title);
      if (newSeries) newSeries.stillMissing = [...pendingNew.values()].map((m) => m.title);
      audit.refresh = {
        requested,
        failed,
        settled: true,
        stillStale,
        ...(newSeries ? { newSeries } : {}),
      };
      if (stillStale.length) {
        console.warn(`[library] Jellyfin still out of date after refresh for: ${stillStale.join(', ')}`);
      }
      if (newSeries?.found.length || newSeries?.stillMissing.length) {
        console.log(
          `[library] new shows: found ${newSeries.found.join(', ') || 'none'}` +
            (newSeries.stillMissing.length ? `; still not in Jellyfin: ${newSeries.stillMissing.join(', ')}` : '')
        );
      }
      await writeStored({ last: audit, lastError: null, lastAttemptAt: at.toISOString() });
    } catch (err) {
      console.warn('[library] check failed:', errText(err));
      await recordFailure(errText(err), at).catch(() => {});
      resolveFirst(await readStored().catch(() => ({ last: null, lastError: errText(err), lastAttemptAt: at.toISOString() })));
    } finally {
      _running = false;
    }
  })();

  return { status: 'started', firstPass };
}
