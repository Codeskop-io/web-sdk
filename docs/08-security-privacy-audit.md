# 8. Security & Privacy Audit (Workflow Phase 13)

> Code-level audit of the four guarantees `docs/04-security-and-licensing.md` §4.2/§4.4/§4.5
> claims. Each item traces the **actual runtime path** — capture → queue → transport —
> not just the unit test for the primitive in isolation. Evidence is exact file/line.
> Run against `development` at the commit where Phases 0–12 are complete, Phase 11 in
> progress.

## Summary

| # | Item | Verdict |
|---|------|---------|
| 1 | Secret key (`cs_*_sk_…`) rejected at every entry point, never on the wire | **PASS** |
| 2 | Redaction applied end-to-end (headers, query, messages, traits) | **PASS** |
| 3 | No PII leaves by default; `captureBodies` defaults `false` and is honored everywhere | **PASS** |
| 4 | SDK never throws into the host page | **PASS** |

No functional gap was found in any of the four items; nothing in this module needed a
code fix. One documentation-accuracy note is flagged at the end (§8.6) — it is not a
security or privacy defect and no code was changed for it.

---

## 8.1 Secret key rejection (item 1)

**Claim (`docs/04` §4.2):** the SDK authenticates with the public key only; a
`cs_*_sk_…` secret key (or anything malformed) is rejected fail-soft at `init` and is
never sent on the wire.

**Trace:**

- `validateApiKey` (`src/core/identity.ts:135-152`) checks the secret pattern
  `^cs_[a-z0-9]+_sk_/i` (`identity.ts:118`) **before** the public-key shape check
  (`identity.ts:117-121,140-145`), so a secret key is reported as `reason: 'secret_key'`
  distinctly from `'malformed'`. The whole function is wrapped in its own `try/catch`
  (`identity.ts:136,147-151`) so it cannot itself throw regardless of input shape.
- The **only** call site is `facade.ts`'s `init` (`src/facade.ts:42-51`):
  ```
  const validation = validateApiKey(config.apiKey);
  setActiveClient(undefined);
  if (!validation.valid) return;         // facade.ts:45-49
  setActiveClient(new CodeskopClient(config));
  ```
  A rejected key means `setActiveClient(undefined)` runs and `CodeskopClient` is
  **never constructed** — so `FetchTransport`, `BeaconTransport`, and
  `RemoteConfigClient` (the only three places `config.apiKey` is read —
  `runtime/client.ts:123-131`) are never instantiated with the bad key. No request of
  any kind is possible; the SDK is inert.
- Auto-init (`facade.ts:59-65`) reads `data-codeskop-key` off the script tag
  (`src/core/scriptConfig.ts:41-44`) and calls the same `init()` — the identical gate
  applies, there is no second, weaker code path.
- Every place `apiKey` subsequently touches a request sends only the validated string,
  never scopes or anything client-declared: `FetchTransport.attempt`
  (`src/transport/fetchTransport.ts:95-96`, `Authorization: Bearer <apiKey>`),
  `BeaconTransport.sendViaBeacon`/`sendViaFetchFallback`
  (`src/transport/beaconTransport.ts:97,108`), and `RemoteConfigClient`
  (`src/config/remoteConfigClient.ts:102`, `Authorization: Bearer <apiKey>`). Grepping
  every `apiKey` occurrence in `src/` (excluding tests) confirms these three transport
  call sites plus `validateApiKey`/`scriptConfig` are the complete set — there is no
  logging, diagnostic, or cache path that touches it.
- Note (not a defect): the beacon path additionally carries the key as
  `?key=<apiKey>` on the URL (`beaconTransport.ts:97`) because `sendBeacon` cannot set
  custom headers — this is the **public** key only (already gated by the same
  `validateApiKey` check above), and the module doc (`beaconTransport.ts:12-18`)
  documents it as a known, intentional constraint of the Beacon API, not a leak of
  anything secret.

**Verdict: PASS.** A secret or malformed key never reaches a client construction, and
every wire-touching call site sends only the pre-validated public key.

## 8.2 Redaction end-to-end (item 2)

**Claim (`docs/04` §4.4):** headers, query strings, error messages, and `identify`
traits are redacted before anything downstream sees them.

**Headers** — `src/core/redaction.ts:35-53`'s `redactHeaders` is allowlist-based
(`HEADER_ALLOWLIST`, `redaction.ts:8-14`) with `authorization`/`cookie` dropped as a
backstop even if the allowlist were loosened (`redaction.ts:41,47`). Traced to its only
two call sites, both in `NetworkCapture`, both applied **before** the payload is handed
to `emit()` (i.e. before it ever reaches the queue):
- `network.ts:382` — `onFetchResponse`, building `NetworkEventBase.headers` from the
  real `fetch` `Response`.
- `network.ts:480` — `onXhrLoadEnd`, same for XHR (`parseXhrHeaders(xhr.getAllResponseHeaders())`).

Both pass `this.redactHeaderNames`, which is threaded from `CodeskopConfig.redactHeaders`
through `runtime/client.ts:157` into `NetworkCapture`'s constructor
(`network.ts:293-295`), confirming the config knob actually reaches the redaction call,
not just the default.

**Query strings** — `src/core/redaction.ts:73-84`'s `redactUrl` reduces any URL to
`{host, path}` and **unconditionally drops the query string and fragment** — stronger
than key-by-key masking, so a misconfigured/incomplete `redactQueryKeys` list can never
leak a secret through (this is deliberate per `redaction.ts:65-67`). Traced to every
call site: `network.ts:294` (computing `ingestHost` to exclude self-instrumentation),
`361,372,393,442,467` — every place a captured request's URL is turned into an event
field goes through `redactUrl`; there is no other path in `network.ts` that reads
`capture.absoluteUrl`/`state.absoluteUrl` directly into a payload. `context.ts` (device/
app context) independently only ever reads `window.location.pathname`
(`core/context.ts:73`) — never `.href`/`.search`/cookies — so no raw query string
enters an event from that path either.

**Error messages** — `src/core/redaction.ts:96-98`'s `redactErrorMessage` defaults to
the `[REDACTED]` placeholder unless called with `{ raw: true }`. Traced every call site
in `src/capture/errors.ts` (the only consumer): `errors.ts:119,127` (`toExceptionPayload`,
the `Error`/non-`Error` normalizer used by both the `window` `'error'` handler and
`'unhandledrejection'`), `errors.ts:143` (resource-load failures), `errors.ts:162`
(fallback for a sanitized cross-origin "Script error."). **None of the four call sites,
nor any caller of `toExceptionPayload` (`errors.ts:153,205,245`), ever passes
`{ raw: true }`** — grepped for `raw: true`/`RedactErrorMessageOptions` construction
across `src/` and found none outside the type/function definitions. So today every
exception message — including the React `CodeskopErrorBoundary`'s `componentDidCatch`
path (`react/src/CodeskopErrorBoundary.tsx:49-56`, which calls `recordException`) — is
redacted with **no reachable opt-out** in the current public API. That's stricter than
the doc's "redacted by default" phrasing implies (which suggests an override exists);
functionally it means messages cannot leak under any current call pattern.

**`identify` traits** — `IdentityManager.identify()` stores `traits` on the instance
(`src/core/identity.ts:66-70`) purely for local/diagnostic use. `currentUserRef()`
(`identity.ts:91-96`), the only method that produces wire data, returns a `UserRef`
(`src/model/types.ts` — `{id, is_anonymous}`), which **has no traits field at all** — so
traits are excluded by the shape of the wire type, not by a redaction step that could be
bypassed. `snapshot()` (`identity.ts:99-101`) exposes traits only for tests/diagnostics
and is not part of the public facade (`facade.ts` never calls or re-exports it).

**Verdict: PASS.** Every redaction primitive is reached on the real capture→emit path,
not just exercised in isolation; the query-string and traits guarantees are structurally
stronger than key-masking (whole-query drop; no wire field to leak into, respectively).

## 8.3 No PII by default; `captureBodies` (item 3)

**Claim (`docs/04` §4.4, `docs/05` §5.2):** `captureBodies` defaults to `false`
(opt-in), and no body content leaves by default.

**Trace:** `CodeskopConfig.captureBodies` is declared (`src/model/types.ts:200`), but
grepping all of `src/` and `react/src/` (excluding tests) for `captureBodies` finds
**zero readers** of that field anywhere in the runtime — `runtime/client.ts` never
passes it to `NetworkCapture`, and `NetworkCapture` has no branch that would read it.
Consistent with this, `network.ts`'s own module doc is explicit: *"Only sizes are
measured for request/response bodies... actual body content is a separate, opt-in
capability this phase doesn't implement"* (`network.ts:25-27`). `measureBodySize()`
(`network.ts:186-195`) returns only a byte count (`string`/`Blob`/`ArrayBuffer`/typed-
array/`URLSearchParams` length), never the content, and a `Request` object's body is
explicitly left unmeasured rather than read (`network.ts:363-365`, to avoid consuming
the stream). There is no code path anywhere in this module set that reads response or
request body **content** into an event.

Net effect: `captureBodies` defaulting to `false` is not just honored, it is currently
unenforceable to violate — there is no capture path a caller could opt into that would
place body content on the wire, whatever value the flag is set to. This exceeds the
"no PII leaves by default" bar; see the one accuracy note in §8.6.

**Verdict: PASS.**

## 8.4 Never throws into the host page (item 4)

**Claim (`docs/04` §4.5, D4):** every entrypoint/hook runs inside `safely()`; a defect
becomes a dropped event + diagnostic, never a page error.

**Trace:** `safely()` (`src/core/safely.ts:48-70`) wraps sync throws (`try/catch`,
`safely.ts:56-68`) and async rejections (`result.catch(...)`, `safely.ts:58-62`) alike,
and additionally guards the diagnostic callback itself (`reportSafely`,
`safely.ts:24-30`) so a broken `onError` can't defeat the guard.

Every one of the six public exports from `src/index.ts:8-9` is confirmed wrapped:
- `init` — `facade.ts:42` (`safely((config) => {...}, {context:'init'})`)
- `identify` — `facade.ts:72`
- `reset` — `facade.ts:80`
- `setEnabled` — `facade.ts:92`
- `flush` — `facade.ts:109` is a thin, non-throwing wrapper (`.then()` only) around
  `guardedFlush`, which is itself `safely()`-wrapped at `facade.ts:97`
- `recordException` — `capture/errors.ts:243`

Every internal hook that touches host-triggered events is also wrapped: `ErrorCapture`'s
`handleError`/`handleRejection` (`errors.ts:195-208`), `NetworkCapture.start`/`stop`
(`network.ts:304,312`) and its per-call fetch/XHR instrumentation steps
(`network.ts:343,350-351,421,425,454,462`), and `CodeskopClient.emitEvent`/`dispose`
(`runtime/client.ts:171-190,193-198`). `autoInit()` (`facade.ts:59-63`) is wrapped too,
so a malformed `data-codeskop-*` attribute set can't throw during module evaluation.

Ran the scoped unit suites for this module set (`identity`, `redaction`, `network`,
`errors`, `safely`, `facade`) — **115/115 tests pass**, including the existing
"never throws" assertions in `safely.test.ts` and the entrypoint tests in
`facade.test.ts`. No regression since these were last exercised.

**Verdict: PASS.**

## 8.5 Method

- Read `docs/04-security-and-licensing.md` in full before starting.
- For each item, started from the claim and worked *backwards* from the actual
  wire-touching call site (`Authorization` header construction, `emit()` calls,
  `queue.enqueue`) rather than starting from the unit test for the primitive.
- Grepped every occurrence of `apiKey`, `redactHeaders`/`redactUrl`/`redactErrorMessage`,
  and `captureBodies` across `src/` (excluding `*.test.ts`) to make sure no call site was
  missed.
- Ran only the scoped vitest files for this module set — no `npm install`, no full
  `npm test`/`npm run build` (concurrent work from other engineers in this repo).

## 8.6 Note (non-security; resolved at Phase 13 integration)

`CodeskopConfig.redactQueryKeys` and `CodeskopConfig.captureBodies` were declared and
documented (`docs/05-api-reference.md`) as configurable, but neither field had a reader
anywhere in the runtime (`redactUrl` already drops the whole query string
unconditionally regardless of `redactQueryKeys`'s value; nothing consumed
`captureBodies` at all, per §8.3). This was **safe** — stricter behavior than
documented, never weaker — but a customer setting either option got no observable
effect. Flagged at the time for whoever owns the Phase 13 API-freeze/API-report task (a
different, concurrent track in this phase) to either wire `redactQueryKeys` through
`redactUrl` for masking-in-addition-to-drop parity with the doc, or trim the unused
fields from the frozen surface.

**Resolved at the Phase 13 integration checkpoint**, before the API baseline was
committed: both fields were **removed** from `CodeskopConfig`
(`src/model/types.ts`), `docs/05-api-reference.md`'s config table/example, and the
now-orphaned `DEFAULT_REDACT_QUERY_KEYS` constant + its test assertion in
`src/core/redaction.ts`/`redaction.test.ts` (implementing "wire it up" instead would
have meant shipping an untested feature — real request/response body capture — into a
supposedly-frozen surface, the riskier of the two options this note offered). No
runtime behavior changed: the whole query string was already unconditionally dropped
before and after this edit, and body content was never captured before or after. The
frozen public surface now only lists config fields that actually do something.

## 8.7 Fixes applied

One, at Phase 13 integration (not during this audit's own pass — see §8.6): removed
the two no-op `CodeskopConfig` fields (`captureBodies`, `redactQueryKeys`) from the
public surface before it was frozen. No other fix — all four audited items already
held end-to-end in the actual code; no security or privacy defect was found in any of
them that warranted a change.
