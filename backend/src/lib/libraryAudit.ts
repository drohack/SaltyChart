// ---------------------------------------------------------------------------
// Does each episode we added have English subtitles, and does Jellyfin know
// about the file Sonarr has now?
//
// Pure and I/O-free, like `sonarrPush.ts`: `libraryCheck.ts` does the talking,
// and every rule below is unit-tested without a server.
//
// **Two sources, and why Jellyfin is the primary one.** Both publish languages:
// Sonarr's `episodeFile.mediaInfo.subtitles` is a `/`-separated list of codes
// (`eng/ara/ger`), Jellyfin's MediaStreams carry the same codes PLUS each
// track's title and `IsForced`. The extra detail is the whole difference:
// measured over 82 of our series on 2026-10-09, **15 files carried only a
// `Forced` / `Forced (Signs only)` English track** - signs for a dub, not
// dialogue - and Sonarr's codes call every one of them subbed. Sonarr stays the
// fallback for a series Jellyfin cannot be matched to (17 of 82 that day).
//
// **Staleness is a FILE-NAME question, never an episode-number one.** The first
// version compared episode by episode and reported dozens of false "stale"
// series: a multi-episode file (`S01E07-08`) is one Jellyfin item numbered 7,
// and numbering differs between the two whenever their orderings do. With the
// rule "is Sonarr's current file among Jellyfin's paths for this series", the
// same 69 recently-imported series measured zero stale - which was the truth,
// since the library scan had just run.
// ---------------------------------------------------------------------------

/** What one episode offers an English speaker. */
export type SubState =
  /** A full English subtitle track - dialogue, not just signs. */
  | 'fullEng'
  /** English subtitles exist, but only signs/songs (a forced track for a dub). */
  | 'signsOnly'
  /** No English subtitles, but English audio - watchable, just not subbed. */
  | 'engAudio'
  /** Neither. A raw. */
  | 'none'
  /** Nothing has analysed the file yet. Never counted as subbed. */
  | 'unknown';

export interface JellyfinStream {
  type: string;
  language?: string | null;
  title?: string | null;
  displayTitle?: string | null;
  isForced?: boolean | null;
}

export interface JellyfinEpisodeLite {
  path: string;
  streams: JellyfinStream[];
}

export interface SonarrFileLite {
  path: string;
  releaseGroup: string | null;
  quality: string | null;
  /** `null` when Sonarr has not analysed the file - distinct from `''`, "no tracks". */
  audioLanguages: string | null;
  subtitles: string | null;
}

export interface SonarrEpisodeLite {
  seasonNumber: number;
  episodeNumber: number;
  title: string;
  file: SonarrFileLite | null;
}

/**
 * The last path segment, for either separator.
 *
 * Sonarr and Jellyfin mount the same share at different roots here
 * (`/media/Anime` vs `/data/anime`, and the case differs), so a full-path
 * comparison could never match. The file name is what both agree on, because
 * Sonarr chose it.
 */
export function fileName(path: string | null | undefined): string {
  if (!path) return '';
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}

const isEnglishCode = (code: string | null | undefined) => /^en(g|glish)?$/i.test((code ?? '').trim());

/**
 * Is this English subtitle track only signs and songs?
 *
 * **`IsForced` is NOT decisive, and that was measured, not guessed.** SKYANiME
 * releases (Crunchyroll rips, Japanese audio only) flag their single English
 * track forced - and it is full dialogue: Iron Wok Jan S01E06's has 346
 * dialogue lines, the same as the Arabic track beside it; My Awkward Senpai
 * S01E01's has 304 (2026-10-09). Trusting the flag called 11 fully subbed
 * episodes "signs only". A forced track IS signs-only in a dual-audio file,
 * where it carries the signs for the dub - so the flag counts only when the
 * file has English audio.
 *
 * Only the track's own `title` is read for keywords, never `displayTitle`:
 * Jellyfin appends "Forced" to the display title of every flagged track, which
 * would smuggle the flag back in. A title naming signs AND dialogue is a full
 * track - CicakRumah ships `English [Dialogue, Signs & Song (CicakRumah)]`.
 */
export function isSignsOnly(s: JellyfinStream, fileHasEnglishAudio: boolean): boolean {
  const title = s.title ?? '';
  if (/sign|song|forced/i.test(title) && !/dialog|full/i.test(title)) return true;
  return !!s.isForced && fileHasEnglishAudio;
}

/** Jellyfin's view of one episode: titles and flags included. */
export function classifyJellyfin(streams: JellyfinStream[]): SubState {
  // A probed file always has at least a video stream; none at all means
  // Jellyfin has not looked yet, which is not the same as "no subtitles".
  if (!streams.length) return 'unknown';
  const englishAudio = streams.some((s) => s.type === 'Audio' && isEnglishCode(s.language));
  const english = streams.filter(
    (s) =>
      s.type === 'Subtitle' &&
      (isEnglishCode(s.language) || /english/i.test(`${s.title ?? ''} ${s.displayTitle ?? ''}`))
  );
  if (english.some((s) => !isSignsOnly(s, englishAudio))) return 'fullEng';
  if (english.length) return 'signsOnly';
  if (englishAudio) return 'engAudio';
  return 'none';
}

/**
 * Sonarr's view: codes only, so a signs-only track reads as `fullEng`.
 * Used only where Jellyfin cannot be matched, and labelled as such on screen.
 */
export function classifySonarr(file: SonarrFileLite): SubState {
  if (file.subtitles == null && file.audioLanguages == null) return 'unknown';
  const codes = (raw: string | null) => (raw ?? '').split('/').map((c) => c.trim()).filter(Boolean);
  if (codes(file.subtitles).some(isEnglishCode)) return 'fullEng';
  if (codes(file.audioLanguages).some(isEnglishCode)) return 'engAudio';
  return 'none';
}

/**
 * Does the file carry an English audio track - a dub?
 *
 * Separate from `SubState` on purpose: a dual-audio release with full English
 * subtitles classifies `fullEng`, and the dub would vanish into that verdict.
 * The admin page shows subtitles and dubs as two columns.
 */
export function hasEnglishAudio(jellyfinStreams: JellyfinStream[] | null, sonarrFile: SonarrFileLite): boolean {
  if (jellyfinStreams && jellyfinStreams.length) {
    return jellyfinStreams.some((s) => s.type === 'Audio' && isEnglishCode(s.language));
  }
  return (sonarrFile.audioLanguages ?? '').split('/').some((c) => isEnglishCode(c));
}

/** States a viewer who wants subtitles cannot use. `engAudio` is not one: it plays in English. */
export const MISSING_STATES: ReadonlySet<SubState> = new Set<SubState>(['none', 'signsOnly']);

export interface ProblemEpisode {
  season: number;
  episode: number;
  title: string;
  sub: SubState;
  /** Jellyfin still points at a file Sonarr has since replaced or added. */
  stale: boolean;
  releaseGroup: string | null;
  quality: string | null;
  audio: string | null;
}

export type SeriesState = 'stale' | 'missing' | 'unknown' | 'allSubbed';

export interface SeriesAudit {
  /** Where the subtitle verdicts came from. `sonarr` cannot see signs-only tracks. */
  source: 'jellyfin' | 'sonarr';
  episodes: number;
  counts: Record<SubState, number>;
  /** Episodes whose file carries English audio, whatever their subtitles. */
  dubbed: number;
  stale: number;
  state: SeriesState;
  /** Every episode that is not plainly fine, in season/episode order. */
  problems: ProblemEpisode[];
}

/**
 * One series, both sources joined by file name.
 *
 * `jellyfin` is null when the series could not be matched in Jellyfin at all -
 * then Sonarr's codes decide and nothing can be called stale, because there is
 * nothing to compare against.
 *
 * An episode Jellyfin is stale on is classified from SONARR's record of the new
 * file: Jellyfin is describing a file that no longer exists, and the question
 * is what the viewer will get once it catches up.
 */
export function auditSeries(
  sonarrEpisodes: SonarrEpisodeLite[],
  jellyfin: JellyfinEpisodeLite[] | null
): SeriesAudit {
  const byName = new Map<string, JellyfinEpisodeLite>();
  for (const e of jellyfin ?? []) {
    const n = fileName(e.path);
    if (n) byName.set(n, e);
  }

  const counts: Record<SubState, number> = { fullEng: 0, signsOnly: 0, engAudio: 0, none: 0, unknown: 0 };
  const problems: ProblemEpisode[] = [];
  let episodes = 0;
  let stale = 0;
  let dubbed = 0;

  const sorted = sonarrEpisodes
    .filter((e) => e.file)
    .sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber);
  for (const e of sorted) {
    const file = e.file!;
    episodes++;
    const jf = jellyfin ? byName.get(fileName(file.path)) : undefined;
    const isStale = !!jellyfin && !jf;
    const sub = jf ? classifyJellyfin(jf.streams) : classifySonarr(file);
    counts[sub]++;
    // Read from the same file the subtitle verdict was: Jellyfin's when it is
    // current, Sonarr's record of the new file when Jellyfin is stale.
    if (hasEnglishAudio(jf ? jf.streams : null, file)) dubbed++;
    if (isStale) stale++;
    if (isStale || sub !== 'fullEng') {
      problems.push({
        season: e.seasonNumber,
        episode: e.episodeNumber,
        title: e.title,
        sub,
        stale: isStale,
        releaseGroup: file.releaseGroup,
        quality: file.quality,
        audio: file.audioLanguages,
      });
    }
  }

  // Precedence is "what can someone act on first". Stale comes before missing
  // because it is fixed by a button here, and a stale episode's subtitle verdict
  // is about a file Jellyfin has not even read yet.
  const missing = counts.none + counts.signsOnly;
  const state: SeriesState = stale
    ? 'stale'
    : missing
      ? 'missing'
      : counts.unknown
        ? 'unknown'
        : 'allSubbed';

  return { source: jellyfin ? 'jellyfin' : 'sonarr', episodes, counts, dubbed, stale, state, problems };
}

/**
 * The single "English" cell on /admin/sonarr: what the series offers, and
 * whether every episode on disk has it.
 *
 * `ok` = every episode has full English subtitles or English audio. The label
 * says which (`subs`, `dub`, `subs + dub`) and, when only some episodes do, how
 * many (`subs 10/12`); `no English` when none do. A signs-only track is not
 * English, and neither is an episode nobody has analysed yet.
 */
export function englishSummary(a: SeriesAudit): { label: string; ok: boolean } {
  const watchable = a.counts.fullEng + a.counts.engAudio;
  const parts = [a.counts.fullEng > 0 ? 'subs' : '', a.dubbed > 0 ? 'dub' : ''].filter(Boolean);
  const ok = a.episodes > 0 && watchable === a.episodes;
  if (!parts.length) return { label: 'no English', ok: false };
  const label = parts.join(' + ');
  return { label: ok ? label : `${label} ${watchable}/${a.episodes}`, ok };
}

const STATE_ORDER: Record<SeriesState | 'error', number> = {
  stale: 0,
  missing: 1,
  error: 2,
  unknown: 3,
  allSubbed: 4,
};

/** Problem-first, then by title - the order the admin page renders. */
export function compareRows(
  a: { state: SeriesState | 'error'; title: string },
  b: { state: SeriesState | 'error'; title: string }
): number {
  return STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.title.localeCompare(b.title);
}
