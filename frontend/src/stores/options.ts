import { writable, get } from 'svelte/store';
import { authToken } from './auth';

// Theme options
export type Theme = 'LIGHT' | 'NIGHT' | 'SYSTEM' | 'HIGH_CONTRAST';
// Title language options
export type TitleLanguage = 'ENGLISH' | 'ROMAJI' | 'NATIVE';
// Add watched position options
export type AddWatchedPosition = 'TOP' | 'BOTTOM';

// Subtitle style preferences
export interface SubtitlePrefs {
  enabled: boolean;
  fontSize: number;
  fontFamily: string;
  position: number;
  textColor: string;
  bgColor: string;
  bgOpacity: number;
  textBorder: 'none' | 'light' | 'medium' | 'heavy' | 'drop-shadow' | 'glow';
}

export const DEFAULT_SUBTITLE_PREFS: SubtitlePrefs = {
  enabled: true,
  fontSize: 28,
  fontFamily: 'Arial',
  position: 92,
  textColor: '#ffffff',
  bgColor: '#000000',
  bgOpacity: 50,
  textBorder: 'medium',
};

export interface Options {
  theme: Theme;
  titleLanguage: TitleLanguage;
  videoAutoplay: boolean;
  hideFromCompare: boolean;
  nicknameUserSel: string[];
  addWatchedTo: AddWatchedPosition;
  subtitlePrefs: SubtitlePrefs;
}

// Default values
const defaultOptions: Options = {
  theme: 'SYSTEM',
  titleLanguage: 'ENGLISH',
  videoAutoplay: true,
  hideFromCompare: false,
  nicknameUserSel: [],
  addWatchedTo: 'BOTTOM',
  subtitlePrefs: { ...DEFAULT_SUBTITLE_PREFS },
};

function deepMergeOptions(data: any): Options {
  // `data` is whatever the server or localStorage handed over, so it may be null
  // or a scalar. It used to be spread and then dereferenced directly, so a `null`
  // body on an otherwise-OK response threw inside the caller's `try` and silently
  // reset the user to defaults.
  const src = data && typeof data === 'object' ? data : {};
  const merged = { ...defaultOptions, ...src };
  // Deep-merge nested subtitlePrefs so new fields get defaults
  merged.subtitlePrefs = { ...DEFAULT_SUBTITLE_PREFS, ...(src.subtitlePrefs || {}) };
  return merged;
}

/**
 * The localStorage copy of the last-known options.
 *
 * This exists so a logged-in user's first paint uses what they last chose rather
 * than `defaultOptions`. For a long time only the *guest* branch read it, so the
 * one path that needed it never did: a NIGHT account painted `light` at 76 ms,
 * `/api/options` resolved at 85 ms and `dark` landed at 87 ms. Delaying the
 * response by 300 ms stretched that wrong-theme window to 504 ms, so it is the
 * fetch latency, and on any real link it is a visible white flash on every load.
 */
function readMirror(): Options | null {
  try {
    const raw = localStorage.getItem('options');
    return raw ? deepMergeOptions(JSON.parse(raw)) : null;
  } catch (e) {
    console.error('[OPTIONS] localStorage read error:', e);
    return null;
  }
}

function writeMirror(value: Options): void {
  try {
    localStorage.setItem('options', JSON.stringify(value));
  } catch (e) {
    console.error('[OPTIONS] Error saving to localStorage:', e);
  }
}

// Create a writable store for options
export const options = writable<Options>(defaultOptions);

if (typeof window !== 'undefined') {
  // Flag to prevent saving during load operations (start as true to skip initial default values)
  let isLoading = true;

  // Debounce save to avoid spamming backend when dragging range sliders
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Bumped on every auth change, so work started for one identity can tell that
   * it has been superseded.
   *
   * Without it, three things went wrong, all of them because the fetch below is
   * the only async step and nothing was watching who it belonged to:
   * a logout landing mid-flight cleared `isLoading` from the guest branch, after
   * which the pending response applied the previous account's options to a
   * logged-out visitor; an account switch whose responses arrived out of order
   * applied the older one last; and the debounced PUT then wrote those options
   * to whichever account was current, i.e. someone else's row.
   */
  let authGen = 0;

  // Load stored options on auth change (login/logout)
  authToken.subscribe(async (token) => {
    const gen = ++authGen;
    // A save queued for the previous identity must never fire against the new
    // one - the PUT closes over a token read when it was scheduled.
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    isLoading = true;

    const mirrored = readMirror();

    if (!token) {
      // Guest: synchronous, so there is no gap to cover and no flash.
      options.set(mirrored ?? defaultOptions);
      isLoading = false;
      return;
    }

    // Paint the last-known options now. The server is still authoritative and
    // overwrites this a few ms later; the point is that the interim value is the
    // user's own rather than `SYSTEM`.
    if (mirrored) options.set(mirrored);

    let resolved: Options | null = null;
    try {
      const res = await fetch('/api/options', {
        headers: { Authorization: `Bearer ${token}` }
      });
      // Superseded while we waited - leave `isLoading` to the run that replaced
      // us, or clearing it here would let this stale response through.
      if (gen !== authGen) return;
      if (res.ok) resolved = deepMergeOptions(await res.json());
    } catch (e) {
      console.error('[OPTIONS] Backend fetch error:', e);
    }
    if (gen !== authGen) return;

    if (resolved) {
      options.set(resolved);
      // Keep the mirror in step with the server. Skipping this is what left the
      // three surfaces disagreeing for good: a guest who chose NIGHT, signed up
      // and never reopened Options had the server saying SYSTEM, localStorage
      // saying NIGHT and the DOM showing light - and logging out then flipped the
      // site to dark off that stale copy, which is precisely what the mirror was
      // supposed to prevent.
      writeMirror(resolved);
    } else if (!mirrored) {
      // Nothing from the server and nothing stored.
      options.set(defaultOptions);
    }
    isLoading = false;
  });

  // Persist changes whenever options change (debounced for backend saves)
  options.subscribe((value) => {
    // Skip saving during initial load to avoid overwriting with defaults
    if (isLoading) return;

    // Always mirror to localStorage, signed in or not. The server stays
    // authoritative on load for a logged-in user - this copy exists so the
    // theme survives the gap before that fetch returns, and so logging out
    // doesn't snap the UI back to whatever was last written as a guest.
    // Previously this only ran on the `else` branch, so a signed-in user who
    // chose LIGHT had the server saying LIGHT while localStorage still said
    // SYSTEM indefinitely.
    writeMirror(value);

    const token = get(authToken);
    if (token) {
      // Which identity this save belongs to. Checked again when it fires, because
      // 500 ms is long enough to log out or switch account in between and the
      // token below is the one captured now.
      const genAtSave = authGen;
      // Debounce backend saves (500ms) to handle rapid slider changes
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        if (genAtSave !== authGen) return;
        fetch('/api/options', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify(value)
        }).then(res => {
          if (!res.ok) {
            console.error('[OPTIONS] Failed to save to backend:', res.status);
          }
        }).catch(err => {
          console.error('[OPTIONS] Error saving to backend:', err);
        });
      }, 500);
    }
  });
}
