import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  // No rollup treeshake pass: it strips the `use client` banner below (esbuild
  // already drops unused code, and both dependencies are external).
  treeshake: false,
  target: 'es2022',
  splitting: false,
  minify: false,
  // Neither dependency is bundled: `@codeskop/tracker` publishes its own bundle
  // (docs/02 §2.1 — the core is a separate entry point so a vanilla consumer
  // never pays for React), and `react` is the host app's own copy (peerDependency).
  external: ['react', '@codeskop/tracker'],
  // Everything here uses context, effects or a class component, so it must run
  // as a Client Component. The directive lets Next.js App Router Server
  // Components (e.g. `app/layout.tsx`) import it directly, no wrapper needed.
  banner: { js: "'use client';" },
  esbuildOptions(options) {
    options.jsx = 'automatic';
  },
});
