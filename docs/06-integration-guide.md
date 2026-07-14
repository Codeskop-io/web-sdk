# 6. Web SDK — Integration Guide

> How a **licensed** customer installs and integrates `@codeskop/tracker`. Because the
> package is private (D11), installation requires a subscription-tied token.

## 6.1 Prerequisites

- An active Codeskop subscription and a **public ingest key** (`cs_*_pk_…`) from the
  dashboard.
- A **package install token** (issued from the dashboard; tied to your subscription).
- Your web **origin(s)** registered on the key's allowlist (e.g.
  `https://app.example.com`) — required once origin binding is enforced (D10).

## 6.2 Install (private registry + token)

`@codeskop/tracker` (and `-react`) are published to the `@codeskop` scope on the
**private npm registry** (`registry.npmjs.org`, restricted access) — the public npm
registry never carries these packages.

Add a project `.npmrc` (do **not** commit the token — inject it from an env var/CI secret):

```ini
# .npmrc
@codeskop:registry=https://registry.npmjs.org/
//registry.npmjs.org/:_authToken=${CODESKOP_TOKEN}
```

```bash
export CODESKOP_TOKEN=…   # from the dashboard; in CI use a secret
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

## 6.4 React

```tsx
import { CodeskopProvider, CodeskopErrorBoundary } from "@codeskop/tracker-react";

createRoot(el).render(
  <CodeskopProvider config={{ apiKey: "cs_live_pk_…" }}>
    <CodeskopErrorBoundary fallback={<Oops />}>
      <App />
    </CodeskopErrorBoundary>
  </CodeskopProvider>,
);
```

## 6.5 CDN (licensed builds)

A licensed, versioned CDN build with Subresource Integrity is available for no-bundler
setups:

```html
<script
  src="https://cdn.codeskop.com/tracker/1.0.0/codeskop.min.js"
  integrity="sha384-…"
  crossorigin="anonymous"
  data-codeskop-key="cs_live_pk_…"></script>
```

The `data-codeskop-key` attribute auto-initializes the SDK.

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

| Symptom | Likely cause |
|---------|--------------|
| `npm install` 401/403 | Missing/expired `CODESKOP_TOKEN`, or subscription inactive |
| SDK initializes but nothing arrives | Key is a `cs_*_sk_` (rejected fail-soft), plan inactive (no-op), or origin not on the allowlist (`403`) — check the browser network tab |
| Events missing on the dashboard | Config kill-switch is off (`enabled:false`), or the feature is gated off for your plan |
| CORS error on ingest | Your origin isn't registered on the key's allowlist (D10) |
| No timing breakdown, only `duration_ms` | The API server didn't send `Timing-Allow-Origin` |

## 6.8 Privacy notes

Metadata-first by default: no bodies, `Authorization`/`Cookie` never captured, URL query
strings dropped, error messages redacted. Opt into richer capture explicitly. See
[`04-security-and-licensing`](./04-security-and-licensing.md).
