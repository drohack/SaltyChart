import { writable, get } from 'svelte/store';
import { authToken } from './auth';

// Theme options
export type Theme = 'LIGHT' | 'NIGHT' | 'SYSTEM' | 'HIGH_CONTRAST';
// Title language options
export type TitleLanguage = 'ENGLISH' | 'ROMAJI' | 'NATIVE';
// Add watched position options
export type AddWatchedPosition = 'TOP' | 'BOTTOM';

export interface Options {
  theme: Theme;
  titleLanguage: TitleLanguage;
  videoAutoplay: boolean;
  hideFromCompare: boolean;
  nicknameUserSel: string[];
  addWatchedTo: AddWatchedPosition;
}

// Default values
const defaultOptions: Options = {
  theme: 'SYSTEM',
  titleLanguage: 'ENGLISH',
  videoAutoplay: true,
  hideFromCompare: false,
  nicknameUserSel: [],
  addWatchedTo: 'BOTTOM'
};

// Create a writable store for options
export const options = writable<Options>(defaultOptions);

if (typeof window !== 'undefined') {
  // Flag to prevent saving during load operations (start as true to skip initial default values)
  let isLoading = true;

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
          // Merge with defaults to ensure new fields have default values
          const merged = { ...defaultOptions, ...data };
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
          // Merge with defaults to ensure new fields have default values
          const merged = { ...defaultOptions, ...data };
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

  // Persist changes whenever options change
  options.subscribe((value) => {
    // Skip saving during initial load to avoid overwriting with defaults
    if (isLoading) {
      console.log('[OPTIONS] Skipping save (loading in progress)');
      return;
    }

    const token = get(authToken);
    if (token) {
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
