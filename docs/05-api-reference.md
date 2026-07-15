# 5. Web SDK — API Reference

> The public surface of `@codeskop-io/tracker`. Frozen in Workflow Phase 13 and SemVer'd
> thereafter; everything not listed here is internal and may change.

## 5.1 `init(config)`

Initialize once. Returns immediately; all I/O is deferred. Safe to call before the DOM
is ready. A non-public key (`cs_*_sk_…` or malformed) disables the SDK fail-soft.

```ts
import { init } from "@codeskop-io/tracker";

init({
  apiKey: "cs_live_pk_…",              // public ingest key (required)
  endpoint: "https://api.codeskop.com", // default; staging swaps this
  release: "3.4.1",                     // optional host app/release version
  environment: "production",            // optional
  captureNetwork: true,                 // fetch/XHR instrumentation (default true)
  captureErrors: true,                  // window error + unhandledrejection (default true)
  redactHeaders: ["authorization", "cookie"],
  sampleRates: { api_timing: 0.2 },     // overridden by remote config
});
```

## 5.2 `CodeskopConfig`

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `apiKey` | `string` | — | Public ingest key `cs_*_pk_…` (required) |
| `endpoint` | `string` | `https://api.codeskop.com` | Ingest base URL |
| `release` | `string?` | — | Host app version stamped into `context.app.release` |
| `environment` | `string` | `"production"` | Free-form tag |
| `captureNetwork` | `boolean` | `true` | Instrument `fetch`/XHR |
| `captureErrors` | `boolean` | `true` | `error` + `unhandledrejection` handlers |
| `redactHeaders` | `string[]` | `["authorization","cookie"]` | Always-redacted header names |
| `sampleRates` | `Record<string, number>` | `{}` | Client seed; remote config wins |
| `maxQueueMb` | `number` | `5` | Local queue byte cap; remote config wins |

## 5.3 Methods

```ts
identify(userId: string, traits?: Record<string, unknown>): void
```
Associate subsequent events with a stable logical user. Repeating the same `userId` is
intentional (the backend updates, never creates a new user). Traits are redacted.

```ts
reset(): void
```
Clear the current user (on logout). The install ID persists.

```ts
recordException(error: unknown, attributes?: Record<string, unknown>): void
```
Report a handled error the app caught itself (the only *active* capture path).

```ts
setEnabled(enabled: boolean): void
```
Local pause/resume of capture, independent of the remote kill-switch.

```ts
flush(): Promise<boolean>
```
Best-effort expedited drain of the queue. Resolves `true` if a sync ran.

## 5.4 Guarantees

- **Never throws** into the host page (every entrypoint is guarded).
- **Safe before `init`** — calls are no-ops until initialized.
- **Non-blocking** — no synchronous network or heavy work on the calling path.
- **No-op when unlicensed** — an inactive plan (remote `enabled:false`) means the API
  is callable but captures/sends nothing (D11).

## 5.5 React adapter (`@codeskop-io/tracker-react`)

```tsx
import { CodeskopProvider, CodeskopErrorBoundary, useCodeskop } from "@codeskop-io/tracker-react";

<CodeskopProvider config={{ apiKey: "cs_live_pk_…" }}>
  <CodeskopErrorBoundary fallback={<Oops />}>
    <App />
  </CodeskopErrorBoundary>
</CodeskopProvider>;

// inside a component:
const { recordException, identify } = useCodeskop();
```

The boundary reports render errors as `exception` events; the provider wires `init` on
the client (SSR-safe — no `window` access on the server).
