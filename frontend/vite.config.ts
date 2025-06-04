import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

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
    server: {
      port: 5173,
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
