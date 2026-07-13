/**
 * Network capture (D3; `docs/01` §1's decision table, `docs/03-capture-and-
 * event-model.md` §3.1/§3.4, `web-sdk-workflow.md` Phase 6): monkey-patches
 * the global `fetch` and `XMLHttpRequest` so every host network call yields
 * a low-severity `api_timing` event (latency, every call) and, on failure
 * (a network error or an HTTP status >= 400), a high-severity `api_error`
 * event as well.
 *
 * The prime directive (`docs/01` §1.2) governs every line here: a bug in
 * this module's own metadata extraction is caught by `safely()` and reported
 * as an internal diagnostic — the *original* `fetch` promise / the host's
 * `XMLHttpRequest` instance is always returned/left alone completely
 * unchanged, even when instrumentation throws. Concretely: the real
 * `fetch`/`XMLHttpRequest.send` call is always issued and its real
 * result/rejection is what the host receives; every metadata-extraction step
 * runs *around* that call, individually wrapped, and never gates or delays it.
 *
 * Requests to the SDK's own configured ingest endpoint
 * (`NetworkCaptureOptions.endpoint`) are never instrumented — instrumenting
 * the SDK's own delivery/config calls would create an infinite feedback loop
 * of events about events.
 *
 * Response headers are allowlisted + redacted via `core/redaction.ts`
 * (reused, not reimplemented); the URL is reduced to `host`/`path` the same
 * way, with the query string unconditionally dropped. Only *sizes* are
 * measured for request/response bodies (D3 — actual body content is a
 * separate, opt-in capability this phase doesn't implement).
 *
 * Mirrors the `start()`/`stop()` shape and the injectable `emit`
 * (defaulting to `getActiveClient()?.emitEvent`) of `capture/errors.ts` and
 * `capture/heartbeat.ts`, so a later integration phase can own one instance
 * of each alongside `runtime/syncScheduler.ts`'s `SyncScheduler`. Whether/when
 * to construct and `start()` a `NetworkCapture` (gated by
 * `CodeskopConfig.captureNetwork`) is that integration's job, not this module's.
 */
import type { ApiErrorPayload, ApiTimingPayload, NetworkTiming } from '../model/types.js';
import type { EmitEventInput } from '../runtime/client.js';
import { getActiveClient } from '../runtime/client.js';
import { safely } from '../core/safely.js';
import { DEFAULT_REDACT_HEADER_NAMES, redactHeaders, redactUrl } from '../core/redaction.js';

/** The subset of `fetch`'s signature this module patches/calls. */
export type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** The mutable global this module patches `fetch` on — `window` in every real host. Trivial to fake in tests. */
export interface FetchHost {
  fetch?: FetchFn;
}

/** The two `XMLHttpRequest.prototype` methods this module wraps — kept minimal and injectable for tests. */
export interface XhrPrototypeLike {
  open: (...args: unknown[]) => unknown;
  send: (...args: unknown[]) => unknown;
}

/** The injectable `XMLHttpRequest` constructor shape — just enough surface to patch `open`/`send`. */
export interface XhrConstructorLike {
  prototype: XhrPrototypeLike;
}

/** The slice of an `XMLHttpRequest` *instance* this module reads/listens on after `send()`. */
export interface XhrInstanceLike {
  readonly status: number;
  addEventListener(type: string, listener: () => void): void;
  getAllResponseHeaders(): string;
  getResponseHeader(name: string): string | null;
}

export interface NetworkCaptureOptions {
  /** The configured ingest endpoint (`CodeskopConfig.endpoint`); requests to it are never instrumented (no feedback loop). */
  endpoint: string;
  /** Always-dropped response header names, case-insensitive. Defaults to `DEFAULT_REDACT_HEADER_NAMES` (`core/redaction.ts`). */
  redactHeaderNames?: readonly string[];
  /** Base URL relative request URLs resolve against, for the ingest-endpoint match and host/path redaction. Defaults to `window.location.href`. */
  baseUrl?: string;
  /** Injectable emit seam for tests; defaults to `getActiveClient()?.emitEvent` (mirrors every other capture module). */
  emit?: (input: EmitEventInput) => void;
  /** Injectable `fetch` host — a mutable object so `fetch` can be swapped on it. Defaults to the real `window` (`undefined` outside a browser). */
  win?: FetchHost;
  /** Injectable `XMLHttpRequest` constructor. Defaults to the real global (`undefined` outside a browser). */
  XHRImpl?: XhrConstructorLike;
  /** Injectable monotonic clock for latency measurement. Defaults to `performance.now`, falling back to `Date.now`. */
  now?: () => number;
}

/** `NetworkEventPayloadBase` isn't exported by `model/types.ts`; derived here rather than duplicated. */
type NetworkEventBase = Omit<ApiErrorPayload, 'error_kind'>;

type XhrOutcome = 'load' | 'error' | 'timeout' | 'abort';

interface FetchCapture {
  method: string;
  absoluteUrl: string;
  startedAt: number;
  requestBytes: number | undefined;
}

interface XhrCaptureState {
  method: string;
  absoluteUrl: string;
  excluded: boolean;
  startedAt?: number;
  requestBytes?: number;
  outcome?: XhrOutcome;
}

/** A tolerance window (ms) around our own wall-clock timing when matching a `PerformanceResourceTiming` entry by URL — several in-flight requests can share a URL, so this disambiguates by recency rather than assuming a 1:1 name match. */
const RESOURCE_TIMING_TOLERANCE_MS = 50;

function resolveDefaultFetchHost(): FetchHost | undefined {
  return typeof window !== 'undefined' ? (window as unknown as FetchHost) : undefined;
}

function resolveDefaultXhrCtor(): XhrConstructorLike | undefined {
  return typeof XMLHttpRequest !== 'undefined' ? (XMLHttpRequest as unknown as XhrConstructorLike) : undefined;
}

function resolveDefaultBaseUrl(): string | undefined {
  try {
    return typeof window !== 'undefined' && window.location ? window.location.href : undefined;
  } catch {
    return undefined;
  }
}

function defaultNow(): number {
  try {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now();
  } catch {
    // fall through to Date.now()
  }
  return Date.now();
}

/** Resolves the currently-active client's `emitEvent` lazily, on every call — never captured at construction, since `init()` may run after this module is (mirrors `capture/heartbeat.ts`'s `defaultEmit`). */
function defaultEmit(input: EmitEventInput): void {
  getActiveClient()?.emitEvent(input);
}

function extractMethod(input: RequestInfo | URL, init: RequestInit | undefined): string {
  if (init?.method) return init.method.toUpperCase();
  if (typeof Request !== 'undefined' && input instanceof Request) return input.method.toUpperCase();
  return 'GET';
}

function extractUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  if (typeof Request !== 'undefined' && input instanceof Request) return input.url;
  return String(input);
}

/** Resolves a possibly-relative URL against `base` for comparison/redaction purposes; degrades to the raw string rather than throwing. */
function resolveAbsoluteUrl(rawUrl: string, base: string | undefined): string {
  try {
    return new URL(rawUrl, base).toString();
  } catch {
    return rawUrl;
  }
}

function classifyHttpStatus(status: number): string {
  return status >= 500 ? 'http_5xx' : 'http_4xx';
}

function classifyFetchError(error: unknown): string {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError') {
    return 'aborted';
  }
  if (error instanceof Error && error.name === 'TimeoutError') return 'timeout';
  return 'network_error';
}

function classifyXhrFailure(outcome: XhrOutcome | undefined): string {
  if (outcome === 'timeout') return 'timeout';
  if (outcome === 'abort') return 'aborted';
  return 'network_error';
}

function byteLengthOfString(value: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).length;
  return value.length;
}

/** Best-effort request-body size. Only cheap, non-consuming shapes are measured; `FormData`/streams are left `undefined` rather than risking interference with the real call. */
function measureBodySize(body: BodyInit | null | undefined): number | undefined {
  if (body === null || body === undefined) return undefined;
  try {
    if (typeof body === 'string') return byteLengthOfString(body);
    if (typeof Blob !== 'undefined' && body instanceof Blob) return body.size;
    if (body instanceof ArrayBuffer) return body.byteLength;
    if (ArrayBuffer.isView(body)) return body.byteLength;
    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
      return byteLengthOfString(body.toString());
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function parseContentLength(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

/** Parses XHR's `getAllResponseHeaders()` CRLF-joined `"name: value"` blob into a plain record. */
function parseXhrHeaders(raw: string | null | undefined): Record<string, string> {
  const record: Record<string, string> = {};
  if (!raw) return record;
  for (const rawLine of raw.trim().split(/\r?\n/)) {
    const separator = rawLine.indexOf(':');
    if (separator === -1) continue;
    const name = rawLine.slice(0, separator).trim();
    const value = rawLine.slice(separator + 1).trim();
    if (name) record[name] = value;
  }
  return record;
}

function nonNegative(value: number): number {
  return value > 0 ? value : 0;
}

/**
 * Best-effort fine-grained timing from `PerformanceResourceTiming`, present
 * only when the response exposes `Timing-Allow-Origin` (same-origin always
 * qualifies; cross-origin only with the header). Per spec, a cross-origin
 * entry without it zeroes every sub-timing field — `requestStart` and
 * `responseStart` both `0` is that signal, not an instantaneous request — so
 * that combination is treated as "nothing exposed" rather than reported as
 * zero latency (`docs/03` §3.4).
 */
function extractResourceTiming(url: string, startedAt: number, endedAt: number): NetworkTiming | undefined {
  try {
    if (typeof performance === 'undefined' || typeof performance.getEntriesByType !== 'function') return undefined;
    const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    const entry = entries.find(
      (candidate) =>
        candidate.name === url &&
        candidate.startTime >= startedAt - RESOURCE_TIMING_TOLERANCE_MS &&
        candidate.startTime <= endedAt + RESOURCE_TIMING_TOLERANCE_MS,
    );
    if (!entry) return undefined;
    if (entry.requestStart === 0 && entry.responseStart === 0) return undefined;

    const timing: NetworkTiming = {
      dns: nonNegative(entry.domainLookupEnd - entry.domainLookupStart),
      connect: nonNegative(entry.connectEnd - entry.connectStart),
      ttfb: nonNegative(entry.responseStart - entry.requestStart),
      total: nonNegative(entry.responseEnd - entry.startTime),
    };
    if (entry.secureConnectionStart > 0) {
      timing.tls = nonNegative(entry.connectEnd - entry.secureConnectionStart);
    }
    return timing;
  } catch {
    return undefined;
  }
}

/**
 * Patches `fetch` and `XMLHttpRequest` to emit `api_timing`/`api_error`
 * events for every host network call. `start()`/`stop()` are idempotent and
 * safe outside a browser (both globals then simply absent — a no-op),
 * mirroring `capture/errors.ts`'s `ErrorCapture` and
 * `capture/heartbeat.ts`'s `HeartbeatCapture`.
 */
export class NetworkCapture {
  private readonly ingestHost: string;
  private readonly redactHeaderNames: readonly string[];
  private readonly baseUrl: string | undefined;
  private readonly emit: (input: EmitEventInput) => void;
  private readonly win: FetchHost | undefined;
  private readonly XHRImpl: XhrConstructorLike | undefined;
  private readonly now: () => number;
  private readonly xhrState = new WeakMap<object, XhrCaptureState>();

  private started = false;
  private originalFetch: FetchFn | undefined;
  private originalXhrOpen: XhrPrototypeLike['open'] | undefined;
  private originalXhrSend: XhrPrototypeLike['send'] | undefined;

  constructor(options: NetworkCaptureOptions) {
    this.ingestHost = redactUrl(options.endpoint).host;
    this.redactHeaderNames = options.redactHeaderNames ?? DEFAULT_REDACT_HEADER_NAMES;
    this.baseUrl = options.baseUrl ?? resolveDefaultBaseUrl();
    this.emit = options.emit ?? defaultEmit;
    this.win = options.win ?? resolveDefaultFetchHost();
    this.XHRImpl = options.XHRImpl ?? resolveDefaultXhrCtor();
    this.now = options.now ?? defaultNow;
  }

  /** Patches `fetch`/`XMLHttpRequest`. Idempotent; never throws (`safely()`-guarded). */
  readonly start = safely((): void => {
    if (this.started) return;
    this.started = true;
    this.patchFetch();
    this.patchXhr();
  }, { context: 'network.start' });

  /** Restores the originals. Idempotent; safe even if `start()` was never called. */
  readonly stop = safely((): void => {
    if (!this.started) return;
    this.started = false;
    this.unpatchFetch();
    this.unpatchXhr();
  }, { context: 'network.stop' });

  private patchFetch(): void {
    const host = this.win;
    if (!host || typeof host.fetch !== 'function') return;
    // Restoring on `stop()` must hand back this exact, un-bound reference — not a freshly
    // `.bind()`-ed one, which would be a different (if behaviorally identical) function object,
    // and in a real browser is already itself a bound function (double-binding it is harmless
    // but pointless). The *call-site* binding below is what actually matters: real browsers throw
    // `TypeError: Illegal invocation` if the bare `fetch` reference is extracted and later called
    // detached from its `window` receiver — the same WebIDL platform-method pitfall
    // `runtime/client.ts`'s Phase 4 fix documents.
    const rawFetch = host.fetch;
    this.originalFetch = rawFetch;
    const boundFetch = rawFetch.bind(host);
    host.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
      this.handleFetch(boundFetch, input, init);
  }

  private unpatchFetch(): void {
    if (this.win && this.originalFetch) this.win.fetch = this.originalFetch;
    this.originalFetch = undefined;
  }

  /** The patched `fetch`: always issues the real call and returns its exact promise; instrumentation is a side effect that never gates or alters it. */
  private handleFetch(originalFetch: FetchFn, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const prepare = safely(() => this.prepareFetchCapture(input, init), { context: 'network.fetch.prepare' });
    const capture = prepare();

    const responsePromise = originalFetch(input, init);
    if (!capture) return responsePromise;

    responsePromise.then(
      (response) => safely(() => this.onFetchResponse(capture, response), { context: 'network.fetch.response' })(),
      (error: unknown) => safely(() => this.onFetchError(capture, error), { context: 'network.fetch.rejected' })(),
    );

    return responsePromise;
  }

  private prepareFetchCapture(input: RequestInfo | URL, init: RequestInit | undefined): FetchCapture | undefined {
    const method = extractMethod(input, init);
    const rawUrl = extractUrl(input);
    const absoluteUrl = resolveAbsoluteUrl(rawUrl, this.baseUrl);
    if (redactUrl(absoluteUrl).host === this.ingestHost) return undefined; // never instrument the SDK's own ingest calls

    // A `Request` object's body is a one-shot stream already destined for `originalFetch`;
    // reading it here would risk interfering with the real call, so it's left unmeasured.
    const requestBytes = typeof Request !== 'undefined' && input instanceof Request ? undefined : measureBodySize(init?.body);

    return { method, absoluteUrl, startedAt: this.now(), requestBytes };
  }

  private onFetchResponse(capture: FetchCapture, response: Response): void {
    const durationMs = this.now() - capture.startedAt;
    const { host, path } = redactUrl(capture.absoluteUrl);
    const base: NetworkEventBase = {
      method: capture.method,
      host,
      path,
      status: response.status,
      duration_ms: durationMs,
      request_bytes: capture.requestBytes,
      response_bytes: parseContentLength(response.headers.get('content-length')),
      timing: extractResourceTiming(capture.absoluteUrl, capture.startedAt, this.now()),
      headers: redactHeaders(headersToRecord(response.headers), this.redactHeaderNames),
    };

    this.emitTiming(base);
    if (response.status >= 400) {
      this.emitError({ ...base, error_kind: classifyHttpStatus(response.status) });
    }
  }

  private onFetchError(capture: FetchCapture, error: unknown): void {
    const durationMs = this.now() - capture.startedAt;
    const { host, path } = redactUrl(capture.absoluteUrl);
    const base: NetworkEventBase = {
      method: capture.method,
      host,
      path,
      duration_ms: durationMs,
      request_bytes: capture.requestBytes,
    };

    this.emitTiming(base);
    this.emitError({ ...base, error_kind: classifyFetchError(error) });
  }

  private patchXhr(): void {
    const XHRImpl = this.XHRImpl;
    if (!XHRImpl) return;
    const originalOpen = XHRImpl.prototype.open;
    const originalSend = XHRImpl.prototype.send;
    this.originalXhrOpen = originalOpen;
    this.originalXhrSend = originalSend;

    // Bound ahead of time (rather than aliasing `this`) so the two override bodies below can stay
    // plain `function`s — required so `this` inside them is the *xhr instance* at call time, not
    // this `NetworkCapture`.
    const onXhrOpen = this.onXhrOpen.bind(this);
    const onXhrSend = this.onXhrSend.bind(this);

    XHRImpl.prototype.open = function (this: XhrInstanceLike, ...args: unknown[]): unknown {
      safely(() => onXhrOpen(this, args), { context: 'network.xhr.open' })();
      return originalOpen.apply(this, args);
    };
    XHRImpl.prototype.send = function (this: XhrInstanceLike, ...args: unknown[]): unknown {
      safely(() => onXhrSend(this, args), { context: 'network.xhr.send' })();
      return originalSend.apply(this, args);
    };
  }

  private unpatchXhr(): void {
    const XHRImpl = this.XHRImpl;
    if (XHRImpl && this.originalXhrOpen) XHRImpl.prototype.open = this.originalXhrOpen;
    if (XHRImpl && this.originalXhrSend) XHRImpl.prototype.send = this.originalXhrSend;
    this.originalXhrOpen = undefined;
    this.originalXhrSend = undefined;
  }

  private onXhrOpen(xhr: XhrInstanceLike, args: unknown[]): void {
    const method = typeof args[0] === 'string' ? args[0].toUpperCase() : 'GET';
    const rawUrl = typeof args[1] === 'string' ? args[1] : args[1] instanceof URL ? args[1].toString() : '';
    const absoluteUrl = resolveAbsoluteUrl(rawUrl, this.baseUrl);
    const excluded = redactUrl(absoluteUrl).host === this.ingestHost;
    this.xhrState.set(xhr, { method, absoluteUrl, excluded });
  }

  private onXhrSend(xhr: XhrInstanceLike, args: unknown[]): void {
    const state = this.xhrState.get(xhr);
    if (!state || state.excluded) return; // never instrument the SDK's own ingest calls

    state.startedAt = this.now();
    state.requestBytes = measureBodySize(args[0] as BodyInit | null | undefined);

    const markOutcome = (outcome: XhrOutcome): void => {
      safely(() => {
        state.outcome = outcome;
      }, { context: `network.xhr.${outcome}` })();
    };
    xhr.addEventListener('load', () => markOutcome('load'));
    xhr.addEventListener('error', () => markOutcome('error'));
    xhr.addEventListener('timeout', () => markOutcome('timeout'));
    xhr.addEventListener('abort', () => markOutcome('abort'));
    xhr.addEventListener('loadend', () => safely(() => this.onXhrLoadEnd(xhr, state), { context: 'network.xhr.loadend' })());
  }

  private onXhrLoadEnd(xhr: XhrInstanceLike, state: XhrCaptureState): void {
    const durationMs = this.now() - (state.startedAt ?? this.now());
    const { host, path } = redactUrl(state.absoluteUrl);
    const status = xhr.status;
    const isNetworkFailure = status === 0; // XHR's `0` covers network error, CORS block, abort, and timeout alike

    const base: NetworkEventBase = {
      method: state.method,
      host,
      path,
      status: isNetworkFailure ? undefined : status,
      duration_ms: durationMs,
      request_bytes: state.requestBytes,
      response_bytes: isNetworkFailure ? undefined : parseContentLength(xhr.getResponseHeader('content-length')),
      timing: isNetworkFailure ? undefined : extractResourceTiming(state.absoluteUrl, state.startedAt ?? 0, this.now()),
      headers: isNetworkFailure ? undefined : redactHeaders(parseXhrHeaders(xhr.getAllResponseHeaders()), this.redactHeaderNames),
    };

    this.emitTiming(base);
    if (isNetworkFailure || status >= 400) {
      const errorKind = isNetworkFailure ? classifyXhrFailure(state.outcome) : classifyHttpStatus(status);
      this.emitError({ ...base, error_kind: errorKind });
    }
  }

  private emitTiming(payload: ApiTimingPayload): void {
    this.emit({ type: 'api_timing', severity: 'low', payload });
  }

  private emitError(payload: ApiErrorPayload): void {
    this.emit({ type: 'api_error', severity: 'high', payload });
  }
}

