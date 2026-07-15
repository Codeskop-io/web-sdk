# 1. Web SDK — Blueprint & Decisions

> Vision, scope, footprint budgets, and the locked decision log for `@codeskop/tracker`,
> the Codeskop **web** SDK. It is the browser counterpart to the Android SDK and a new
> client of the **same** shipped ingest contract
> ([`backend/docs/07` §7.5](../../backend/docs/07-mobile-sdk-ingest-readiness.md#75-the-locked-contract-build-to-this)).

## 1.1 What it is

A tiny, tree-shakeable TypeScript library that a web app embeds to capture:

- **Uncaught errors** (`window.onerror`) and **unhandled promise rejections**,
- **API failures + latency** by instrumenting `fetch` and `XMLHttpRequest`,
- **Presence heartbeats** while the page is visible,

then batches them offline-first and delivers them to `POST /v1/events`, fetching its
entitlements from `GET /v1/config`. It honours the same prime directive as the mobile
SDK: **never degrade or crash the host application.**

## 1.2 The prime directive

Every capture hook is wrapped in a guard: a bug in *our* code becomes a dropped event
and an internal diagnostic — **never** a host-page error, a blocked main thread, or a
broken network request. This is enforced structurally (`safely()`), by the remote
kill-switch, and by the CI gates.

## 1.3 Scope — in and out

| In scope | Out of scope (later / never) |
|----------|------------------------------|
| Evergreen browsers; ESM + CJS + `.d.ts` | Legacy IE; React-Native (that's mobile) |
| Vanilla core + React adapter | Vue/Angular/Svelte adapters (fast-follow) |
| Error, rejection, network, heartbeat capture | Session replay, full RUM, DOM breadcrumbs (later) |
| The existing `POST /v1/events` + `GET /v1/config` contract | Any new backend contract |
| Private, licensed distribution (D11) | Public/free distribution |

## 1.4 Footprint budgets (gates, not aspirations)

The web analog of the Android AAR budget. Merge-blocking in CI (Workflow Phase 0).

- **Core gzipped bundle ≤ 12 KB** (initial target; tighten as the surface settles).
- **Zero dependencies** in the core (adapters may depend on their framework only).
- **No long tasks at init** — initialization does no synchronous network or heavy work;
  capture hooks do the minimum on the calling path and defer the rest.
- **Bounded storage** — the IndexedDB queue has a hard byte cap with drop-oldest.
- **`sideEffects:false`** so unused capture paths tree-shake away.

## 1.5 Decision log

The decisions every phase must honour. D1–D9 mirror the mobile SDK's locked decisions
(same contract); **D10 and D11 are web-specific.**

| ID | Decision | Rationale |
|----|----------|-----------|
| **D1** | **TypeScript**, browser-first; ships ESM + CJS + types, built with **tsup**; tree-shakeable | Modern web integration; smallest footprint |
| **D2** | Presence is **server-derived from heartbeats** — no device/browser socket | Battery/CPU friendly; presence is a backend query over recent timestamps |
| **D3** | Default network capture = **metadata + redacted headers**; bodies opt-in | Privacy by default; `Authorization`/`Cookie` never captured |
| **D4** | Stability = **remote kill-switch + global guards + 80% coverage gate + bundle-size gate** | The prime directive, enforced |
| **D5** | Authenticate with the **public ingest key** (`cs_*_pk_…`), **never** the secret (`cs_*_sk_…`) | A secret in browser JS is a public leak; the public key is the bearer credential |
| **D6** | Error capture via **`window.onerror` + `unhandledrejection`** (chained, never swallow) | The web-native fatal-signal sources; coexist with host handlers |
| **D7** | **Auth scopes are server-only** — the SDK sends just the key | No client-trusted scopes |
| **D8** | Batch wire format = **envelope + shared context + `sent_at`**, gzipped, per-event `event_id` | The shared §7.5 contract — identical to Android |
| **D9** | Paid-feature gating is **server-side via `GET /v1/config`** | Entitlements by plan, not client flags |
| **D10** | Public keys are hardened with **origin binding**: each key carries an allowlist of registered web origins; the browser-sent `Origin` is enforced server-side (enforce-if-configured), backed by CORS | The web analog of Android's app-identity binding — a public key lifted onto another origin is rejected |
| **D11** | Distribution is **private & licensed** (not free): a **private scoped package** installed with a subscription-tied token, plus a **runtime plan gate** that degrades to no-op if the plan is inactive | This is a commercial library; access is controlled at install time and reinforced at runtime |

> **D10 vs Android:** Android binds a public key to `{package_name, signing_cert_sha256}`.
> The browser has no signing cert, but it *does* send an unforgeable-by-page `Origin`
> header on cross-origin requests, and the backend already supports an enforce-if-
> configured allowlist. So the web binding is `{origin}` — same server mechanism, web-
> appropriate identity.

> **D11 vs Android:** Android publishes publicly to Maven Central (free to install) and
> gates features server-side. The web library adds a **distribution** restriction on top:
> it is a private package requiring a licensed token to install, and the runtime plan
> gate means an unlicensed/inactive key yields a no-op SDK. See
> [`04-security-and-licensing`](./04-security-and-licensing.md).

## 1.6 Relationship to the other workstreams

- **Contract:** identical to `backend/docs/07` §7.5 and the Android SDK — one backend,
  three clients (Android, iOS-later, Web).
- **Backend deployment:** real-endpoint phases depend on
  [`backend/docs/08`](../../backend/docs/08-backend-api-deployment.md) (staging → prod).
- **Release cadence:** paced to ship alongside `android/docs/11` so web + mobile GA
  together.
