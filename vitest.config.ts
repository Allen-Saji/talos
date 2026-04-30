import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    // PGLite WASM init contends under high parallelism — each fresh ephemeral
    // instance takes ~10x longer when 8+ workers race to initialize the WASM
    // module simultaneously, blowing past the default 10s hook timeout. Cap
    // workers to 4 (well under most CPU counts) and give beforeEach a 20s
    // budget so transient pressure doesn't flake the suite.
    pool: 'forks',
    maxWorkers: 4,
    hookTimeout: 20_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
