import { writable, get } from 'svelte/store';
import { authToken } from './auth';
import { apiFetch, apiJson, QUICK } from '../lib/remote';

/**
 * Whether the logged-in user is the admin (null = probe in flight). Rides
 * along on the once-per-login /api/jellyfin/status probe below — deliberately
 * NOT its own fetch against an admin-only endpoint, which would log a 403
 * console error for every regular user.
 */
export const isAdmin = writable<boolean | null>(null);

export interface MediaAvailability {
  available: boolean;
  /** True when the lookup failed (server slow/unreachable) — NOT "not present". */
  unknown?: boolean;
  /**
   * The series hasn't aired yet, so it was never looked up. Distinct from
   * `available: false` on its own, which means "we asked and it isn't there" —
   * bulk actions must not treat this as missing. See `isUnaired`.
   */
  notAired?: boolean;
  /** Jellyfin ids for the episode to play. */
  seriesId?: string;
  itemId?: string;
  mediaSourceId?: string;
  episodeTitle?: string;
  /** Season/episode the player will start at (e.g. 3 / 1 for a "3rd Season" entry). */
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  /** Matched library title — shown in the UI so a bad match is visible. */
  libraryTitle?: string;
  /**
   * How the match was made. `id` is an AniList→TVDB→library id chain and is
   * exact; `title` is fuzzy string matching, which has produced a real false
   * positive (a 2026 entry matching a 2004 series of similar name). The UI
   * marks `title` matches, and bulk actions refuse to act on them.
   */
  matchedBy?: 'id' | 'title';
  /**
   * The id behind an `id` match was *guessed* by the remote resolver rather than
   * supplied by the community map or confirmed by a human.
   *
   * It still shows a Watch button — the id is positive-only, so it can only ever
   * add one — but it carries the same warning a partial title match does. An
   * unmarked guess presented as fact is exactly what the confidence markers
   * exist to prevent.
   */
  unverified?: boolean;
  /**
   * Which fuzzy tier matched: 0 exact, 1 prefix. Only set when
   * `matchedBy === 'title'`. Tier 0 is a normalised exact hit and is treated as
   * confirmed; the false positives this warning exists for were all tier 1.
   * (A contains-anywhere tier 2 existed and was removed backend-side — 9 fired,
   * 9 wrong — so 2 can never arrive on the wire.)
   */
  titleTier?: 0 | 1;
}

/**
 * Whether the server has a media library configured (null = unknown).
 * When false (or logged out) every library UI element stays hidden — that's
 * the entire "non-Jellyfin deploy shows nothing" mechanism.
 */
export const mediaConfigured = writable<boolean | null>(null);

/**
 * How the last library lookup went, so a page can say *which* kind of nothing
 * it is showing.
 *
 * Without this, four different situations rendered identically as a blank with
 * no Watch buttons: still resolving, the request 502'd, the backend couldn't
 * reach Jellyfin, and everything resolved fine with nothing to report. That
 * ambiguity is why a real outage was indistinguishable from normal operation,
 * from both sides.
 */
export type LibraryStatus = 'idle' | 'checking' | 'ok' | 'unreachable';
export const libraryStatus = writable<LibraryStatus>('idle');

let _statusCheckedFor: string | null = null;

// Declared before the subscribe below — svelte stores invoke the subscriber
// synchronously on registration, and the logged-out branch clears these.
const _availabilityCache = new Map<number, MediaAvailability>();
const _inFlight = new Map<number, Promise<MediaAvailability>>();

authToken.subscribe((tok) => {
  if (!tok) {
    mediaConfigured.set(false);
    isAdmin.set(false);
    libraryStatus.set('idle');
    _statusCheckedFor = null;
    _availabilityCache.clear();
    _inFlight.clear();
    return;
  }
  if (_statusCheckedFor === tok) return;
  mediaConfigured.set(null);
  isAdmin.set(null);

  /**
   * Probe whether a library is configured, retrying until we get a real answer.
   *
   * "Couldn't ask" is not "there is no library" — the same distinction
   * `unknown` already makes for availability, which this probe was missing.
   * It used to latch `_statusCheckedFor` *before* the request and treat any
   * failure (including a non-200) as `configured: false`, so a single blip
   * hid every Watch button and greyed out Hide-Not-in-Library for the rest of
   * the session, silently and with no retry.
   *
   * That is exactly what a deploy looks like from the browser: the backend
   * restarts, this one request hits it mid-restart, and the app quietly decides
   * Jellyfin does not exist until you happen to reload. Only a definitive
   * answer is recorded now; anything else is retried.
   */
  // `apiFetch` retries 5xx and network faults on its own budget and cannot
  // hang; a 4xx is a real answer (bad or expired token) and stops the asking.
  apiFetch('/api/jellyfin/status', { headers: { Authorization: `Bearer ${tok}` } },
           { label: 'jellyfin/status', timeoutMs: QUICK })
    .then(async (r) => {
      const d = r.ok ? await r.json() : { configured: false, isAdmin: false };
      if (get(authToken) !== tok) return; // logged out or switched user
      _statusCheckedFor = tok;
      mediaConfigured.set(!!d.configured);
      isAdmin.set(!!d.isAdmin);
    })
    .catch(() => {
      if (get(authToken) !== tok) return;
      // Give up loudly rather than pretending there's no library: leaving
      // `mediaConfigured` null keeps the UI in its "still figuring this out"
      // state instead of asserting a wrong answer for the whole session, which
      // is what latching `false` used to do — and it never recovered without a
      // reload, even once the server came back.
      console.warn('[jellyfin] status probe failed; library UI stays hidden until reload');
    });
});

const NOT_AVAILABLE: MediaAvailability = { available: false, unknown: true };
const NOT_AIRED: MediaAvailability = { available: false, notAired: true };

/** AniList airing facts, as they arrive on an `/api/anime` entry. */
export interface AiringInfo {
  status?: string | null;
  startDate?: { year?: number | null; month?: number | null; day?: number | null } | null;
}

/**
 * Has this series started airing?
 *
 * A show that hasn't aired cannot be in the library, so asking about it can only
 * ever produce a false positive. Measured on the season the app opens on by
 * default (the look-ahead can land on an unaired season): the AniList→TVDB map has no
 * entries for brand-new shows, so every match fell through to fuzzy titles and
 * *all* of them were wrong — "Firefly Wedding" → the 2002 series "Firefly",
 * "Dragon Ball Super: Beerus" → "Dragon Ball". FALL 2026 was 83/83
 * NOT_YET_RELEASED; SPRING 2026 had none, so aired seasons are unaffected.
 *
 * `status` is authoritative when present. `startDate` is the fallback and is
 * routinely partial (`{year: 2026, month: 10, day: null}`) — a missing month or
 * day is treated as the earliest possible, so a show is only called unaired when
 * even its earliest possible date is still in the future.
 */
export function isUnaired(info?: AiringInfo | null, now: Date = new Date()): boolean {
  if (!info) return false;
  if (info.status) return info.status === 'NOT_YET_RELEASED';
  const d = info.startDate;
  if (!d?.year) return false;
  const earliest = Date.UTC(d.year, (d.month ?? 1) - 1, d.day ?? 1);
  return earliest > now.getTime();
}

/**
 * Is this AniList entry in the library? Cached per mediaId for the session,
 * with in-flight dedup so re-opening the same popup doesn't double-fetch.
 * Resolves to `unknown` on any error.
 *
 * `fresh: true` bypasses both the client cache and the server's negative
 * cache — used when a popup opens on a "not available" result, so a
 * just-downloaded show appears without waiting out cache TTLs.
 */
export function checkAvailability(
  mediaId: number,
  titles: string[],
  fresh = false,
  airing?: AiringInfo | null
): Promise<MediaAvailability> {
  const tok = get(authToken);
  if (!tok || get(mediaConfigured) === false) return Promise.resolve(NOT_AVAILABLE);

  // Never ask about a show that hasn't aired — see `isUnaired`. Deliberately
  // ahead of the cache and not written to it: this is a fact about the calendar,
  // not about the library, so it must be re-derived rather than pinned for the
  // session (a show can start airing while the tab is open).
  if (isUnaired(airing)) return Promise.resolve(NOT_AIRED);

  if (!fresh) {
    const cached = _availabilityCache.get(mediaId);
    if (cached) return Promise.resolve(cached);
  }
  const inFlight = _inFlight.get(mediaId);
  if (inFlight) return inFlight;

  const promise = apiJson<MediaAvailability>(
    '/api/jellyfin/availability',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
      body: JSON.stringify({
        mediaId,
        titles: titles.filter(Boolean).slice(0, 10),
        ...(fresh ? { fresh: true } : {}),
        // Lets the server pick the episode by air date rather than by parsing a
        // season number out of the title — see `getFirstEpisode`.
        ...(airing?.startDate ? { startDate: airing.startDate } : {}),
      }),
    },
    { label: 'availability', timeoutMs: QUICK }
  )
    .then((data: MediaAvailability) => {
      // Never cache "we couldn't ask" — otherwise one slow moment marks a
      // show as missing for the rest of the session.
      if (!data.unknown) _availabilityCache.set(mediaId, data);
      return data;
    })
    .catch(() => NOT_AVAILABLE)
    .finally(() => _inFlight.delete(mediaId));

  _inFlight.set(mediaId, promise);
  return promise;
}

/** Server cap, mirrored so we chunk rather than get a 400. */
const BATCH_MAX = 100;

/**
 * Ask about many shows in one request.
 *
 * Randomize needs an answer for every wheel item. Calling `checkAvailability`
 * per show meant ~50 HTTP requests on every page load — enough to eat most of
 * the Jellyfin router's 120/min budget, and on a cold backend enough to become
 * 50 separate library lookups.
 *
 * Results are written into the same `_availabilityCache` the single-entry path
 * reads, so a pop-up opened afterwards is still an instant cache hit.
 */
export async function checkAvailabilityMany(
  entries: Array<{ mediaId: number; titles: string[]; airing?: AiringInfo | null }>
): Promise<Map<number, MediaAvailability>> {
  const out = new Map<number, MediaAvailability>();
  const tok = get(authToken);
  if (!tok || get(mediaConfigured) === false) {
    // Not an answer — we never asked. Callers already refuse to act on a gap,
    // but the page used to render this identically to "everything resolved and
    // nothing is missing", which is how a broken lookup looked exactly like a
    // healthy library.
    if (tok) libraryStatus.set('unreachable');
    return out;
  }

  const missing: Array<{ mediaId: number; titles: string[]; airing?: AiringInfo | null }> = [];
  for (const e of entries) {
    // Unaired entries are answered locally and never sent — on the default
    // (unaired) season this is the whole list, so it also removes ~83 library
    // lookups per page load. Not cached, for the reason in `checkAvailability`.
    if (isUnaired(e.airing)) { out.set(e.mediaId, NOT_AIRED); continue; }
    const cached = _availabilityCache.get(e.mediaId);
    if (cached) out.set(e.mediaId, cached);
    else if (!out.has(e.mediaId)) missing.push(e);
  }
  if (!missing.length) {
    libraryStatus.set('ok');
    return out;
  }

  libraryStatus.set('checking');
  let failedChunks = 0;

  for (let i = 0; i < missing.length; i += BATCH_MAX) {
    const chunk = missing.slice(i, i + BATCH_MAX);
    const body = JSON.stringify({
      items: chunk.map((e) => ({
        mediaId: e.mediaId,
        titles: e.titles.filter(Boolean).slice(0, 10),
        ...(e.airing?.startDate ? { startDate: e.airing.startDate } : {}),
      })),
    });

    // Retry rather than drop. A chunk used to be abandoned on the first
    // non-2xx or throw, leaving those shows permanently unanswered for the
    // page — no Watch buttons, no explanation, and nothing re-triggered it
    // because the only trigger is the wheel contents changing. The server
    // never caches `unknown`, so re-asking is cheap and correct.
    //
    // `apiFetch` owns the retry policy: bounded by a total budget, and never
    // retrying a timeout, so a slow-but-working server isn't asked three times
    // over. It also can't hang — this request had no timeout at all before.
    try {
      const data = await apiJson<Record<string, MediaAvailability>>(
        '/api/jellyfin/availability/batch',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
          body,
        },
        { label: 'availability/batch', timeoutMs: QUICK }
      );
      for (const [id, info] of Object.entries(data)) {
        const mediaId = Number(id);
        // Same rule as the single path: "we couldn't ask" is never cached, and
        // never reported as a definite answer.
        if (!info?.unknown) {
          _availabilityCache.set(mediaId, info);
          out.set(mediaId, info);
        }
      }
    } catch {
      failedChunks++; // apiFetch already logged why
    }
  }

  libraryStatus.set(failedChunks ? 'unreachable' : 'ok');
  return out;
}
