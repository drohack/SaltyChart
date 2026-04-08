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
  const merged = { ...defaultOptions, ...data };
  // Deep-merge nested subtitlePrefs so new fields get defaults
  merged.subtitlePrefs = { ...DEFAULT_SUBTITLE_PREFS, ...(data.subtitlePrefs || {}) };
  return merged;
}

// Create a writable store for options
export const options = writable<Options>(defaultOptions);

if (typeof window !== 'undefined') {
  // Flag to prevent saving during load operations (start as true to skip initial default values)
  let isLoading = true;

  // Debounce save to avoid spamming backend when dragging range sliders
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  // Load stored options on auth change (login/logout)
  authToken.subscribe(async (token) => {
    if (token) {
      // Fetch from backend with auth header
      isLoading = true;

      try {
        const res = await fetch('/api/options', {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (res.ok) {
          const data: Options = await res.json();
          console.log('[OPTIONS] Loaded from backend:', data);
          const merged = deepMergeOptions(data);
          console.log('[OPTIONS] After merge with defaults:', merged);
          options.set(merged);
        } else {
          console.log('[OPTIONS] Backend fetch failed, using defaults');
          options.set(defaultOptions);
        }
      } catch (e) {
        console.log('[OPTIONS] Backend fetch error, using defaults:', e);
        options.set(defaultOptions);
      } finally {
        isLoading = false;
      }
    } else {
      isLoading = true;

      // Load from localStorage for guest
      try {
        const raw = localStorage.getItem('options');
        if (raw) {
          const data = JSON.parse(raw);
          console.log('[OPTIONS] Loaded from localStorage:', data);
          const merged = deepMergeOptions(data);
          console.log('[OPTIONS] After merge with defaults:', merged);
          options.set(merged);
        } else {
          console.log('[OPTIONS] No localStorage data, using defaults');
          options.set(defaultOptions);
        }
      } catch (e) {
        console.log('[OPTIONS] localStorage error, using defaults:', e);
        options.set(defaultOptions);
      } finally {
        isLoading = false;
      }
    }
  });

  // Persist changes whenever options change (debounced for backend saves)
  options.subscribe((value) => {
    // Skip saving during initial load to avoid overwriting with defaults
    if (isLoading) {
      console.log('[OPTIONS] Skipping save (loading in progress)');
      return;
    }

    const token = get(authToken);
    if (token) {
      // Debounce backend saves (500ms) to handle rapid slider changes
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        console.log('[OPTIONS] Saving to backend:', value);
        fetch('/api/options', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify(value)
        }).then(res => {
          if (res.ok) {
            console.log('[OPTIONS] Saved successfully to backend');
          } else {
            console.error('[OPTIONS] Failed to save to backend:', res.status);
          }
        }).catch(err => {
          console.error('[OPTIONS] Error saving to backend:', err);
        });
      }, 500);
    } else {
      console.log('[OPTIONS] Saving to localStorage:', value);
      try {
        localStorage.setItem('options', JSON.stringify(value));
      } catch (e) {
        console.error('[OPTIONS] Error saving to localStorage:', e);
      }
    }
  });
}
