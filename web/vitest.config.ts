import { configDefaults, defineConfig } from 'vitest/config';

// The simulation tests run whole AI games; give them room on slow CI runners.
// bench/ holds long AI-vs-AI balance benches: they only run with BENCH=1 (see bench/BAL1-NOTES.md).
export default defineConfig({
  test: {
    testTimeout: 120_000,
    hookTimeout: 120_000,
    exclude: process.env.BENCH ? configDefaults.exclude : [...configDefaults.exclude, 'bench/**'],
  },
});
