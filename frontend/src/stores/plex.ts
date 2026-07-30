import { writable, get } from 'svelte/store';
import { authToken } from './auth';

/**
 * Whether the logged-in user is the admin (null = probe in flight). Rides
 * along on the once-per-login /api/plex/status probe below — deliberately
 * NOT its own fetch against an admin-only endpoint, which would log a 403
 * console error for every regular user.
 */
export const isAdmin = writable<boolean | null>(null);

export interface PlexAvailability {
  available: boolean;
  /** True when the lookup failed (Plex slow/unreachable) — NOT "not present". */
  unknown?: boolean;
  showRatingKey?: string;
  episodeRatingKey?: string;
  episodeTitle?: string;
  /** Season/episode the player will start at (e.g. 3 / 1 for a "3rd Season" entry). */
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  /** Matched Plex show title — shown in the UI so bad matches are visible. */
  plexTitle?: string;
}

/**
 * Whether the server has a Plex connection configured (null = unknown).
 * When false (or logged out) every Plex UI element stays hidden — that's the
 * entire "non-Plex deploy shows nothing" mechanism.
 */
export const plexConfigured = writable<boolean | null>(null);

let _statusCheckedFor: string | null = null;

// Declared before the subscribe below — svelte stores invoke the subscriber
// synchronously on registration, and the logged-out branch clears these.
const _availabilityCache = new Map<number, PlexAvailability>();
const _inFlight = new Map<number, Promise<PlexAvailability>>();
/** Episodes already warmed this session — the server dedups too, but there's
 *  no reason to re-ask every time a pop-up reopens. */
const _warmed = new Set<string>();

authToken.subscribe((tok) => {
  if (!tok) {
    plexConfigured.set(false);
    isAdmin.set(false);
    _statusCheckedFor = null;
    _availabilityCache.clear();
    _inFlight.clear();
    _warmed.clear();
    return;
  }
  if (_statusCheckedFor === tok) return;
  _statusCheckedFor = tok;
  plexConfigured.set(null);
  isAdmin.set(null);
  fetch('/api/plex/status', { headers: { Authorization: `Bearer ${tok}` } })
    .then((r) => (r.ok ? r.json() : { configured: false, isAdmin: false }))
    .then((d) => {
      plexConfigured.set(!!d.configured);
      isAdmin.set(!!d.isAdmin);
    })
    .catch(() => {
      plexConfigured.set(false);
      isAdmin.set(false);
    });
});

const NOT_AVAILABLE: PlexAvailability = { available: false, unknown: true };

/**
 * Ask the server to extract this episode's subtitles now, so pressing Watch
 * plays immediately instead of waiting on a full-file read. Fire-and-forget:
 * the response says only that the work was accepted.
 */
export function warmPlexSubtitles(episodeRatingKey: string): void {
  const tok = get(authToken);
  if (!tok || !episodeRatingKey || _warmed.has(episodeRatingKey)) return;
  _warmed.add(episodeRatingKey);
  fetch('/api/plex/warm-subtitles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
    body: JSON.stringify({ episodeRatingKey }),
  }).catch(() => _warmed.delete(episodeRatingKey));
}

/**
 * Is this AniList entry in the Plex library? Cached per mediaId for the
 * session, with in-flight dedup so re-opening the same popup doesn't
 * double-fetch. Resolves to { available: false } on any error.
 *
 * `fresh: true` bypasses both the client cache and the server's negative
 * cache — used when a popup opens on a "not available" result, so a
 * just-downloaded show appears without waiting out cache TTLs.
 */
export function checkPlexAvailability(
  mediaId: number,
  titles: string[],
  fresh = false
): Promise<PlexAvailability> {
  const tok = get(authToken);
  if (!tok || get(plexConfigured) === false) return Promise.resolve(NOT_AVAILABLE);

  if (!fresh) {
    const cached = _availabilityCache.get(mediaId);
    if (cached) return Promise.resolve(cached);
  }
  const inFlight = _inFlight.get(mediaId);
  if (inFlight) return inFlight;

  const promise = fetch('/api/plex/availability', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
    body: JSON.stringify({ mediaId, titles: titles.filter(Boolean).slice(0, 10), ...(fresh ? { fresh: true } : {}) }),
  })
    .then((r) => (r.ok ? r.json() : NOT_AVAILABLE))
    .then((data: PlexAvailability) => {
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
