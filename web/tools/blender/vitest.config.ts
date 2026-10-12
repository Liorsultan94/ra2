import { defineConfig } from 'vitest/config';

// Blender pipeline step 1 only (export-procedural.ts); not part of the game's test run.
export default defineConfig({
  test: { include: ['tools/blender/export-procedural.ts'], testTimeout: 120_000 },
});
