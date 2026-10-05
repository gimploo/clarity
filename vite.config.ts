import { defineConfig } from 'vite';

export default defineConfig({
  // Repo is served from https://gimploo.github.io/clarity/ via GitHub Pages.
  base: '/clarity/',
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
  },
  server: {
    port: 5173,
  },
});