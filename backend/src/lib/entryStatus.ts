import type { MatchGrade } from './seriesIdentity';

// ---------------------------------------------------------------------------
// One status per AniList entry, for /admin/sonarr and /admin/matching alike.
//
// Pure and I/O-free: callers gather the facts (identity, push record, the
// Sonarr snapshot, the Jellyfin verdict Randomize uses) and this decides what
// they mean. Both pages render the result and neither recomputes it - two
// copies of "what is wrong with this show" is how the pages came to disagree
// (7 hidden on Randomize against 1 + 2 + 1 on /admin/sonarr, 2026-10-10).
//
// **Colour means result, never format.** A film with no id is as red as a TV
// show with no id. Whether a problem is worth anyone's attention is a separate
// question - `wanted` - so a skipped sequel keeps its colour but stays out of
// Needs attention until someone lists or Includes it.
// ---------------------------------------------------------------------------

export type Level = 'broken' | 'check' | 'waiting' | 'ok';

export interface Finding {
  level: Level;
  code: string;
  text: string;
}

export interface EntryStatus extends Finding {
  /** Every other finding that is not `ok`, so a row can show both reasons. */
  also?: Finding[];
}

/**
 * Display severity. `waiting` outranks `ok` so an unaired show reads as
 * "not yet" rather than as settled; it never outranks a real problem.
 */
const SEVERITY: Record<Level, number> = { broken: 3, check: 2, waiting: 1, ok: 0 };

const DAY_MS = 86_400_000;

/** Partial AniList dates read as the earliest day they could mean. */
export function anilistMs(d?: { year?: number | null; month?: number | null; day?: number | null } | null): number | null {
  if (!d?.year) return null;
  return Date.UTC(d.year, (d.month ?? 1) - 1, d.day ?? 1);
}

/**
 * Has this entry not started airing?
 *
 * **Mirrors `isUnaired` in frontend/src/stores/jellyfin.ts exactly**, because
 * Randomize never asks the library about an unaired show (`notAired`) and the
 * 1:1 with Hide Not English depends on both sides drawing that line in the same
 * place: status is authoritative when present, otherwise the earliest day the
 * (possibly partial) start date could mean.
 */
export function isUnaired(
  entry: { status?: string | null; startDate?: { year?: number | null; month?: number | null; day?: number | null } | null },
  now: number
): boolean {
  if (entry.status) return entry.status === 'NOT_YET_RELEASED';
  const ms = anilistMs(entry.startDate);
  return ms != null && ms > now;
}

/** "Oct 3" - short, and in UTC so a premiere day never shifts by a timezone. */
export function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// ---------------------------------------------------------------------------
// Identity: do we know which real series this is?
// ---------------------------------------------------------------------------

export interface IdentityFacts {
  grade: MatchGrade;
  confirmed: boolean;
  rejected: boolean;
  pending: boolean;
  /** Carries a TVDB or a TMDB id. */
  hasId: boolean;
  note: string | null;
  /** Did the library match it on title text alone (`matchedBy: 'title'`)? */
  titleOnly?: boolean;
  /** 1 = prefix, the weakest title tier. */
  titleTier?: number | null;
  candidates?: Array<{ matchedTitle?: string | null; premiereDate?: string | null; year?: number | null }> | null;
  matchedTitle?: string | null;
  settledByDate?: boolean;
  startDateMs?: number | null;
  year?: number | null;
}

/**
 * Why a suggestion could not be verified, in the terms a reviewer judges it on:
 * how far the match's own premiere is from this entry's. Says nothing it has no
 * evidence for rather than inventing a reason.
 */
export function unverifiedBecause(f: IdentityFacts): string {
  const chosen = (f.candidates ?? []).find((c) => c.matchedTitle === f.matchedTitle);
  const prem = chosen?.premiereDate;
  if (prem && f.startDateMs != null) {
    const days = Math.round(Math.abs(Date.parse(prem) - f.startDateMs) / DAY_MS);
    if (Number.isFinite(days)) {
      return `nothing could verify it - the match premiered ${prem}, ${days.toLocaleString('en-US')} days off`;
    }
  }
  const y = chosen?.year ?? f.year;
  const mine = f.startDateMs != null ? new Date(f.startDateMs).getUTCFullYear() : null;
  if (y && mine && y !== mine) return `nothing could verify it - the match is from ${y}, this premieres ${mine}`;
  return 'nothing could verify it - no date to check against';
}

/**
 * The identity half. The order is the order a reviewer would ask: has a human
 * decided, has a viewer contradicted the matcher, is it a guess, is it
 * ambiguous, is there anything at all, and how good is what we have.
 */
export function identityStatus(f: IdentityFacts): Finding {
  if (f.rejected) return { level: 'ok', code: 'rejectedByHand', text: 'Marked not-in-library by hand' };
  if (f.confirmed) return { level: 'ok', code: 'matched', text: 'Human-confirmed match' };
  if (f.grade === 'viewerPick') {
    return { level: 'check', code: 'viewerPick', text: `A viewer picked this from the Watch pop-up - ${(f.note ?? '').replace(/^viewer:\s*/, '')}` };
  }
  if (f.hasId && f.pending) {
    return { level: 'check', code: 'guess', text: `Auto-search guess, ${unverifiedBecause(f)}` };
  }
  const options = f.candidates?.length ?? 0;
  if (options > 1 && !f.settledByDate) {
    return { level: 'check', code: 'ambiguous', text: `${options} possible matches and the premiere date can't separate them` };
  }
  if (!f.hasId) {
    if (f.titleOnly) {
      return {
        level: 'check', code: 'titleOnly',
        text: f.titleTier === 1 ? 'Matched on a title prefix only - no id to verify it' : 'Matched on title only - no id to verify it',
      };
    }
    return {
      level: 'broken', code: 'noId',
      text: f.pending ? 'No TVDB or TMDB id - the auto-search found nothing' : 'No TVDB or TMDB id, and no title match',
    };
  }
  const rung = (f.note ?? '').replace(/^remote:\s*/, '');
  switch (f.grade) {
    case 'adminOverride':
      return { level: 'ok', code: 'matched', text: 'Manual id' };
    case 'map':
      return { level: 'ok', code: 'matched', text: rung && (f.note ?? '').startsWith('remote:') ? 'Auto-match the community map agrees with' : 'Community-map id' };
    case 'dateVerified':
      return { level: 'ok', code: 'matched', text: `Auto-match, ${rung} off - verified by date` };
    case 'weak':
      // Accepted on title text or a +/-1 release year: probably right, and the
      // class that once offered Echo a namesake 1,012 days from its premiere.
      if (rung.startsWith('release year')) {
        return { level: 'check', code: 'unconfirmedAuto', text: `Auto-match on release year ${rung.replace('release year ', '')} - no date confirmed it` };
      }
      if (rung.startsWith('exact title')) {
        return { level: 'check', code: 'unconfirmedAuto', text: 'Auto-match on exact title - no date confirmed it' };
      }
      return { level: 'check', code: 'unconfirmedAuto', text: `Auto-match, ${unverifiedBecause(f)}` };
    default:
      return { level: 'ok', code: 'matched', text: 'Matched' };
  }
}

// ---------------------------------------------------------------------------
// Scope: does anything want this show?
// ---------------------------------------------------------------------------

/**
 * Rejections that happen AFTER every rule gate. An entry dropped by one of these
 * passed format, adult, sequel and air window (or was forced past them), so it
 * is a show we are trying to have and a problem on it needs attention.
 */
const WANTED_REASONS = new Set([
  'outsideAirWindow',
  'noAnilistId',
  'noUsableTvdbId',
  'unverifiedMatch',
  'unverifiedNotAcknowledged',
  'duplicateTvdbId',
  'noTitle',
]);

/**
 * Is this a show we are trying to have? The same set that makes Sonarr add it:
 * it passes the auto-add rules, or a trusted user listed it, or someone pressed
 * Include. A show an admin marked not-in-library is never wanted.
 */
export function isWanted(f: {
  proposed: boolean;
  rejectedReason?: string | null;
  forced?: boolean;
  listedBy?: number;
  identityRejected?: boolean;
}): boolean {
  if (f.identityRejected) return false;
  if (f.proposed || f.forced || (f.listedBy ?? 0) > 0) return true;
  return !!f.rejectedReason && WANTED_REASONS.has(f.rejectedReason);
}

/** Why a rule left it off, for the "Not auto-added" section. */
export function skipReasonText(reason: string, parent?: { held: boolean } | null): string | null {
  switch (reason) {
    case 'format': return 'Not auto-added: not TV / TV Short';
    case 'adult': return 'Not auto-added: adult';
    case 'notFirstSeason':
      return parent
        ? `Not auto-added: a sequel - ${parent.held ? 'you have the previous season' : "you don't have the previous season"}`
        : 'Not auto-added: a sequel';
    case 'malformed': return 'Not auto-added: unreadable cache row';
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// Sonarr and the library: will it be (or is it) watchable?
// ---------------------------------------------------------------------------

/** The Jellyfin verdict Randomize reads, trimmed to what this needs. */
export interface Availability {
  available: boolean;
  unknown?: boolean;
  english?: string | null;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  matchedBy?: string | null;
}

export interface SonarrFacts {
  wanted: boolean;
  /** `state` of a proposed row (`willBeAdded`, `pushedAlready`, ...). */
  proposedState?: string | null;
  rejectedReason?: string | null;
  /** The push record for this entry, open failures only matter. */
  push?: { status: string; tvdbId: number; lastError: string | null; superseded: boolean } | null;
  /** Usable TVDB id, when the entry has one. */
  tvdbId?: number | null;
  /** Sonarr holds the series (last snapshot); null when no snapshot can say. */
  sonarrHeld?: boolean | null;
  /** Episode files Sonarr holds for it; null when not recorded. */
  sonarrFiles?: number | null;
  /** Jellyfin carries that series (library check); null when unknown. */
  inJellyfin?: boolean | null;
  /** The Jellyfin verdict for the episode Randomize plays; absent when not asked (unaired). */
  availability?: Availability | null;
  /** The library check's English cell for the series. */
  english?: { label: string; ok: boolean } | null;
  unaired: boolean;
  startMs: number | null;
  /** Joins the auto-add list on this day (`outsideAirWindow`). */
  joinsMs?: number | null;
  skipReason?: string | null;
}

const OUTCOME: Record<string, string> = {
  willBeAdded: 'Will be added on the next push',
  pushedAlready: 'Added by us',
  addedByUs: 'Added by us',
  heldAlready: 'Already in Sonarr',
  excludedInSonarr: 'Excluded in Sonarr (your choice)',
};

/**
 * The Sonarr and library half. Returns every finding, worst first decided by
 * `combine`; an entry can be both "added by us" and "episode 1 has no English".
 *
 * **Not in library is decided by the same Jellyfin verdict Randomize uses**, so
 * a show Randomize's Hide Not English would hide is broken here too - the 1:1 is
 * by construction. The Sonarr facts only explain WHY it is missing.
 */
export function sonarrFindings(f: SonarrFacts, identity: Finding): Finding[] {
  const out: Finding[] = [];
  // A Sonarr-side failure on a show the library already plays in English is a
  // loose end, not an outage - yellow, so red keeps meaning "Randomize hides it".
  const sonarrLevel: Level = watchable(f) === true ? 'check' : 'broken';
  const open = f.push && !f.push.superseded ? f.push : null;
  if (open?.status === 'lookupFailed') {
    out.push({ level: sonarrLevel, code: 'sonarrRejected', text: `Sonarr rejected tvdb ${open.tvdbId}${open.lastError ? `: ${open.lastError}` : ''} - fix the match` });
  } else if (open?.status === 'failed') {
    out.push({ level: sonarrLevel, code: 'addFailed', text: `Sonarr add failed${open.lastError ? `: ${open.lastError}` : ''}` });
  }

  const reason = f.rejectedReason ?? null;
  if (reason === 'outsideAirWindow') {
    out.push({
      level: 'waiting', code: 'joinsList',
      text: f.joinsMs != null ? `Joins the list ${shortDate(f.joinsMs)}` : 'Joins the list once it has a premiere date',
    });
  } else if (reason === 'unverifiedMatch') {
    out.push({ level: 'check', code: 'unverifiedMatch', text: 'Not added to Sonarr until the match is verified - by a premiere date, or Confirm on Matching' });
  } else if (reason === 'unverifiedNotAcknowledged') {
    out.push({ level: 'check', code: 'unverifiedListed', text: 'Listed, but the match is unverified - confirm it on Matching before it is added' });
  } else if (reason === 'duplicateTvdbId') {
    out.push({ level: 'check', code: 'duplicateTvdbId', text: `Shares tvdb ${f.tvdbId ?? '?'} with another entry - only one is added` });
  } else if (reason === 'noUsableTvdbId' && identity.level === 'ok') {
    // The identity is fine but has no TVDB id - a TMDB-only match. Sonarr is TV
    // and keyed on TVDB, so it cannot add it.
    out.push({ level: sonarrLevel, code: 'noTvdbId', text: 'Matched, but only to a TMDB id - Sonarr needs a TVDB id' });
  } else if (reason === 'noTitle' || reason === 'noAnilistId') {
    out.push({ level: 'check', code: reason, text: reason === 'noTitle' ? 'AniList has no usable title for it' : 'No usable AniList id' });
  } else if (f.skipReason) {
    out.push({ level: 'ok', code: 'skipped', text: f.skipReason });
  } else if (f.proposedState === 'unknown') {
    out.push({ level: 'check', code: 'sonarrUnread', text: "Sonarr hasn't been read yet - press Re-read Sonarr" });
  } else if (f.proposedState && OUTCOME[f.proposedState]) {
    out.push({ level: 'ok', code: f.proposedState, text: OUTCOME[f.proposedState] });
  }

  // Watchable? Only an aired show can be, and only a definite verdict counts -
  // `unknown` is "couldn't ask", never "missing".
  const av = f.availability;
  if (!f.unaired && av && !av.unknown) {
    if (!av.available) {
      // Randomize hides this as not in the library. Say why, most specific first;
      // a push failure or a missing id already explains it.
      const explained = !!open || identity.level === 'broken' || out.some((x) => x.code === 'noTvdbId');
      if (!explained) {
        const aired = f.startMs != null ? `Aired ${shortDate(f.startMs)}` : 'Aired';
        if (f.wanted && (f.sonarrHeld === false || f.sonarrFiles === 0)) {
          // One add per series: a show we added and someone deleted is not
          // coming back on its own, so say that rather than "press Add now".
          const gone = f.sonarrHeld === false && f.proposedState === 'pushedAlready';
          const text = f.proposedState === 'willBeAdded'
            ? `${aired}, not in Sonarr yet - press Add now`
            : gone
              ? `${aired} - added by us once, but Sonarr no longer has it`
              : `${aired}, no episode in Sonarr yet`;
          out.push({ level: 'broken', code: 'noVideo', text });
        } else if ((f.sonarrFiles ?? 0) > 0 && f.inJellyfin === false) {
          out.push({ level: 'broken', code: 'notInJellyfin', text: "Sonarr has the files but Jellyfin doesn't have the show - press Refresh Jellyfin" });
        } else {
          // Typically a sequel: Sonarr holds the series (earlier seasons on disk)
          // but nothing of this season has arrived - Sonarr monitors new seasons
          // by its own setting, not ours.
          out.push({
            level: 'broken', code: 'notInLibrary',
            text: f.sonarrHeld && (f.sonarrFiles ?? 0) > 0
              ? `${aired} - Sonarr has the series, but no episode of this season is in the library`
              : `${aired}, but the library has no episode for this entry`,
          });
        }
      }
    } else if (av.english === 'none' || av.english === 'signsOnly') {
      const ep = av.seasonNumber != null && av.episodeNumber != null ? `S${av.seasonNumber}E${av.episodeNumber}` : 'The first episode';
      out.push({
        level: 'broken', code: 'noEnglish',
        text: `${ep} has no English ${av.english === 'signsOnly' ? 'dialogue subtitles (signs only)' : 'subtitles or dub'}`,
      });
    } else if (f.english && !f.english.ok) {
      out.push({ level: 'check', code: 'someNoEnglish', text: `Some episodes have no English (${f.english.label})` });
    }
  }
  return out;
}

/**
 * Can this be watched in English here? `false` is exactly what Randomize's Hide
 * Not English hides (`isNotEnglish` in Randomize.svelte): an aired show the
 * library definitely lacks, or whose episode is `none` / `signsOnly`. `null` is
 * "no definite answer" - unaired, or the library could not be asked - which
 * Randomize also refuses to act on.
 */
export function watchable(f: Pick<SonarrFacts, 'availability' | 'unaired'>): boolean | null {
  const av = f.availability;
  if (f.unaired || !av || av.unknown) return null;
  if (!av.available) return false;
  return !(av.english === 'none' || av.english === 'signsOnly');
}

/** The codes a not-watchable row can carry - every one of them broken. */
export const NOT_WATCHABLE_CODES: ReadonlySet<string> = new Set([
  'noId', 'sonarrRejected', 'addFailed', 'noTvdbId', 'noVideo', 'notInJellyfin', 'notInLibrary', 'noEnglish',
]);

/** Identity problems a far-off premiere makes premature. */
const ID_CODES = new Set(['noId', 'guess', 'ambiguous', 'titleOnly', 'unconfirmedAuto']);

/**
 * Worst finding first, the rest kept as `also`.
 *
 * `waiting` - premiering more than the air window away - softens the identity
 * problems to `waiting`: map coverage is around 55% two months out, so next
 * season would otherwise read as half broken for problems that solve themselves.
 * Inside the window an id problem is real, because Sonarr would act now.
 */
export function combine(findings: Finding[], waiting: boolean): EntryStatus {
  const list = findings.map((x) => (waiting && ID_CODES.has(x.code) && x.level !== 'ok'
    ? {
        ...x,
        level: 'waiting' as Level,
        text: x.code === 'noId' ? 'No id yet - ids usually appear near the premiere' : x.text,
      }
    : x));
  if (!list.length) return { level: 'ok', code: 'ok', text: '' };
  const sorted = list
    .map((x, i) => ({ x, i }))
    .sort((a, b) => SEVERITY[b.x.level] - SEVERITY[a.x.level] || a.i - b.i)
    .map((e) => e.x);
  const [main, ...rest] = sorted;
  const also = rest.filter((x) => x.level !== 'ok');
  return also.length ? { ...main, also } : { ...main };
}

/** The one rule both pages use for Needs attention. */
export function needsAttention(s: { level: Level }, wanted: boolean): boolean {
  return wanted && (s.level === 'broken' || s.level === 'check');
}

export { DAY_MS };
