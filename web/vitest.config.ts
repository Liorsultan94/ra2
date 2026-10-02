import { defineConfig } from 'vitest/config';

// The simulation tests run whole AI games; give them room on slow CI runners.
export default defineConfig({
  test: {
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
