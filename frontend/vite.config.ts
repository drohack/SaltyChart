import { defineConfig, loadEnv } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// https://vitejs.dev/config/
export default ({ mode }) => {
  // Load environment variables from .env files
  const env = loadEnv(mode, process.cwd(), '');
  // VITE_API_URL can override backend URL in local dev
  const apiUrl = env.VITE_API_URL || 'http://localhost:3000';

  return defineConfig({
    plugins: [svelte()],
    // jassub (libass) runs libass in a web worker. Vite bundles workers as
    // `iife` by default, which cannot code-split — and jassub's worker does,
    // so the build fails outright. ES workers are supported everywhere the
    // rest of the player already requires.
    worker: { format: 'es' },
    // `npm run preview` serves the real build; it needs the same API proxy as
    // dev, otherwise nothing behind /api works when checking a production
    // bundle (which is the only way to test built worker/wasm assets).
    preview: {
      port: 4173,
      proxy: {
        '/api': { target: apiUrl, changeOrigin: true, secure: false },
      },
    },
    server: {
      // Listen on all interfaces so the dev server is reachable via the PC's
      // LAN IP (e.g. from a phone) — default is loopback-only.
      host: true,
      port: 5173,
      // Fail fast if 5173 is taken — forces us to clean up stale node processes
      // rather than silently falling through to 5174 and confusing the test suite.
      strictPort: true,
      proxy: {
        // Proxy /api requests to the backend service
        '/api': {
          target: apiUrl,
          changeOrigin: true,
          secure: false
        }
      }
    }
  });
};
