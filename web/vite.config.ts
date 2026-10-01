import { defineConfig } from 'vite';

// Relative base so the build works from any sub-path (e.g. GitHub Pages /ra2/).
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
});
