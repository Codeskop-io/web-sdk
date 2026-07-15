# 12. Web SDK — Health Telemetry Spec

> **Status: a spec, not a build.** This document defines what should be measured and
> exactly which already-built internal hooks would need to be wired to produce it. No
> metrics backend exists in this workspace (no dashboard, no alerting, no aggregation
> pipeline), and standing one up is explicitly **out of scope for this pass** — see
> §12.5. Nothing in `src/`/`react/src/` was changed to produce this document; it is a
> design against the code as it already stands.

## 12.1 Why these four metrics

`@codeskop-io/tracker` runs inside every customer's page, unsupervised, guarded by
`safely()` so a defect degrades to a dropped event rather than a broken host page
(`docs/04` §4.5). That guarantee is also exactly why the SDK's *own* health is
invisible from the outside today: a fault is swallowed silently by design. Without
health telemetry, "is the SDK actually working, in the field, right now, for real
customers" is answerable only by asking a customer or reading their dashboard's traffic
— both slow and both indirect. The four metrics below are the minimum set that would
let the Web SDK team answer that question directly, ranked by how directly each maps to
"is the pipe broken":

| # | Metric | Answers |
|---|--------|---------|
| 1 | **Ingest success rate** | Are captured events actually reaching the backend? |
| 2 | **Config-fetch success rate** | Is entitlement/kill-switch state current, or running on stale/default fallback? |
| 3 | **Queue-drop rate** | Is the local buffer overflowing (event loss before a network attempt even happens)? |
| 4 | **Self-error rate** | Is the SDK's own code throwing internally (even though those throws never reach the host page)? |

## 12.2 Definitions

### 1. Ingest success rate

`successful POST /v1/events attempts ÷ total POST /v1/events attempts`, per
install/session, rolled up per SDK version and per customer.

- **Numerator source:** `Transport.send(batch): Promise<TransportResult>`
  (`src/model/types.ts`) resolving with `{ retryable: false }` on a `2xx` or a
  permanent `4xx` (the *contract's* definition of "handled", not necessarily
  "delivered" — see the note below) — both `FetchTransport`
  (`src/transport/fetchTransport.ts`) and `BeaconTransport`
  (`src/transport/beaconTransport.ts`) already compute this per attempt.
- **Denominator source:** every call into `CodeskopClient.drainOnce`
  (`src/runtime/client.ts`) that reaches `transport.send(batch)`.
- **Caveat worth tracking as a sub-metric, not folding in silently:** a permanent `4xx`
  (bad batch, rejected by the backend) currently counts as "not retryable" the same as
  a `2xx` success in the queue's ack logic (`drainOnce`, `!result.retryable` → ack).
  That's the *correct* queue behavior (retrying a permanent rejection forever would
  wedge the queue), but it means "ingest success rate" as defined by queue-ack alone
  would silently include permanent rejections as if delivered. **Recommendation:**
  track `2xx` and permanent-`4xx` as two separate counters from day one
  (`result.status` is already on `TransportResult` per the wire contract's
  `{ rejected: [...] }` handling), not one blended "success" number, so a spike in
  silent `4xx`s (e.g. a bad envelope shape after a backend contract change) is visible
  instead of hidden inside an apparently-healthy ack rate.

### 2. Config-fetch success rate

`successful GET /v1/config responses ÷ total GET /v1/config attempts`, per session.

- **Source:** `RemoteConfigClient.fetchConfig()` (`src/config/remoteConfigClient.ts`)
  already distinguishes every failure mode internally — network error/no `fetch`
  (`requestConfig` returns `undefined`, `safely()`'s guard catches a thrown network
  error), non-2xx (`!response.ok` → `undefined`), and unparseable body
  (`parseRemoteConfig` returns `undefined`) — but today the *caller*
  (`CodeskopClient.refreshRemoteConfig`, `src/runtime/client.ts`) only observes the
  **final resolved value**, not which of those paths produced it. A `304 Not Modified`
  (cache-valid, `RemoteConfigClient.requestConfig`'s `response.status === 304` branch)
  should count as a **success**, not a failure — it's a correctly-working ETag
  round-trip, not a fetch failure.
- **Important context for interpreting this metric once wired:** `fetchConfig()` is
  called **exactly once per `CodeskopClient` construction** (`refreshRemoteConfig()` in
  the constructor, `src/runtime/client.ts`) — there is no periodic re-poll during a live
  session (see the kill-switch drill, `docs/13-operations-runbooks.md`, for why this
  matters operationally). So this metric is really "success rate of the one config
  fetch every page load performs," not a steady-state heartbeat of connectivity to the
  config endpoint.

### 3. Queue-drop rate

`events dropped by the durable queue ÷ events the queue attempted to enqueue`, per
session, split by **cause**: byte-cap eviction (drop-oldest) vs. a corrupt/
undeserializable record skipped on load.

- **Source (partially built, not yet counted):** `DurableQueue.enqueue`
  (`src/queue/durable-queue.ts`) already implements drop-oldest-under-cap with a
  reserved slice for critical (error) events (Phase 2) — the eviction *decision* exists
  in code (`evicted === null` early-return when an event can never fit its own budget;
  the drop-oldest loop above it), but there is no counter incremented anywhere when it
  happens — the event is silently discarded, matching the offline-durability design
  goal, not a metrics goal.
- **Also relevant:** a corrupt/undeserializable stored record is skipped and dropped
  during a queue load rather than wedging sync (Phase 2's resilience requirement,
  reported today only as a `queue.load`-context diagnostic via `onError`, not counted
  separately from "queue is healthy").

### 4. Self-error rate

`safely()`-guarded faults caught ÷ guarded-call attempts` (or, more simply to start,
just a raw **count** of faults per session/version — a rate needs a denominator that
doesn't exist cheaply today; see §12.4).

- **Source: this is the most-built of the four.** Every capture/runtime module already
  reports through a `DiagnosticHandler` (`src/core/safely.ts`'s `onError` type) with a
  string `context` tag identifying the call site:
  - `CodeskopClient`'s own `report()` (`src/runtime/client.ts`) is the funnel every
    other module's `onError` is wired into (`queue: onError: (error, context) =>
    this.report(error, context)`, same pattern for `configSource`) — contexts observed
    today include `client.emitEvent`, `client.dispose`, `client.flush`,
    `client.drain`, `client.notifyEnqueued`, `client.refreshRemoteConfig`,
    `queue.load`, `queue.enqueue`, `queue.ack`, `queue.close`, `config-fetch`.
  - Every public facade entrypoint (`init`, `identify`, `reset`, `setEnabled`, `flush`,
    `recordException`) is itself wrapped in its own `safely()` (`src/facade.ts`,
    `src/capture/errors.ts`) with its own `context` string, independent of
    `CodeskopClient.report`.
  - `report()` currently calls `this.onDiagnostic(error, context)`
    (`CodeskopClientOptions.onDiagnostic`) — **but `onDiagnostic` is a constructor-only
    dependency-injection seam used by tests today, not a field on the public
    `CodeskopConfig`** (`src/model/types.ts` has no such field, and `facade.ts`'s
    `init()` never passes one when constructing `CodeskopClient`). In production, every
    one of these diagnostics currently resolves to the default no-op
    (`this.onDiagnostic = options.onDiagnostic ?? (() => {})`) — **nothing is captured,
    logged, or observable anywhere today outside of tests that inject their own
    handler.** This is the single biggest gap in "wiring exists" vs. "wiring reaches
    anything" — see §12.4.

## 12.3 What "wiring to a metrics backend" would require

None of this is done; this is the shape of the work, for scoping a follow-up:

1. **A metrics-egress seam**, analogous to `ConfigSource`/`Transport` — something like
   a `HealthReporter` interface the client can call
   (`recordIngestAttempt(result)`, `recordConfigFetch(outcome)`,
   `recordQueueDrop(cause)`, `recordFault(context)`), injected the same way `queue`/
   `fetchTransport`/`configSource` already are (`CodeskopClientOptions`).
2. **A decision on transport for the health signal itself**, with real tradeoffs, not
   an obvious default:
   - Riding the existing `POST /v1/events` pipe as a new low-severity event type is the
     path of least new infrastructure (reuses the queue, batching, retry, and
     kill-switch-respecting behavior for free) but couples SDK self-health to the same
     pipe being measured — if ingest itself is down, health data about "ingest is down"
     can't be delivered either, though a durable queue at least means it arrives once
     connectivity returns.
   - A wholly separate lightweight beacon (e.g. always `sendBeacon`, fire-and-forget,
     no retry) avoids that coupling and is closer to what a true "is the pipe up"
     signal wants, at the cost of a second wire contract to design, freeze, and version
     (a new cross-repo decision, `backend/docs/07`-adjacent).
   - Either choice needs its own **sampling policy** — sending a health event per
     capture attempt would multiply outbound traffic; something like "one rolled-up
     health summary per sync cycle" (counts since last report, not one event each) is
     the shape that scales, mirroring how the presence heartbeat (Phase 9) already
     rides the batch rather than opening anything new.
3. **`onDiagnostic` needs to actually be reachable from `CodeskopConfig`** (or a new
   config field serving the same purpose) before self-error rate can be anything other
   than "whatever a test harness injects" — today there is no production code path that
   supplies a non-no-op handler.
4. **A denominator strategy for self-error *rate*** (not just a raw count): the cheapest
   real denominator available without new instrumentation is "events successfully
   emitted" (`emitEvent` successes, already implicitly countable from queue
   `enqueue()` calls) as the "guarded calls that didn't fault" side of the ratio; a more
   precise denominator (literally every `safely()`-wrapped call, success or fault) would
   need `safely()` itself extended to also report on the success path, which it
   deliberately doesn't today (`src/core/safely.ts` only calls `onError` on failure —
   correctly minimal for its current job of fault containment, not metrics).
5. **A destination.** All of the above produces data the *client* can emit; there is no
   backend endpoint, dashboard, or alerting rule anywhere in this workspace to receive,
   store, or visualize it. That is the actual majority of the work and is entirely
   outside this repo's (and this workflow phase's) scope.

## 12.4 Suggested SLO starting points (to validate against real traffic once built, not to treat as final)

| Metric | Suggested initial target | Why this number, not a stricter one |
|--------|--------------------------|--------------------------------------|
| Ingest success rate (2xx only, per §12.2's split) | ≥ 99% | Leaves room for genuine client-offline time (queue durability already covers this — a low rate here should mean something is actually broken, not "some users were offline," since offline events retry until delivered) |
| Config-fetch success rate | ≥ 99.5% | A single cheap `GET`, ETag-cached; failures here fall back safely (`docs/04` §4.5) but a sustained low rate means customers are silently running on stale entitlements/kill-switch state |
| Queue-drop rate | ~0%, alert on any sustained non-zero | Drops only happen under a real byte-cap flood or genuine data corruption — either is worth knowing about immediately, not tolerating at a "rate" |
| Self-error rate | Baseline first, alert on rate-of-change | No production baseline exists yet (§12.3 point 3) — set an absolute target only after wiring §12.3 and observing real numbers for a release or two |

These are starting points for whoever builds the actual pipeline to validate or revise
once real data exists — they are not derived from any production measurement, since
none has ever been taken.

## 12.5 Explicit scope statement

**Not done in this pass, and not claimed as done:**

- No metrics backend, dashboard, or alerting exists anywhere in this workspace.
- No code in `src/`/`react/src/` was changed to emit any of the above.
- `CodeskopConfig` was not extended with a health-reporting field — doing so is a
  SemVer-additive (§7.3), reviewable change for whoever picks up §12.3, not something
  to slip in silently alongside a docs pass.

This spec is the input to that follow-up work, not a substitute for it. The Phase 15
tracker entry (`web-sdk-workflow.md`) reflects this honestly: telemetry *wiring* and
*dashboards* remain open, tracked follow-up items.
