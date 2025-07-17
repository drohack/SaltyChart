import { writable } from 'svelte/store';
import { options } from './options';

// All user names that have at least one nickname in the database.
export const allUsers = writable<string[]>([]);

// Selected users to display in the nickname modal.
// Stored as a Set for O(1) lookup.
export const selectedUsers = writable<Set<string>>(new Set());

// When options change (e.g., after login), sync nicknameUserSel → selectedUsers
options.subscribe((opt) => {
  if (opt && Array.isArray(opt.nicknameUserSel)) {
    selectedUsers.set(new Set(opt.nicknameUserSel));
  }
});

// Helper to update selection and persist to localStorage.
export function toggleUser(user: string) {
  selectedUsers.update((set) => {
    const next = new Set(set);
    if (next.has(user)) next.delete(user);
    else next.add(user);
    // persist
    // Persist locally for guests + update options store for logged-in users
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('nickUserSel', JSON.stringify([...next]));
    }

    options.update((o) => ({ ...o, nicknameUserSel: [...next] }));
    return next;
  });
}

// Restore persisted selection on module import (runs once in client).
if (typeof window !== 'undefined') {
  const saved = localStorage.getItem('nickUserSel');
  if (saved) {
    try {
      const arr = JSON.parse(saved);
      if (Array.isArray(arr)) selectedUsers.set(new Set(arr));
    } catch {}
  }
}
