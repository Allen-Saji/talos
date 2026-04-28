import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    'bin/talos': 'bin/talos.ts',
    'bin/talosd': 'bin/talosd.ts',
  },
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: true,
  minify: false,
  shims: true,
  dts: false,
})
