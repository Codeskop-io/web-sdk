/**
 * The `@codeskop/tracker` wire contract and cross-module seams.
 *
 * The event/envelope shapes mirror the shared ingest contract
 * (`backend/docs/07-mobile-sdk-ingest-readiness.md` §7.5, `backend/apps/ingest/schemas.py`)
 * and the web-specific capture model (`docs/03-capture-and-event-model.md` §3.2-3.4).
 * The seam interfaces are the injection points other work streams (queue, transport,
 * config, runtime) build against (`docs/02-architecture.md` §2.6).
 */

/** The four event types the web SDK emits (`docs/03` §3.1). */
export type EventType = 'api_error' | 'api_timing' | 'exception' | 'heartbeat';

/** The shared severity scale (`backend/apps/ingest/schemas.py` `Severity`). */
export type Severity = 'low' | 'medium' | 'high' | 'critical';

/** Per-event user attribution; login can change mid-batch (`docs/03` §3.2). */
export interface UserRef {
  id?: string;
  is_anonymous?: boolean;
}

/** Browser/device context, sent once per batch (`docs/03` §3.3). Open shape. */
export interface DeviceContext {
  install_id: string;
  platform: 'web';
  user_agent: string;
  locale: string;
  screen: string;
  viewport: string;
  [key: string]: unknown;
}

/** Host app/page context, sent once per batch (`docs/03` §3.3). Open shape. */
export interface AppContext {
  /** Also the browser's `Origin` header; matched against the key's allowlist (D10). */
  origin: string;
  /** Path only — query is always redacted. */
  page: string;
  referrer?: string;
  release?: string;
  sdk_version: string;
  [key: string]: unknown;
}

/** Latency breakdown from `PerformanceResourceTiming`, when exposed (`docs/03` §3.4). */
export interface NetworkTiming {
  dns?: number;
  connect?: number;
  tls?: number;
  ttfb?: number;
  total?: number;
}

interface NetworkEventPayloadBase {
  method: string;
  host: string;
  path: string;
  status?: number;
  duration_ms: number;
  request_bytes?: number;
  response_bytes?: number;
  timing?: NetworkTiming;
  /** Allowlisted + redacted response headers. */
  headers?: Record<string, string>;
}

/** Payload for a failed `fetch`/XHR call (network error or status >= 400). */
export interface ApiErrorPayload extends NetworkEventPayloadBase {
  error_kind: string;
}

/** Payload emitted for every instrumented `fetch`/XHR call (latency signal). */
export type ApiTimingPayload = NetworkEventPayloadBase;

/** A single normalized stack frame. */
export interface StackFrame {
  class?: string;
  method?: string;
  file: string;
  line: number;
  column: number;
}

/** Payload for an uncaught error, unhandled rejection, or `recordException`. */
export interface ExceptionPayload {
  exception_class: string;
  /** Redacted by default. */
  message: string;
  stacktrace: StackFrame[];
  handled: boolean;
  page: string;
}

/** Payload for a presence signal, emitted only while the page is visible (D2). */
export interface HeartbeatPayload {
  session_id: string;
  visible: boolean;
}

/** Discriminated union of the four wire payload shapes, keyed by `CodeskopEvent.type`. */
export type EventPayload = ApiErrorPayload | ApiTimingPayload | ExceptionPayload | HeartbeatPayload;

/** A single event as placed on the wire inside a `BatchEnvelope.batch` (`docs/03` §3.2). */
export interface CodeskopEvent {
  /** UUIDv7; the client + server dedup key. */
  event_id: string;
  type: EventType;
  /** ISO 8601. */
  occurred_at: string;
  severity: Severity;
  user?: UserRef;
  payload: EventPayload;
}

/** The top-level batch envelope delivered to `POST /v1/events` (`docs/03` §3.2). */
export interface BatchEnvelope {
  /** ISO 8601 batch send time, used for clock-skew correction. */
  sent_at: string;
  /** Per-page-load stable; sent once per batch. */
  context: {
    device: DeviceContext;
    app: AppContext;
  };
  /** <= 100 events; <= 1 MB compressed; <= 64 KB/event. */
  batch: CodeskopEvent[];
}

// ---------------------------------------------------------------------------
// Cross-module seams (`docs/02-architecture.md` §2.6) — other work streams
// implement against these; the shapes here are the frozen contract.
// ---------------------------------------------------------------------------

/** Injectable time source so logic modules never call `Date.now()` directly. */
export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
}

/** The durable, offline-first event store (IndexedDB in production). */
export interface QueueLike {
  /** Idempotent by `event.event_id`; a duplicate insert is a no-op. */
  enqueue(event: CodeskopEvent): Promise<void>;
  /** Returns up to `maxEvents` queued events without removing them. */
  peekBatch(maxEvents: number): Promise<CodeskopEvent[]>;
  /** Removes the given event ids from the queue after a successful/permanent outcome. */
  ack(eventIds: string[]): Promise<void>;
  /** Current queue depth, in number of events. */
  size(): Promise<number>;
}

/** Outcome of a single delivery attempt against `POST /v1/events`. */
export interface TransportResult {
  /** `true` for any `2xx` response. */
  ok: boolean;
  /** HTTP status, when the request reached the server. */
  status?: number;
  /** `event_id`s the server rejected outright (permanent, per-event drop). */
  rejected?: string[];
  /** `true` for network failure or `5xx` — caller should back off and retry. */
  retryable: boolean;
}

/** The delivery mechanism (`fetch` keepalive or `sendBeacon` in production). */
export interface Transport {
  send(batch: BatchEnvelope): Promise<TransportResult>;
}

/** Remote entitlements fetched from `GET /v1/config` (`docs/05` §5.2, `docs/02` §2.6). */
export interface RemoteConfig {
  /** Kill-switch: `false` disables all capture without a redeploy. */
  enabled: boolean;
  sample_rates: Record<string, number>;
  features: Record<string, boolean>;
  max_queue_mb: number;
  /** For ETag-aware re-fetch / last-known-good caching. */
  etag?: string;
}

/** The remote-config client seam. */
export interface ConfigSource {
  fetchConfig(): Promise<RemoteConfig>;
}

/** Public init-time configuration (`docs/05-api-reference.md` §5.2). */
export interface CodeskopConfig {
  /** Public ingest key `cs_*_pk_…` (required). */
  apiKey: string;
  /** Ingest base URL. Defaults to `https://api.codeskop.com`. */
  endpoint?: string;
  /** Host app/release version, stamped into `context.app.release`. */
  release?: string;
  /** Free-form tag. Defaults to `"production"`. */
  environment?: string;
  /** Instrument `fetch`/XHR. Defaults to `true`. */
  captureNetwork?: boolean;
  /** Install `error` + `unhandledrejection` handlers. Defaults to `true`. */
  captureErrors?: boolean;
  /** Opt-in request/response bodies. Defaults to `false`. */
  captureBodies?: boolean;
  /** Always-redacted header names. Defaults to `["authorization","cookie"]`. */
  redactHeaders?: string[];
  /** Masked query keys. Defaults to `["token","apikey","password","secret"]`. */
  redactQueryKeys?: string[];
  /** Client-seeded sample rates; remote config wins. Defaults to `{}`. */
  sampleRates?: Record<string, number>;
  /** Local queue byte cap in MB; remote config wins. Defaults to `5`. */
  maxQueueMb?: number;
}
