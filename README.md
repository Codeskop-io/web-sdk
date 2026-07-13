# Codeskop Web SDK (`@codeskop/tracker`)

The Codeskop **web** SDK — a tiny, tree-shakeable TypeScript library that captures
uncaught errors, unhandled rejections, `fetch`/XHR failures + latency, and presence
heartbeats from a browser app and delivers them to the Codeskop ingest backend. It is
the web counterpart to the [Android SDK](../android) and a client of the **same**
[locked ingest contract](../backend/docs/07-mobile-sdk-ingest-readiness.md#75-the-locked-contract-build-to-this).

> **Commercial, licensed library (not free).** Distributed as a **private** scoped
> package installed with a subscription-tied token, with a runtime plan gate — see
> [`docs/04-security-and-licensing.md`](./docs/04-security-and-licensing.md).

## Where things are

- **Build → release workflow (start here):** [`web-sdk-workflow.md`](./web-sdk-workflow.md)
  — the single, phase-gated plan from `development` to a published, licensed release.
- **Reference docs:** [`docs/`](./docs) — architecture, event model, security &
  licensing, API reference, integration guide.

## At a glance

| | |
|---|---|
| Language / build | TypeScript · **tsup** (ESM + CJS + `.d.ts`) · tree-shakeable |
| Package | `@codeskop/tracker` (core, zero deps) · `@codeskop/tracker-react` (adapter) |
| Contract | `POST /v1/events` + `GET /v1/config` (shared with mobile + backend) |
| Auth | Public ingest key `cs_*_pk_…`; origin-bound; never the secret |
| Distribution | Private registry + per-customer token + runtime plan gate |
| Quality gates | 80% coverage · gzipped bundle-size budget · Playwright e2e |

> **Note on the folder name:** `webpack` is only the directory name — the library is
> built with **tsup** (esbuild), not webpack, because a distributable SDK needs lean,
> tree-shakeable, multi-format output. See the workflow Phase 0.
