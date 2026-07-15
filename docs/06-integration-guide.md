# 6. Web SDK — Integration Guide

> How to install and integrate `@codeskop/tracker`. The package is **public and free
> to install** (D11, revised 2026-07-15) — the only thing gating real capture is an
> active Codeskop plan's public key, checked server-side. See
> [`docs/04-security-and-licensing.md`](./04-security-and-licensing.md) §4.6.
>
> Verified against what is actually built as of Workflow Phase 15 (walked as a new
> developer integrating today, against `src/`, `react/src/`, and the real `dist/`
> output — not just against the docs' own prior wording). See
> [`06 revision note`](#69-revision-note-phase-15) for exactly what changed and why.

## 6.1 Prerequisites

- An active Codeskop subscription and a **public ingest key** (`cs_*_pk_…`) from the
  dashboard. Without one (or with an inactive plan), the SDK installs and initializes
  but never captures or sends anything — see §4.6's runtime plan gate.
- **Not required:** any npm token or `.npmrc` entry — the package is public.
- **Not required today:** a registered web origin. Origin *binding* (D10) is designed
  but **not implemented server-side yet** — there is no allowlist field, no API/dashboard
  way to set one, and no enforcement in the backend (confirmed against
  `backend/apps/accounts/models.py` and `backend/apps/ingest/cors.py` as of Phase 11).
  Practically: your key works from any origin today; do not rely on origin binding as a
  security boundary until this ships. See §6.7 for what CORS behavior to actually expect
  in the meantime.

## 6.2 Install

`@codeskop/tracker` (and `-react`) are published to the **public npm registry** under
the `@codeskop` scope — no token, no `.npmrc` entry, no org membership required.

```bash
npm install @codeskop/tracker
```

## 6.3 Initialize (vanilla)

Call `init` as early as possible (e.g. top of your entry module) so capture starts before
your app code runs:

```ts
import { init } from "@codeskop/tracker";

init({
  apiKey: "cs_live_pk_…",
  release: import.meta.env.VITE_APP_VERSION,
});
```

That's it — uncaught errors, unhandled rejections, and `fetch`/XHR failures + latency are
now captured and delivered. Identify the user after login:

```ts
import { identify, reset } from "@codeskop/tracker";
onLogin((u) => identify(u.id, { plan: u.plan }));
onLogout(() => reset());
```

## 6.4 React (`@codeskop/tracker-react`)

Requires `react`/`react-dom` `^18.0.0 || ^19.0.0` (peer dependency — the vanilla core
stays dependency-free; only this adapter package pulls in React). Install it alongside
the core:

```bash
npm install @codeskop/tracker @codeskop/tracker-react
```

```tsx
import { createRoot } from "react-dom/client";
import { CodeskopProvider, CodeskopErrorBoundary } from "@codeskop/tracker-react";

createRoot(el).render(
  <CodeskopProvider config={{ apiKey: "cs_live_pk_…" }}>
    <CodeskopErrorBoundary fallback={<Oops />}>
      <App />
    </CodeskopErrorBoundary>
  </CodeskopProvider>,
);
```

`CodeskopProvider` calls `init(config)` exactly once, on mount — it captures whatever
`config` object was passed on the **first** render and never re-runs `init()` on a later
re-render, even if you pass a fresh inline `config={{ ... }}` literal every time. If you
need to change config at runtime, call `init()` yourself (re-exported from
`@codeskop/tracker`) rather than expecting the provider to react to a prop change.

`CodeskopErrorBoundary` catches render errors in its subtree (React error boundaries
cannot catch errors from event handlers, async code, or `useEffect` — call
`recordException` yourself in a `try/catch` for those, exactly as you would in vanilla
code) and reports them via `recordException(error, { source: 'react-error-boundary',
componentStack })`. `fallback` accepts either a fixed node or a
`(error, reset) => node` function for a "try again" affordance; an optional `onError`
prop runs alongside the report for your own logging.

Inside any component (with or without a `CodeskopProvider` above it — every function
below is already a safe no-op before `init()` has run anywhere in the tree):

```tsx
import { useCodeskop } from "@codeskop/tracker-react";

function Profile() {
  const { recordException, identify, reset, setEnabled, flush } = useCodeskop();
  // ...
}
```

SSR frameworks (Next.js, Remix, etc.): the provider is SSR-safe by construction —
`init()` only ever runs inside `useEffect`, which never executes during a server
render, so no `typeof window` guard is needed in your own code either.

## 6.5 CDN / script-tag embed

**Current state, please read before relying on this:** the SDK supports **auto-init
from a `<script>` tag's `data-codeskop-*` attributes** (this part is real, built, and
tested — Workflow Phase 4) — but there is **no hosted, versioned CDN build
(`cdn.codeskop.com` or similar) and no Subresource-Integrity-hashed bundle published
today**. `docs/04` §4.7 correctly frames this as "optional SRI for any **licensed CDN
build**" — i.e. a future artifact, not a shipped one. If you see the `data-codeskop-key`
pattern referenced elsewhere (this doc previously showed a live-looking
`cdn.codeskop.com` URL — that was aspirational, not shipped, and has been corrected
here), treat it as **planned, not available**.

What auto-init actually needs once a build like this exists: the SDK's own `<script>`
tag carrying a `data-codeskop-key` attribute (optionally `data-codeskop-endpoint`,
`data-codeskop-release`, `data-codeskop-environment`) is enough to self-initialize with
no application JS — `src/core/scriptConfig.ts` reads `document.currentScript` (falling
back to the first matching `script[data-codeskop-key]` for module-script embeds where
`currentScript` is `null`). What's missing today is purely the **distribution**
mechanism: the build currently ships only ESM (`dist/index.js`) + CJS
(`dist/index.cjs`) via **npm**, not a self-contained classic-`<script>`/IIFE bundle
suitable for hosting on a CDN. Until that ships:

- **No-bundler customers today:** there is no supported no-bundler path. Use the npm
  install (§6.2) with a bundler, or wait for the CDN build.
- **If you must self-host a temporary script-tag build:** `dist/index.js` is a plain ES
  module, so `<script type="module" src="/your/copy/of/dist/index.js"
  data-codeskop-key="cs_live_pk_…"></script>` (served from your own origin, module
  scripts don't support `crossorigin`+SRI the same way classic scripts do) will run the
  same auto-init path — this is not an officially distributed artifact, and you take on
  keeping it updated yourself.

## 6.6 Staging vs production

Point pre-production builds at the staging ingest endpoint (see
[`backend/docs/08`](../../backend/docs/08-backend-api-deployment.md)) with a `cs_test_pk_`
key:

```ts
init({
  apiKey: "cs_test_pk_…",
  endpoint: "https://staging.api.codeskop.com",
});
```

## 6.7 Troubleshooting

A quick table for the most common issues; see
[`11-troubleshooting-faq.md`](./11-troubleshooting-faq.md) for the full FAQ ("no events
showing up" broken down by root cause, redaction config, and React-specific gotchas).

| Symptom | Likely cause |
|---------|--------------|
| SDK initializes but nothing arrives | Missing/invalid key, key is a `cs_*_sk_` (rejected fail-soft), plan inactive/unlicensed (`enabled:false` → no-op), or the event was sampled out — §11.2 |
| Events missing on the dashboard | Kill-switch is tripped (`enabled:false`) — note this is only re-checked on the **next page load/`init()`**, not live in an already-open tab, see §11.2 — or the feature is gated off for your plan |
| CORS error on ingest | **Not** an origin-allowlist rejection today — that mechanism isn't implemented server-side yet (§6.1). Check for an ad-blocker/privacy extension, a restrictive CSP `connect-src`, or a genuinely unreachable `endpoint` instead — §11.2 |
| No timing breakdown, only `duration_ms` | The API server didn't send `Timing-Allow-Origin` |
| Error messages arrive as a fixed placeholder, not the real text | Expected — error-message redaction is unconditional today, there is no config field to opt out (§11.3) |

## 6.8 Privacy notes

Metadata-first by default: request/response **bodies are never captured** (there is no
opt-in for this — an earlier draft of this doc and of `docs/04` described bodies as
"opt-in", but the config field for that was removed before the Phase 13 API freeze,
see `docs/08-security-privacy-audit.md` §8.6 — bodies are simply never captured, full
stop). `Authorization`/`Cookie` headers are never captured; URL query strings are
always dropped entirely (not selectively masked — there is no `redactQueryKeys`-style
option either, same §8.6 history); error messages are redacted unconditionally (§11.3
has the exact default and why there's no per-call opt-out today). See
[`04-security-and-licensing`](./04-security-and-licensing.md).

## 6.9 Revision note (Phase 15)

This doc was walked end-to-end against the actual built code (not just re-read) as
part of Workflow Phase 15 and corrected where it had drifted:

- §6.1/§6.7: removed claims that origin binding (D10) is enforced — it is designed
  (`docs/04` §4.3) but has no server-side implementation as of the Phase 11 finding
  (no `allowed_origins` field, no way to configure one, no CORS/auth enforcement of it).
  A "CORS error" today has a different real cause; the table now says so.
- §6.4: expanded with the parts a new integrator actually hits first — the peer-dep
  install line, `CodeskopProvider`'s "config read once at mount" behavior, error
  boundaries' documented React limitation (no event-handler/effect coverage), and
  `useCodeskop()` with no provider.
  All checked directly against `react/src/CodeskopProvider.tsx`,
  `react/src/CodeskopErrorBoundary.tsx`, and `react/src/useCodeskop.ts` — this section
  was already accurate on the parts it covered, just thin.
- §6.5: this was the most stale section — it presented a live-looking
  `cdn.codeskop.com/tracker/1.0.0/...` URL with a real-looking SRI hash. **No such
  build or hosting exists.** `tsup.config.ts` only emits `esm`/`cjs`
  (`format: ['esm', 'cjs']`) — no `iife`/`umd` target — and there is no CDN deployment
  anywhere in this repo or its CI. What *is* real and tested is the `data-codeskop-key`
  auto-init mechanism itself (Phase 4, `src/core/scriptConfig.ts`); the section now says
  exactly that and nothing more.
- §6.8: removed the "opt into richer capture explicitly" line — there is no such opt-in
  (`docs/08-security-privacy-audit.md` §8.6 — the two config fields that would have
  provided it, `captureBodies` and `redactQueryKeys`, were removed before the API
  freeze because neither was ever wired to real behavior).

**2026-07-15 update (D11 reversed):** distribution changed from private/token-gated to
public npm (MIT). §6.1/§6.2 rewritten to drop the install-token prerequisite and the
`.npmrc` snippet — `npm install @codeskop/tracker` now needs nothing but the registry
default. The runtime plan gate (§4.6) is unchanged and is now the *only* restriction;
see `docs/04-security-and-licensing.md` §4.6 and `web-sdk-workflow.md` Phase 14 for the
full rationale.
