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
      "user": { "id": "u_123", "is_anonymous": false },
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
  "page": "/checkout",                     // path only; query redacted
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
  "headers": { "content-type": "application/json" } }   // allowlisted + redacted

// exception (uncaught error / rejection / recordException)
{ "exception_class": "TypeError",
  "message": "redacted-by-default",
  "stacktrace": [ { "class": "…", "method": "…", "file": "app.js", "line": 42, "column": 8 } ],
  "handled": false,
  "page": "/checkout" }

// heartbeat
{ "session_id": "uuid", "visible": true }
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
