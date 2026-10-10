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
// actually changed, only when someone is about to watch (a Randomize visit) or
// an admin asks.
//
// **What it writes: one Jellyfin `Refresh` per stale series, nothing else.** No
// Sonarr writes (`sonarrApi.ts` keeps exactly one write verb), no file changes.
// ---------------------------------------------------------------------------

/** AppConfig key holding the last check. Display-only; nothing decides from it. */
export const LIBRARY_AUDIT_KEY = 'libraryAudit';

/**
 * A Randomize visit starts at most one check per this interval.
 *
 * A check is ~165 LAN requests and measured 3.6 s over 82 series; a busy page
 * would otherwise fire one per viewer per load. In-memory on purpose: this
 * protects our own LAN services, not AniList, so a restart costing one extra
 * run is fine - unlike the AniList rule, where restarts ARE the load.
 */
export const VISIT_INTERVAL_MS = 10 * 60_000;

const CONCURRENCY = 4;
/** After a refresh, how long to watch for Jellyfin to catch up: 8 x 15 s. */
const POLL_TRIES = 8;
const POLL_INTERVAL_MS = 15_000;

export type Trigger = 'visit' | 'admin';

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
  } | null;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * May a check start now?
 *
 * One at a time always. A visit additionally waits out `VISIT_INTERVAL_MS`
 * since the last start; an admin pressing the button is never the budget - the
 * same reasoning as *Push now* and the sweep's drain.
 */
export function decideStart(
  trigger: Trigger,
  running: boolean,
  lastStartedAt: number | null,
  now: number
): 'start' | 'running' | 'throttled' {
  if (running) return 'running';
  if (trigger === 'visit' && lastStartedAt !== null && now - lastStartedAt < VISIT_INTERVAL_MS) {
    return 'throttled';
  }
  return 'start';
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

export function totalsOf(rows: LibraryRow[]): LibraryAudit['totals'] {
  const counts: Record<SubState, number> = { fullEng: 0, signsOnly: 0, engAudio: 0, none: 0, unknown: 0 };
  let episodes = 0;
  let stale = 0;
  for (const r of rows) {
    if (!r.audit) continue;
    episodes += r.audit.episodes;
    stale += r.audit.stale;
    for (const k of Object.keys(counts) as SubState[]) counts[k] += r.audit.counts[k];
  }
  return {
    series: rows.length,
    episodes,
    counts,
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
let _lastStartedAt: number | null = null;

export function libraryCheckRunning(): boolean {
  return _running;
}

export interface StartResult {
  status: 'started' | 'running' | 'throttled';
  /**
   * Resolves once the audit is stored and any refreshes are REQUESTED - not when
   * Jellyfin has caught up, which is watched in the background for up to two
   * minutes. Absent unless this call started the run.
   */
  firstPass?: Promise<StoredLibraryAudit>;
}

/**
 * Start a check if the rules allow one. Never throws and never makes the caller
 * wait for Jellyfin to finish rescanning.
 *
 * `makeDeps` is only called once a run is actually starting, so a throttled
 * visit costs nothing at all - not even a config read.
 */
export function startLibraryCheck(trigger: Trigger, makeDeps: () => Promise<LibraryCheckDeps>): StartResult {
  const now = Date.now();
  const decision = decideStart(trigger, _running, _lastStartedAt, now);
  if (decision !== 'start') return { status: decision };
  // Set synchronously, before the first await, so a second request arriving in
  // the same tick sees it - the same discipline as the identity sweep's guard.
  _running = true;
  _lastStartedAt = now;

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
      if (requested.length || failed.length) {
        console.log(
          `[library] ${trigger} check: asked Jellyfin to refresh ${requested.length} series` +
            (failed.length ? `, ${failed.length} refresh request(s) failed` : '')
        );
      }

      const audit: LibraryAudit = {
        at: at.toISOString(),
        trigger,
        rows,
        totals: totalsOf(rows),
        refresh:
          requested.length || failed.length
            ? { requested, failed, settled: requested.length === 0, stillStale: [] }
            : null,
      };
      await writeStored({ last: audit, lastError: null, lastAttemptAt: at.toISOString() });
      resolveFirst(await readStored());

      if (!requested.length) return;

      // Watch Jellyfin catch up. Cached availability is dropped only once its
      // path matches Sonarr's: dropping it the moment we ask would let the next
      // viewer re-cache the OLD item for another hour, because Jellyfin is still
      // serving it until the refresh lands. `ITEM_GONE` on /playback is the
      // backstop for anything still cached when the old item disappears.
      const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
      const pending = new Map(requested.map((t) => [t.jellyfinId, t]));
      for (let i = 0; i < POLL_TRIES && pending.size; i++) {
        await sleep(POLL_INTERVAL_MS);
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
      }
      rows.sort(compareRows);
      audit.totals = totalsOf(rows);
      audit.refresh = {
        requested,
        failed,
        settled: true,
        stillStale: [...pending.values()].map((t) => t.title),
      };
      if (pending.size) {
        console.warn(
          `[library] Jellyfin still out of date after refresh for: ${audit.refresh.stillStale.join(', ')}`
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
