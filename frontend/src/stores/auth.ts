import { writable } from 'svelte/store';

const initial = typeof localStorage !== 'undefined' ? localStorage.getItem('token') : null;

export const authToken = writable<string | null>(initial);

const nameInit = typeof localStorage !== 'undefined' ? localStorage.getItem('username') : null;
export const userName = writable<string | null>(nameInit);

authToken.subscribe((val) => {
  if (typeof localStorage === 'undefined') return;
  if (val) localStorage.setItem('token', val);
  else localStorage.removeItem('token');
});

userName.subscribe((val) => {
  if (typeof localStorage === 'undefined') return;
  if (val) localStorage.setItem('username', val);
  else localStorage.removeItem('username');
});
