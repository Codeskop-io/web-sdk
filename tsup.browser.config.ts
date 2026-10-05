import { defineConfig } from 'tsup';

// The <script>-tag build: one minified IIFE, served from npm by jsDelivr/unpkg
// (`dist/codeskop.min.js`). Runs after the main build (which cleans dist/).
// ES2017 so it also loads on older Safari and in-app browsers the npm build's
// bundlers would otherwise transpile for.
export default defineConfig({
  entry: { codeskop: 'src/browser.ts' },
  format: ['iife'],
  outExtension: () => ({ js: '.min.js' }),
  platform: 'browser',
  target: 'es2017',
  minify: true,
  sourcemap: true,
  clean: false,
  dts: false,
  treeshake: true,
  splitting: false,
});
