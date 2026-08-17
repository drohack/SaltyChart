/**
 * What the trailer subtitle pipeline has actually done, per video.
 *
 * Pure and I/O-free, like `sonarrSelect.ts`: the route reads `SeasonCache` and
 * `SubtitleCache` and hands both in, so every predicate here is unit-tested
 * without a database. `/admin/subtitles` renders exactly what this returns.
 *
 * **The states are defined here and only here.** The admin page badges them and
 * counts them but never re-derives one - the lesson from `AdminSonarr.svelte`,
 * where two computations of "what would be added" would eventually disagree and
 * the one on screen would not be the one that ran.
 */

/**
 * The Whisper model ladder. An upload only ever upgrades to an equal-or-higher
 * rank, and anything below `CHAMPION` is what the next local GPU run redoes.
 *
 * 'large-v3-split' (6) = local champion pipeline (Demucs vocals + large-v3
 * transcribe + qwen3.5 translate); outranks plain 'large-v3' so it auto-upgrades
 * existing entries.
 *
 * **This is the one TypeScript copy.** `routes/translate.ts` imports it from
 * here rather than declaring its own. Two Python copies remain and must be kept
 * in sync by hand - `backend/scripts/batch_translate.py` and
 * `tools/local_translate.py`; a missing `large-v3-split` in either makes that
 * path treat champion output as rank 0 and reprocess it for nothing.
 */
export const MODEL_RANK: Record<string, number> = {
  tiny: 0,
  base: 1,
  small: 2,
  medium: 3,
  'large-v2': 4,
  'large-v3': 5,
  'large-v3-split': 6,
};

/** The best pipeline we have. Everything below it is pending rework. */
export const CHAMPION = 'large-v3-split';

/**
 * Rank of a model name, with **0 for anything unrecognised**.
 *
 * Deliberately not `NaN` or `undefined`: every comparison against NaN is false,
 * so an unknown model would quietly report as already-at-champion and never be
 * re-translated. Unknown means "worse than everything we know", which is also
 * what the upload path already assumes.
 */
export function modelRank(name: string | null | undefined): number {
  if (!name) return 0;
  return MODEL_RANK[name] ?? 0;
}

/** Would the next champion run redo this? */
export function isBelowChampion(name: string | null | undefined): boolean {
  return modelRank(name) < MODEL_RANK[CHAMPION];
}

/**
 * One state per trailer. See `rowState` for the precedence when several apply.
 */
export type SubtitleState =
  | 'never'
  | 'checkedNoSubs'
  | 'translated'
  | 'youtubeCc'
  | 'burnedIn'
  | 'ourSubsOff';

export const SUBTITLE_STATES: SubtitleState[] = [
  'never',
  'checkedNoSubs',
  'translated',
  'youtubeCc',
  'burnedIn',
  'ourSubsOff',
];

/** The `SubtitleCache` columns this report reads, already coerced out of SQLite. */
export interface SubtitleRow {
  videoId: string;
  modelName: string | null;
  hasEnglishSubs: boolean | null;
  hasBurnedInSubs: boolean | null;
  subtitlesDisabled: boolean | null;
  /** null = no cached segments at all. 0 = a stored but empty translation. */
  segmentCount: number | null;
  lastEnCheckAt: string | null;
  createdAt: string | null;
}

/** The `SeasonCache` entry fields this report reads. Everything else is ignored. */
export interface SeasonEntry {
  id: number;
  title?: { english?: string | null; romaji?: string | null; native?: string | null } | null;
  format?: string | null;
  isAdult?: boolean | null;
  coverImage?: { medium?: string | null } | null;
  trailer?: { id?: string | null; site?: string | null } | null;
}

export interface SeasonInput {
  season: string;
  year: number;
  /**
   * Was there a `SeasonCache` row at all? **Not** "were there entries".
   * A cached-but-empty season (SUMMER 2027 was one) means "we asked and there is
   * nothing yet"; no row means we never asked. The page must never render the
   * second as zero work.
   */
  cached: boolean;
  entries: SeasonEntry[];
}

export interface SubtitleReportRow {
  mediaId: number;
  title: string;
  cover: string | null;
  videoId: string;
  season: string;
  year: number;
  format: string | null;
  isAdult: boolean;
  state: SubtitleState;
  modelName: string | null;
  belowChampion: boolean;
  segmentCount: number | null;
  hasEnglishSubs: boolean | null;
  lastEnCheckAt: string | null;
  hasBurnedInSubs: boolean;
  subtitlesDisabled: boolean;
  createdAt: string | null;
}

export interface SubtitleSeasonSummary {
  season: string;
  year: number;
  cached: boolean;
  /** Every entry in the cached season, trailer or not. */
  entries: number;
  /** Of those, the ones with a YouTube trailer - the only ones this pipeline can touch. */
  withTrailer: number;
  counts: Record<SubtitleState, number>;
  /** Translated, but by a model the next champion run would redo. */
  belowChampion: number;
}

export interface SubtitleReport {
  seasons: SubtitleSeasonSummary[];
  rows: SubtitleReportRow[];
}

/**
 * Which single state describes this trailer.
 *
 * **Precedence, highest first, and the order is the point** - several of these
 * are true at once on plenty of rows:
 *
 *   ourSubsOff > burnedIn > youtubeCc > translated > checkedNoSubs > never
 *
 * - `ourSubsOff` wins because it is a human's stated decision about this video,
 *   and it applies to every viewer.
 * - `burnedIn` above `youtubeCc` because hardsubs are the stronger fact: the
 *   overlay defaults off for them regardless of what YouTube also offers.
 * - `youtubeCc` above `translated` because CC is *why* the pipeline skips a
 *   video. Ranking our own segments first would report a trailer that never
 *   needed us as work we did, and - worse in the other direction - a CC video
 *   with no segments would read as backlog and get re-translated for nothing.
 *
 * **`never` is about evidence, not about whether a row exists.** `PATCH
 * /dismiss` upserts, so toggling our subtitles on a never-checked trailer
 * creates a row carrying nothing but that toggle - and `/admin/subtitles`'
 * own button is the fastest way to make one. Calling that "checked, no YouTube
 * CC" would claim work nobody did. A null `hasEnglishSubs` means the English-CC
 * check has no verdict, which is exactly "never looked".
 */
export function rowState(row: SubtitleRow | null | undefined): SubtitleState {
  if (!row) return 'never';
  if (row.subtitlesDisabled) return 'ourSubsOff';
  if (row.hasBurnedInSubs) return 'burnedIn';
  if (row.hasEnglishSubs) return 'youtubeCc';
  if (row.segmentCount !== null && row.segmentCount > 0) return 'translated';
  if (row.hasEnglishSubs === null || row.hasEnglishSubs === undefined) return 'never';
  return 'checkedNoSubs';
}

/**
 * Sort bucket: the two states a human can act on, then work the next run will
 * redo, then everything settled.
 *
 * Burying the actionable rows under a hundred settled ones is how a stalled
 * batch goes unnoticed for a whole season - the same reason `/admin/sonarr`
 * lists its failures first.
 */
function sortBucket(row: SubtitleReportRow): number {
  if (row.state === 'never') return 0;
  if (row.state === 'checkedNoSubs') return 1;
  if (row.state === 'translated' && row.belowChampion) return 2;
  return 3;
}

/** English, then romaji, then native - never an empty cell. */
function displayTitle(entry: SeasonEntry): string {
  const t = entry.title ?? {};
  return t.english || t.romaji || t.native || `#${entry.id}`;
}

/** The YouTube id of an entry's trailer, or null if there is nothing to translate. */
function youtubeTrailerId(entry: SeasonEntry): string | null {
  const tr = entry.trailer;
  if (!tr || tr.site !== 'youtube' || !tr.id) return null;
  return tr.id;
}

function emptyCounts(): Record<SubtitleState, number> {
  return { never: 0, checkedNoSubs: 0, translated: 0, youtubeCc: 0, burnedIn: 0, ourSubsOff: 0 };
}

/**
 * Join cached seasons against the subtitle cache.
 *
 * Season order is preserved - the route passes [current, next] and the page
 * groups by season, so reordering here would silently reshuffle the page.
 */
export function buildSubtitleReport(
  seasons: SeasonInput[],
  cacheByVideoId: Map<string, SubtitleRow>
): SubtitleReport {
  const summaries: SubtitleSeasonSummary[] = [];
  const rows: SubtitleReportRow[] = [];

  for (const s of seasons) {
    const counts = emptyCounts();
    let withTrailer = 0;
    let belowChampion = 0;
    const seasonRows: SubtitleReportRow[] = [];

    for (const entry of s.entries) {
      const videoId = youtubeTrailerId(entry);
      if (!videoId) continue;
      withTrailer++;

      const cache = cacheByVideoId.get(videoId) ?? null;
      const state = rowState(cache);
      counts[state]++;

      // Asks "is there a stored translation a better model would redo", which is
      // independent of which badge won the precedence contest above. The local
      // GPU run decides on cached segments and model rank alone
      // (`check_server_cache`, tools/local_translate.py) and never consults
      // hasEnglishSubs - so a `youtubeCc` row holding an old `medium` translation
      // is still a re-do candidate. Gating this on `state === 'translated'` made
      // the per-season totals disagree with the overall figure.
      const hasSegments = cache?.segmentCount != null && cache.segmentCount > 0;
      const below = hasSegments && isBelowChampion(cache?.modelName);
      if (below) belowChampion++;

      seasonRows.push({
        mediaId: entry.id,
        title: displayTitle(entry),
        cover: entry.coverImage?.medium ?? null,
        videoId,
        season: s.season,
        year: s.year,
        format: entry.format ?? null,
        isAdult: !!entry.isAdult,
        state,
        modelName: cache?.modelName ?? null,
        belowChampion: below,
        segmentCount: cache?.segmentCount ?? null,
        hasEnglishSubs: cache?.hasEnglishSubs ?? null,
        lastEnCheckAt: cache?.lastEnCheckAt ?? null,
        hasBurnedInSubs: !!cache?.hasBurnedInSubs,
        subtitlesDisabled: !!cache?.subtitlesDisabled,
        createdAt: cache?.createdAt ?? null,
      });
    }

    seasonRows.sort(
      (a, b) => sortBucket(a) - sortBucket(b) || a.title.localeCompare(b.title)
    );
    rows.push(...seasonRows);

    summaries.push({
      season: s.season,
      year: s.year,
      cached: s.cached,
      entries: s.entries.length,
      withTrailer,
      counts,
      belowChampion,
    });
  }

  return { seasons: summaries, rows };
}
