# 5. Web SDK — API Reference

> The public surface of `@codeskop/tracker`. Frozen in Workflow Phase 13 and SemVer'd
> thereafter; everything not listed here is internal and may change.

## 5.1 `init(config)`

Initialize once. Returns immediately; all I/O is deferred. Safe to call before the DOM
is ready. A non-public key (`cs_*_sk_…` or malformed) disables the SDK fail-soft.

```ts
import { init } from "@codeskop/tracker";

init({
  apiKey: "cs_live_pk_…",              // public ingest key (required)
  endpoint: "https://api.codeskop.com", // default; staging swaps this
  release: "3.4.1",                     // optional host app/release version
  environment: "production",            // optional
  captureNetwork: true,                 // fetch/XHR instrumentation (default true)
  captureErrors: true,                  // window error + unhandledrejection (default true)
  captureExceptionMessages: false,      // send error messages instead of [REDACTED] (default false)
  capturePageViews: true,               // a screen event per page/route (default true)
  autocapture: { clicks: true },        // $click events where the plan allows (default on)
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
| `environment` | `string` | `"production"` | Free-form tag, sent as `context.app.environment` |
| `captureNetwork` | `boolean` | `true` | Instrument `fetch`/XHR |
| `captureErrors` | `boolean` | `true` | `error` + `unhandledrejection` handlers |
| `captureExceptionMessages` | `boolean` | `false` | Send exception messages as-is instead of `[REDACTED]` (all capture paths, including `recordException`). Messages can contain user data; opt in only when yours are safe to collect. Resource-load errors keep the URL without its query string |
| `capturePageViews` | `boolean` | `true` | A `screen` event for the first page and every in-app navigation |
| `autocapture.clicks` | `boolean` | `true` | `$click` events. Only sent when the remote config's `autocapture.clicks` is also true (plans with product analytics, project setting on). `false` turns them off whatever the remote config says |
| `redactHeaders` | `string[]` | `["authorization","cookie"]` | Always-redacted header names |
| `sampleRates` | `Record<string, number>` | `{}` | Client seed; remote config wins |
| `maxQueueMb` | `number` | `5` | Local queue byte cap; remote config wins |

## 5.3 Methods

```ts
identify(userId: string, traits?: Record<string, unknown>): void
```
Associate subsequent events with a stable logical user. Repeating the same `userId` is
intentional (the backend updates, never creates a new user). Traits are redacted.

The first time a browser's anonymous id is linked to a user (and whenever traits are
passed), an `identify` event is sent. It carries the anonymous id from before login, which
is how the backend links what the user did before signing in (`backend/docs/11` §11.5).

```ts
reset(): void
```
Clear the current user (on logout) and start a new anonymous id, so the next person on a
shared device isn't merged into this one. The install ID persists.

```ts
track(name: string, properties?: Record<string, unknown>, options?: { category?: TrackCategory }): void
```
Product analytics: a custom event. `category` is one of `lifecycle`, `navigation`,
`interaction`, `identity` or `conversion`. Without it, the server works one out from the
name (`login_`, `signup_`, `logout`, `password_`, `mfa_` and `otp_` names are identity,
everything else is conversion). An unknown category is left out with a console warning,
and the event is still sent. Names starting with `$` are reserved for the SDK's own
events and are dropped, like an empty name.

```ts
screen(name: string, properties?: Record<string, unknown>): void
```
Product analytics: a screen or page view (pages are captured automatically unless
`capturePageViews: false`). The SDK adds `previous_screen`, and on the first screen of a
page load the `referrer` (origin and path only) and `load_ms`.

```ts
recordException(error: unknown, attributes?: Record<string, unknown>): void
```
Report a handled error the app caught itself (the only *active* capture path).
`attributes` are sent with the error (scalars and lists of scalars; nested objects are
dropped), and the server masks sensitive values as it does for every event.

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

## 5.5 React adapter (`@codeskop/tracker-react`)

```tsx
import { CodeskopProvider, CodeskopErrorBoundary, useCodeskop } from "@codeskop/tracker-react";

<CodeskopProvider config={{ apiKey: "cs_live_pk_…" }}>
  <CodeskopErrorBoundary fallback={<Oops />}>
    <App />
  </CodeskopErrorBoundary>
</CodeskopProvider>;

// inside a component:
const { recordException, identify, track } = useCodeskop();
track("filter_applied", { filter: "price" }, { category: "interaction" });
```

The boundary reports render errors as `exception` events; the provider wires `init` on
the client (SSR-safe — no `window` access on the server).

## 5.6 Automatic events (events v2, 1.5.0)

The SDK sends these by itself. Their names start with `$`, which `track` doesn't accept,
so they never clash with yours.

| Event | Category | Properties | When |
|-------|----------|------------|------|
| `$app_opened` | lifecycle | `launch_type` (`cold` on the first load in a tab, `warm` after), `load_ms` | Once per page load |
| `$session_started` | lifecycle | `launch_type` | A new session begins |
| `$session_ended` | lifecycle | `duration_s`, `screens`, `end_reason` (`inactive`, `closed`) | 30 minutes idle (noticed at the next event), or the tab closes |
| `$app_backgrounded` | lifecycle | `screen` | The tab is hidden |
| `$app_foregrounded` | lifecycle | `background_s` | The tab is shown again |
| `$deep_link_opened` | navigation | `url` (path and `utm_` parameters only), `source` (`utm_source`, else the referrer's host) | A page load from another site or with `utm_` parameters |
| `$click` | interaction | `element` (`button`, `link`), `label` (visible text or `aria-label`, max 64 characters, never an input's value), `element_id`, `screen` | A click on a button, link, `[role=button]` or submit/button input |

- **Plans:** lifecycle events are free and sent on every plan, even without product
  analytics, and are never sampled. `$deep_link_opened` and `$click` are analytics events,
  gated like `track`.
- **Sessions:** a session spans page loads in a tab and ends after 30 minutes without
  activity. Every event (errors, API calls and heartbeats too) carries `session_id` and a
  per-session `seq`. A tab close is told apart from a navigation inside the site: a page
  kept in the back/forward cache, or a same-origin link or form submit just before, keeps
  the session going.
- **Clicks:** add `data-codeskop-ignore` to an element (or any ancestor) to skip it.

## 5.7 Script-tag attributes

| Attribute | Notes |
|-----------|-------|
| `data-codeskop-key` | The public key (required for auto-init) |
| `data-codeskop-user-id` | The signed-in user's id, rendered by your server |
| `data-codeskop-endpoint`, `data-codeskop-release`, `data-codeskop-environment` | Same as the `init` options |
| `data-codeskop-network="false"`, `data-codeskop-errors="false"`, `data-codeskop-page-views="false"` | Turn off a capture |
| `data-codeskop-exception-messages="true"` | Send exception messages (`captureExceptionMessages: true`) |
| `data-autocapture-clicks="false"` | Turn off `$click` (`data-codeskop-autocapture-clicks="false"` works too) |
