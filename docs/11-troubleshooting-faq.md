# 11. Web SDK — Troubleshooting & FAQ

> Written in Workflow Phase 15 by walking the integration guide (`docs/06`) as a new
> licensed developer would, then tracing every "why isn't this working" question down
> to the actual code (`src/`, `react/src/`) and the actual backend behavior
> (`backend/apps/ingest/`, `backend/apps/accounts/`) rather than guessing. Every claim
> below cites the file it's verified against.

## 11.1 Install setup

**2026-07-15: `@codeskop-io/tracker` is a public, MIT-licensed npm package (D11 reversed —
see `docs/04` §4.6). `npm install @codeskop-io/tracker` needs no token, no `.npmrc`
entry, and no npm org membership.** If you're seeing an install-time 401/403, it isn't
this package gating access — check for a stale `.npmrc` scope override left over from
another private registry, or a corporate proxy/registry mirror intercepting the
`@codeskop-io` scope. Confirm the registry line, if any exists in your `.npmrc`, is exactly
`@codeskop-io:registry=https://registry.npmjs.org/` (or remove it entirely — the public
registry is the default).

If the package installs fine but the SDK never captures anything, that's the **runtime
plan gate**, not install access — see §11.2 below, it's almost always cause 1 or 2 there.

**`npm install` succeeds but `import { init } from "@codeskop-io/tracker"` doesn't resolve
(TypeScript can't find types, or the module fails to load).**

- Check your `package.json`'s installed version against `dist/`'s actual `exports` map
  (`package.json`'s `exports["."]` — ESM `dist/index.js`+`.d.ts`, CJS
  `dist/index.cjs`+`.d.cts`). A bundler/`moduleResolution` set to something older than
  `"bundler"`/`"node16"`/`"nodenext"` in `tsconfig.json` may not follow conditional
  exports correctly — this is a general TS/bundler compatibility issue, not
  SDK-specific.

## 11.2 "The SDK initializes but nothing arrives" — the four real causes, in the order to check them

The SDK never throws on a bad setup (`docs/05` §5.4) — a broken integration looks
**identical** to "everything's fine and there's just nothing to report" from the host
page's perspective. Check in this order (cheapest/most-likely first):

1. **Is the key actually a public key?** `validateApiKey` (`src/core/identity.ts`)
   rejects a secret key (`cs_*_sk_…`) or anything malformed **fail-soft** — `init()`
   silently does nothing, forever, no console error (`docs/05` §5.4, audited
   end-to-end in `docs/08-security-privacy-audit.md` §8.1). Double-check you copied the
   `pk` key, not the `sk` key, from the dashboard.

2. **Is the plan/environment actually enabled?** `GET /v1/config` folds in the
   kill-switch server-side (`backend/apps/ingest/config.py`'s `_is_enabled` — global
   ops switch **and** the per-environment `ingest_enabled` flag both have to be `true`).
   An inactive/unlicensed plan or a tripped kill-switch returns `enabled:false`, and the
   SDK genuinely captures and sends **nothing** — this is D11's runtime plan gate
   working as designed, not a bug. **Important timing detail:** the SDK only fetches
   `GET /v1/config` **once, when `init()` runs** (`src/runtime/client.ts`'s constructor
   calls `refreshRemoteConfig()` exactly once — there is no polling loop, no
   periodic re-fetch during a live page session). So if someone flips the kill-switch
   while your tab is already open, that tab keeps its old config until the **next**
   page load / next `init()` call — see the kill-switch drill
   (`web-sdk-workflow.md` Phase 15) for exactly how fast this actually propagates.

3. **Was the event sampled out?** `api_timing` events are sampled per
   `sampleRates`/remote config (errors are always kept at 100% — `docs/01`'s sampling
   policy) — a low `api_timing` sample rate on your plan tier can make network-timing
   events look like they're "missing" when they're just statistically rare. Use
   `recordException` (always 100% kept) to sanity-check the pipe end-to-end before
   worrying about `api_timing` specifically.

4. **Did the browser actually let the request through?** Check the Network tab for the
   `POST /v1/events` call itself:
   - **No request at all** — the queue never drained. Nothing calls `flush()`
     automatically until a sync trigger fires (batch-size threshold, the ~30s time
     window, `online`, or tab-hide — `src/runtime/syncScheduler.ts`); call
     `await flush()` yourself while debugging to force an immediate attempt, and check
     `queueSize()`-style introspection isn't needed — `flush()`'s resolved `true`/`false`
     already tells you whether an attempt ran.
   - **Request fires but fails/is blocked** — an ad-blocker or privacy extension
     blocking analytics-shaped URLs, a page `Content-Security-Policy` without your
     `endpoint` host in `connect-src`, or a genuinely wrong/unreachable `endpoint`
     value. **This is not an origin-allowlist rejection** — see the CORS entry below.
   - **Request reaches the endpoint's own domain but never fires at all because it's
     the ingest endpoint itself** — by design: the SDK never instruments requests to
     its own `endpoint` (no feedback loop, Phase 6) — if your app also happens to call
     the ingest host directly for something else, don't expect that call to show up as
     an `api_timing`/`api_error` event.

## 11.3 Redaction config — what's actually configurable today

Short version: **less than earlier drafts of this doc implied.** Verified against
`src/core/redaction.ts`, `src/model/types.ts`, and
`docs/08-security-privacy-audit.md` §8.6:

| What | Configurable? | Actual behavior |
|------|---------------|------------------|
| Request/response bodies | **No opt-in exists.** | Never captured, full stop. A `captureBodies` field existed pre-freeze but had no reader anywhere in the runtime and was **removed** before the Phase 13 API baseline (§8.6) — there was never a working opt-in to disable. |
| URL query strings | **No.** | Always dropped entirely (`redactUrl`, `src/core/redaction.ts`) — not masked key-by-key. A `redactQueryKeys` field existed pre-freeze, was likewise a no-op, and was removed at the same time for the same reason. |
| Request/response headers | **Yes** — `redactHeaders` (`CodeskopConfig`, default `["authorization","cookie"]`). | These names are **always redacted in addition to** the hardcoded `authorization`/`cookie`; header capture itself is allowlist-based (only specific headers are ever read), so this field narrows what's captured, it doesn't widen it. |
| Error/exception messages | **No per-call opt-out today.** | `redactErrorMessage` (`src/core/redaction.ts`) replaces the message with a fixed placeholder unless called with `{ raw: true }` — but no `CodeskopConfig` field threads a `raw: true` through from the public API, so in practice every message capture path (`capture/errors.ts`) always redacts. If you need real error text, use `recordException`'s `attributes` parameter to attach your own already-sanitized string instead of relying on the captured `message`. |
| `identify()` traits | Not selectively — traits are redacted the same way messages are. | Don't put anything you don't want leaving the browser into `traits`; there's no per-field allowlist for traits today. |

If you were expecting a config knob that isn't in the table above, it was likely
removed at the Phase 13 API freeze for being a documented-but-inert no-op — check
`docs/05-api-reference.md` §5.2 for the current, frozen `CodeskopConfig` shape; it's
the source of truth, not this FAQ or any other prose doc.

## 11.4 CORS errors

**Do not assume this is an origin-allowlist rejection** — as of this writing the
web-origin allowlist half of D10 has no backend implementation at all (`docs/04` §4.3's
status note, `web-sdk-workflow.md` Phase 11's exit-gate finding) — there is nothing to
register and nothing that rejects an unregistered origin server-side today. A real CORS
failure in the Network/Console tab today is one of:

- The `endpoint` you configured is wrong (typo, wrong environment) and isn't actually
  serving the ingest API at all.
- A browser extension or corporate proxy stripping/blocking cross-origin analytics
  calls.
- Your page's own `Content-Security-Policy` `connect-src` directive not listing the
  ingest host.

## 11.5 React-specific

- **A thrown error inside a click handler / `useEffect` / async callback isn't
  reported.** Expected — `CodeskopErrorBoundary` only catches errors thrown during
  **render** (a React limitation, not an SDK one). Wrap those call sites in your own
  `try/catch` and call `recordException` (via `useCodeskop()` or the direct import)
  yourself.
- **Changing the `config` prop on `CodeskopProvider` doesn't seem to do anything.**
  Expected — `config` is captured once via `useRef` on the first render specifically so
  a fresh inline object literal every re-render doesn't restart the SDK
  (`react/src/CodeskopProvider.tsx`). Call `init()` directly for a runtime config swap.
- **`useCodeskop()` "works" even with no `<CodeskopProvider>` anywhere in the tree —
  is that a bug?** No — by design. The context's default value is the same singleton
  facade functions the vanilla core exports, and every one of them is already a safe
  no-op before `init()` (`docs/05` §5.4). The provider's only job is calling `init()`;
  the hook works regardless.

## 11.6 Still stuck?

Confirm the exact behavior you're seeing against the actual test suite before assuming
it's a new bug — most of the above is covered by an existing, named test: secret-key
rejection (`src/core/identity.test.ts`), kill-switch (`src/runtime/client.test.ts`,
`src/config/featureGate.test.ts`), config fetch-once-per-init and fallback behavior
(`src/config/remoteConfigClient.test.ts`), redaction (`src/core/redaction.test.ts`),
and the React adapter (`react/src/*.test.tsx`).
