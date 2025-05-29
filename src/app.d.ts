// See https://kit.svelte.dev/docs/types#app
import type { OAuthToken } from '$lib/types';

declare global {
  namespace App {
    // interface Error {}
    interface Locals {
      token?: OAuthToken;
    }
    // interface PageData {}
    // interface Platform {}
  }
}

export {};
