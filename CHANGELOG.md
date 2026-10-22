# Changelog

Changes to `@codeskop/tracker` and `@codeskop/tracker-react`. Earlier releases are described in their tagged commits and GitHub releases.

## 1.6.0 (2026-10-22)

- **New: `captureExceptionMessages`** (default `false`). Opt in to sending exception messages instead of `[REDACTED]`, on every capture path: `window` errors, unhandled rejections, `recordException` and the React error boundary. Same option as the mobile SDKs' `CodeskopConfig.captureExceptionMessages`. Messages can contain user data, so the default is unchanged.
  ```ts
  init({ apiKey: "cs_live_pk_…", captureExceptionMessages: true });
  ```
  With the script tag: `data-codeskop-exception-messages="true"`.
- Resource-load errors (`Failed to load img: …`) never include the URL's query string or fragment, even with messages on.
- API report: `CodeskopConfig` gains an optional field (minor, source compatible).
