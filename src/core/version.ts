/**
 * The SDK version stamped into `context.app.sdk_version` (`docs/03` §3.3).
 * Mirrors `package.json`'s `version` field. Kept as a manual literal — the
 * core has no build-time codegen step yet — so bump it alongside
 * `package.json` on every release; `fetchTransport.integration.test.ts`
 * already hardcodes the same literal for its own envelope fixtures.
 */
export const SDK_VERSION = '1.4.0';
