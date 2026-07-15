import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: 'es2022',
  splitting: false,
  minify: false,
  // Neither dependency is bundled: `@codeskop/tracker` publishes its own bundle
  // (docs/02 §2.1 — the core is a separate entry point so a vanilla consumer
  // never pays for React), and `react` is the host app's own copy (peerDependency).
  external: ['react', '@codeskop/tracker'],
  esbuildOptions(options) {
    options.jsx = 'automatic';
  },
});
