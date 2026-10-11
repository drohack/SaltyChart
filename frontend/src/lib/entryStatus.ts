/**
 * Presentation for the status vocabulary decided in
 * `backend/src/lib/entryStatus.ts`.
 *
 * **Nothing here decides a status.** The server sends `level`, `code` and the
 * sentence; this maps them to colours and short labels so /admin/sonarr and
 * /admin/matching look identical for the same show. The one rule that lives
 * on both sides, `needsAttention`, is two booleans and mirrors the server's.
 *
 * Colour means result, never format: red is "can't work until someone acts",
 * yellow "probably fine, nothing verified it", blue "not aired yet",
 * green "nothing to do".
 */

export type Level = 'broken' | 'check' | 'waiting' | 'ok';

export interface Finding {
  level: Level;
  code: string;
  text: string;
}

export interface EntryStatus extends Finding {
  also?: Finding[];
}

export const LEVELS: Level[] = ['broken', 'check', 'waiting', 'ok'];

export const LEVEL: Record<Level, { label: string; badge: string; text: string; order: number; legend: string }> = {
  broken: { label: 'Broken', badge: 'badge-error', text: 'text-error', order: 0, legend: "can't work until someone acts" },
  check: { label: 'Check', badge: 'badge-warning', text: 'text-warning', order: 1, legend: 'probably fine, nothing verified it' },
  waiting: { label: 'Waiting', badge: 'badge-info', text: 'text-info', order: 2, legend: 'not aired yet - nothing to do yet' },
  ok: { label: 'OK', badge: 'badge-success', text: 'text-success', order: 3, legend: 'nothing to do' },
};

/** The badge's words: what happened, short. The sentence says why. */
export const CODE_LABEL: Record<string, string> = {
  noId: 'no id',
  sonarrRejected: 'Sonarr rejected',
  addFailed: 'add failed',
  noTvdbId: 'no TVDB id',
  noVideo: 'no video',
  notInJellyfin: 'not in Jellyfin',
  notInLibrary: 'not in library',
  noEnglish: 'no English',
  someNoEnglish: 'some no English',
  guess: 'guess',
  ambiguous: 'ambiguous',
  titleOnly: 'title only',
  unconfirmedAuto: 'unconfirmed',
  viewerPick: 'viewer pick',
  duplicateTvdbId: 'duplicate id',
  unverifiedListed: 'unverified',
  unverifiedMatch: 'not verified',
  sonarrUnread: 'Sonarr unread',
  noTitle: 'no title',
  noAnilistId: 'no AniList id',
  joinsList: 'waiting',
  willBeAdded: 'will be added',
  pushedAlready: 'added by us',
  addedByUs: 'added by us',
  heldAlready: 'already held',
  excludedInSonarr: 'excluded',
  skipped: 'not auto-added',
  matched: 'matched',
  rejectedByHand: 'rejected',
};

/** Headings for Needs attention groups on /admin/matching, worst first. */
export const CODE_HEADING: Record<string, string> = {
  noId: 'No id found',
  sonarrRejected: 'Sonarr rejected the id',
  addFailed: 'Sonarr add failed',
  noTvdbId: 'Only a TMDB id - Sonarr needs TVDB',
  noVideo: 'Aired, no video yet',
  notInJellyfin: 'Sonarr has it, Jellyfin does not',
  notInLibrary: 'Aired, not in the library',
  noEnglish: 'No English on episode 1',
  guess: 'Auto-search guess',
  ambiguous: 'Several possible matches',
  titleOnly: 'Title-only match',
  unconfirmedAuto: 'Unconfirmed auto-match',
  viewerPick: 'Viewer pick',
  duplicateTvdbId: 'Duplicate TVDB id',
  unverifiedListed: 'Listed, match unverified',
  unverifiedMatch: 'Waiting for the match to be verified',
  someNoEnglish: 'Some episodes without English',
  sonarrUnread: 'Sonarr not read yet',
};

export function codeLabel(code: string): string {
  return CODE_LABEL[code] ?? code;
}

/** The one rule both pages use: something wants it, and it is red or yellow. */
export function needsAttention(row: { status: { level: Level }; wanted?: boolean | null }): boolean {
  // `wanted` unknown (no Sonarr report) counts as wanted, so an outage can
  // never hide a problem.
  return row.wanted !== false && (row.status.level === 'broken' || row.status.level === 'check');
}

export function byLevel(a: { status: { level: Level } }, b: { status: { level: Level } }): number {
  return LEVEL[a.status.level].order - LEVEL[b.status.level].order;
}

/** The chip filters both pages offer. */
export type Chip = 'attention' | Level | 'all';

export function chipMatches(chip: Chip, row: { status: { level: Level }; wanted?: boolean | null }): boolean {
  if (chip === 'all') return true;
  if (chip === 'attention') return needsAttention(row);
  return row.status.level === chip;
}
