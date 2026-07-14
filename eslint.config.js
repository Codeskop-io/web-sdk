// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'playwright-report/**', 'test-results/**', 'node_modules/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Plain Node scripts (not part of the published bundle or the browser
    // runtime, e.g. the Phase 11 staging smoke harness) run under Node
    // directly rather than through the TS toolchain, so `no-undef` needs the
    // Node globals declared explicitly instead of relying on `typescript-eslint`
    // disabling the rule for `.ts` files.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        globalThis: 'readonly',
      },
    },
  },
);
