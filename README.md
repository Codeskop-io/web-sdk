# Codeskop Web SDK (`@codeskop/tracker`)

[![npm version](https://img.shields.io/npm/v/@codeskop/tracker.svg)](https://www.npmjs.com/package/@codeskop/tracker)
[![license](https://img.shields.io/npm/l/@codeskop/tracker.svg)](./LICENSE)
[![bundle size](https://img.shields.io/bundlephobia/minzip/@codeskop/tracker)](https://bundlephobia.com/package/@codeskop/tracker)

The Codeskop **web** SDK — a tiny, tree-shakeable TypeScript library that captures
uncaught errors, unhandled rejections, `fetch`/XHR failures + latency, and presence
heartbeats from a browser app and delivers them to the Codeskop ingest backend. It is
the web counterpart to the [Android SDK](../android) and a client of the **same**
[locked ingest contract](../backend/docs/07-mobile-sdk-ingest-readiness.md#75-the-locked-contract-build-to-this).

**Free and open to install** — `@codeskop/tracker` is MIT-licensed and published to
the public npm registry, no signup or token required to `npm install` and read the
source. What's gated is **ingest**: initialize with a valid Codeskop public key from an
active plan and it captures and sends; without one it's a safe, permanent no-op — the
same model as the Android SDK (public Maven Central, gated server-side). See
[`docs/04-security-and-licensing.md`](./docs/04-security-and-licensing.md).

## Quick start

```bash
npm install @codeskop/tracker
```

```ts
import { init } from "@codeskop/tracker";

init({ apiKey: "cs_live_pk_…" });
```

Get a public key from your Codeskop dashboard — no key required to install or read the
code, required only for capture to actually reach your account.

## Where things are

- **Build → release workflow (start here):** [`web-sdk-workflow.md`](./web-sdk-workflow.md)
  — the single, phase-gated plan from `development` to a published public release.
- **Publish & release automation:** [`publish-workflow.md`](./publish-workflow.md) —
  the three GitHub Actions workflows (`ci.yml`, `publish-dev.yml`, `release.yml`), the
  version-bump-then-tag release process, the `next`/`latest` dist-tag scheme, and the
  rollback/yank procedure.
- **Reference docs:** [`docs/`](./docs) — architecture, event model, security &
  licensing, API reference, integration guide.

## At a glance

| | |
|---|---|
| Language / build | TypeScript · **tsup** (ESM + CJS + `.d.ts`) · tree-shakeable |
| Package | `@codeskop/tracker` (core, zero deps) · `@codeskop/tracker-react` (adapter) |
| Contract | `POST /v1/events` + `GET /v1/config` (shared with mobile + backend) |
| Auth | Public ingest key `cs_*_pk_…`; never the secret; origin binding designed, not yet enforced server-side |
| Distribution | Public npm (MIT), free install; runtime plan gate is the actual restriction |
| Quality gates | 80% coverage · gzipped bundle-size budget · Playwright e2e |
