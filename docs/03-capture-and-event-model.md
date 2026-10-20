# 3. Web SDK — Capture & Event Model

> What the web SDK captures and the exact wire shape it produces. The wire contract is
> **identical** to the mobile SDK and backend
> ([`backend/docs/07` §7.5](../../backend/docs/07-mobile-sdk-ingest-readiness.md#75-the-locked-contract-build-to-this)) —
> the web SDK is a new producer of the same events.

## 3.1 Event taxonomy (web)

| `type` | Source | Default severity |
|--------|--------|------------------|
| `api_error` | `fetch`/XHR that fails (network) or returns ≥ 400 | high |
| `api_timing` | Every instrumented `fetch`/XHR call (latency breakdown) | low |
| `exception` | Uncaught `error` event, `unhandledrejection`, or `recordException(...)` | high |
| `heartbeat` | Emitted while the page is visible (presence, D2) | low |
| `track` | `track(...)`, and the SDK's own `$` events (§3.7) | low |
| `screen` | Each page / in-app route, and `screen(...)` | low |
| `identify` | `identify(...)`: traits, and the anonymous-id link (§3.7) | low |

> **Not applicable on web:** `crash`, `crash_native`, `anr` — these are mobile
> process/OS signals. A web "crash" is an uncaught JS error, captured as `exception`.
> The SDK simply never emits the mobile-only types; the backend already accepts the
> full set, so no contract change is needed.

## 3.2 The wire envelope (shared §7.5)

```jsonc
{
  "sent_at": "2026-07-01T12:00:00.123Z",        // batch send time → clock-skew correction
  "context": { "device": { … }, "app": { … } },  // per-page-load stable; sent once per batch
  "batch": [
    { "event_id": "uuidv7",                       // client dedup key
      "type": "exception",
      "occurred_at": "…", "severity": "high",
      "session_id": "sess_…",                     // 1.5.0+: every event type
      "seq": 12,                                  // 1.5.0+: per-session counter
      "user": { "id": "u_123",                    // only after identify()
                "anonymous_id": "a_…",            // 1.5.0+: always; new after reset()
                "is_anonymous": false },
      "payload": { … } }
  ]
}
```

Delivered gzipped to `POST /v1/events` with `Authorization: Bearer cs_*_pk_…`. Response
semantics are the contract's: `2xx` accept (SDK deletes), `4xx` permanent (drop), `5xx`/
network transient (retry), optional `{ "rejected": [...] }` for partial drops. Limits:
≤ 100 events/batch, ≤ 1 MB compressed, ≤ 64 KB/event.

## 3.3 Web `context`

The `device`/`app` objects are open (the backend tolerates extra fields); the web SDK
populates the browser-appropriate ones:

```jsonc
"device": {
  "install_id": "…",              // SDK-generated, persisted in localStorage
  "platform": "web",
  "user_agent": "…",              // or UA-Client-Hints where available
  "locale": "en-KE",
  "screen": "1920x1080",
  "viewport": "1280x720"
},
"app": {
  "origin": "https://app.customer.com",   // used for origin binding (D10)
  "page": "/checkout",                     // path only; query redacted; read when the batch is sent
  "environment": "production",              // CodeskopConfig.environment
  "referrer": "…",                          // redacted
  "release": "3.4.1",                       // host-supplied app/release version
  "sdk_version": "1.0.0"
}
```

`origin` mirrors the Android `app.package` role: it is also what the browser sends as
the `Origin` request header, which the backend matches against the key's allowed-origins
allowlist (D10).

## 3.4 Type-specific payloads

```jsonc
// api_error / api_timing
{ "method": "GET", "host": "api.customer.com", "path": "/checkout",
  "status": 503, "error_kind": "http_5xx",
  "duration_ms": 812, "request_bytes": 240, "response_bytes": 1180,
  "timing": { "dns": 12, "connect": 40, "tls": 180, "ttfb": 520, "total": 812 },
  "headers": { "content-type": "application/json" },    // allowlisted + redacted
  "page": "/checkout" }                                   // the page the call was made from

// exception (uncaught error / rejection / recordException)
{ "exception_class": "TypeError",
  "message": "redacted-by-default",
  "stacktrace": [ { "class": "…", "method": "…", "file": "app.js", "line": 42, "column": 8 } ],
  "handled": false,
  "page": "/checkout",
  "attributes": { "step": "payment" } }   // recordException only; optional

// heartbeat
{ "session_id": "uuid", "visible": true }

// track / screen
{ "name": "login_failed", "category": "identity",   // category: track only, optional
  "properties": { "reason": "invalid_password" }, "session_id": "sess_…" }
```

Timing comes from `PerformanceResourceTiming` where the server exposes the
`Timing-Allow-Origin` header; otherwise `duration_ms` is measured around the call and the
fine-grained phases are omitted.

## 3.5 Redaction (D3)

Applied before anything is queued:

- **Headers:** capture only an allowlist (`content-type`, `content-length`,
  `content-encoding`, `accept`, `cache-control`); `Authorization`/`Cookie` are never
  collected; any configured sensitive key is `[REDACTED]` as a backstop.
- **URLs:** the query string is **dropped** entirely (only `host` + `path` are kept), so
  query secrets never reach the payload.
- **Error messages:** redacted by default (they routinely embed user input/PII); opt-in
  to send raw.
- **Never instrument the ingest endpoint itself** (no capture feedback loop).

## 3.6 Fingerprinting (parity with the backend)

The backend computes the authoritative grouping fingerprint and never trusts a client
value, so the web SDK does **not** transmit one — but it can compute the identical recipe
(`backend/apps/processing/fingerprint.py`) for local grouping/diagnostics: templated URL
paths for API events (`/users/{id}`), and `exception_class` + a hash of the top package-
filtered stack frames for errors. Matching the recipe means client and server never
disagree about how a failure groups.

## 3.7 Events v2 (1.5.0)

The web side of [`backend/docs/11`](../../backend/docs/11-events-v2-contract.md), the
shared events v2 contract.

- **Session and order.** Every event carries a top-level `session_id` and `seq`. A
  session lives in `sessionStorage` (per tab), spans page loads, and ends after 30 minutes
  without activity (any event counts as activity). Payloads that have their own
  `session_id` (`heartbeat`, `track`, `screen`) carry the same value.
- **Anonymous id.** `user.anonymous_id` is created once, kept in `localStorage` next to
  the install id, sent on every event before and after `identify()`, and replaced by
  `reset()`. Anonymous events carry no `user.id`, so the backend can resolve them to the
  user who later logs in. The `identify` event that links them is sent the first time an
  anonymous id meets a user id (and whenever traits are passed), and carries the
  anonymous id from before login.
- **Categories.** `track(name, props, { category })` sends `payload.category`. An unknown
  category is left out with a console warning and the server derives one.
- **Lifecycle events** (`track`, category `lifecycle`, free on every plan, never
  sampled): `$app_opened` (`launch_type`, `load_ms` from navigation timing once the page
  has loaded), `$session_started` (`launch_type`), `$session_ended` (`duration_s`,
  `screens`, `end_reason`: `inactive` when the next event finds the session idle for 30
  minutes, dated at its last activity; `closed` on `pagehide`, sent by beacon straight
  away), `$app_backgrounded` (`screen`) and `$app_foregrounded` (`background_s`) from
  `visibilitychange`. A `pagehide` that is a navigation inside the site (back/forward
  cache, or a same-origin link or form submit within the last 5 seconds) does not end the
  session.
- **Navigation.** `screen` events add `previous_screen`, and the first one of a page load
  adds `referrer` (origin and path) and `load_ms`. `$deep_link_opened` is sent once per
  page load (not on reload or back/forward) when the referrer is another site or the URL
  has `utm_` parameters: `url` is the path plus `utm_` parameters only, `source` is
  `utm_source` or the referrer's host.
- **Clicks.** `$click` (category `interaction`) from one throttled, capture-phase
  `click` listener: buttons, links, `[role=button]` and `input[type=submit|button]` only;
  `element`, `label` (visible text, else `aria-label`, max 64 characters, never an
  input's value), `element_id`, `screen`. Sent only when the remote config's
  `autocapture.clicks` is true and `init({ autocapture: { clicks: false } })` /
  `data-autocapture-clicks="false"` hasn't turned it off. Anything inside
  `[data-codeskop-ignore]` is skipped.
