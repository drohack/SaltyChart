import { writable, get } from 'svelte/store';
import { authToken } from './auth';

// Theme options
export type Theme = 'LIGHT' | 'NIGHT' | 'SYSTEM' | 'HIGH_CONTRAST';
// Title language options
export type TitleLanguage = 'ENGLISH' | 'ROMAJI' | 'NATIVE';

export interface Options {
  theme: Theme;
  titleLanguage: TitleLanguage;
  videoAutoplay: boolean;
  hideFromCompare: boolean;
  nicknameUserSel: string[];
}

// Default values
const defaultOptions: Options = {
  theme: 'SYSTEM',
  titleLanguage: 'ENGLISH',
  videoAutoplay: true,
  hideFromCompare: false
  , nicknameUserSel: []
};

// Create a writable store for options
export const options = writable<Options>(defaultOptions);

if (typeof window !== 'undefined') {
  // Load stored options on auth change (login/logout)
  authToken.subscribe(async (token) => {
    if (token) {
      // Fetch from backend with auth header
      try {
        const res = await fetch('/api/options', {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (res.ok) {
          const data: Options = await res.json();
          options.set(data);
        } else {
          options.set(defaultOptions);
        }
      } catch {
        options.set(defaultOptions);
      }
    } else {
      // Load from localStorage for guest
      try {
        const raw = localStorage.getItem('options');
        if (raw) {
          options.set(JSON.parse(raw));
        } else {
          options.set(defaultOptions);
        }
      } catch {
        options.set(defaultOptions);
      }
    }
  });

  // Persist changes whenever options change
  options.subscribe((value) => {
    const token = get(authToken);
    if (token) {
      fetch('/api/options', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(value)
      }).catch(console.error);
    } else {
      try {
        localStorage.setItem('options', JSON.stringify(value));
      } catch {
        // ignore
      }
    }
  });
}
