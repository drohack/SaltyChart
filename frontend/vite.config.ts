import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  server: {
    port: 5173,
    // When the dev server runs inside Docker, "localhost" refers to the
    // *container itself*.  We need to target the back-end service on the
    // Docker network (service name: "backend").
    proxy: {
      '/api': {
        target: 'http://backend:3000',
        changeOrigin: true
      }
    }
  }
});
