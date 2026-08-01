import { writable, get } from 'svelte/store';
import { authToken } from './auth';

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
}

/**
 * Whether the server has a media library configured (null = unknown).
 * When false (or logged out) every library UI element stays hidden — that's
 * the entire "non-Jellyfin deploy shows nothing" mechanism.
 */
export const mediaConfigured = writable<boolean | null>(null);

let _statusCheckedFor: string | null = null;

// Declared before the subscribe below — svelte stores invoke the subscriber
// synchronously on registration, and the logged-out branch clears these.
const _availabilityCache = new Map<number, MediaAvailability>();
const _inFlight = new Map<number, Promise<MediaAvailability>>();

authToken.subscribe((tok) => {
  if (!tok) {
    mediaConfigured.set(false);
    isAdmin.set(false);
    _statusCheckedFor = null;
    _availabilityCache.clear();
    _inFlight.clear();
    return;
  }
  if (_statusCheckedFor === tok) return;
  _statusCheckedFor = tok;
  mediaConfigured.set(null);
  isAdmin.set(null);
  fetch('/api/jellyfin/status', { headers: { Authorization: `Bearer ${tok}` } })
    .then((r) => (r.ok ? r.json() : { configured: false, isAdmin: false }))
    .then((d) => {
      mediaConfigured.set(!!d.configured);
      isAdmin.set(!!d.isAdmin);
    })
    .catch(() => {
      mediaConfigured.set(false);
      isAdmin.set(false);
    });
});

const NOT_AVAILABLE: MediaAvailability = { available: false, unknown: true };

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
  fresh = false
): Promise<MediaAvailability> {
  const tok = get(authToken);
  if (!tok || get(mediaConfigured) === false) return Promise.resolve(NOT_AVAILABLE);

  if (!fresh) {
    const cached = _availabilityCache.get(mediaId);
    if (cached) return Promise.resolve(cached);
  }
  const inFlight = _inFlight.get(mediaId);
  if (inFlight) return inFlight;

  const promise = fetch('/api/jellyfin/availability', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
    body: JSON.stringify({
      mediaId,
      titles: titles.filter(Boolean).slice(0, 10),
      ...(fresh ? { fresh: true } : {}),
    }),
  })
    .then((r) => (r.ok ? r.json() : NOT_AVAILABLE))
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
  entries: Array<{ mediaId: number; titles: string[] }>
): Promise<Map<number, MediaAvailability>> {
  const out = new Map<number, MediaAvailability>();
  const tok = get(authToken);
  if (!tok || get(mediaConfigured) === false) return out;

  const missing: Array<{ mediaId: number; titles: string[] }> = [];
  for (const e of entries) {
    const cached = _availabilityCache.get(e.mediaId);
    if (cached) out.set(e.mediaId, cached);
    else if (!out.has(e.mediaId)) missing.push(e);
  }
  if (!missing.length) return out;

  for (let i = 0; i < missing.length; i += BATCH_MAX) {
    const chunk = missing.slice(i, i + BATCH_MAX);
    try {
      const r = await fetch('/api/jellyfin/availability/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
        body: JSON.stringify({
          items: chunk.map((e) => ({
            mediaId: e.mediaId,
            titles: e.titles.filter(Boolean).slice(0, 10),
          })),
        }),
      });
      if (!r.ok) continue; // leave them unanswered rather than asserting absence
      const data = (await r.json()) as Record<string, MediaAvailability>;
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
      // Network failure: the callers treat an absent entry as "not checked",
      // which is the honest reading and keeps Hide-Not-in-Library inert.
    }
  }
  return out;
}
