import { writable } from 'svelte/store';

// holds media object currently being dragged
export const dragged = writable<any | null>(null);
