import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiErrorPayload, ApiTimingPayload } from '../model/types.js';
import type { EmitEventInput } from '../runtime/client.js';
import type { FetchFn, FetchHost, NetworkCaptureOptions, XhrConstructorLike } from './network.js';
import { NetworkCapture } from './network.js';

const INGEST_ENDPOINT = 'https://ingest.example.com';
const BASE_URL = 'https://app.customer.com/dashboard';

function fakeResponse(overrides: { status?: number; headers?: Record<string, string> } = {}): Response {
  const headers = overrides.headers ?? {};
  return {
    status: overrides.status ?? 200,
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
      forEach: (callback: (value: string, key: string) => void) => {
        for (const [key, value] of Object.entries(headers)) callback(value, key);
      },
    },
  } as unknown as Response;
}

function timingPayloadOf(call: unknown[]): ApiTimingPayload {
  return (call[0] as EmitEventInput).payload as ApiTimingPayload;
}

function errorPayloadOf(call: unknown[]): ApiErrorPayload {
  return (call[0] as EmitEventInput).payload as ApiErrorPayload;
}

function buildFetchCapture(overrides: Partial<NetworkCaptureOptions> & { fetchImpl?: FetchFn } = {}) {
  const { fetchImpl, ...rest } = overrides;
  const emit = vi.fn();
  const impl = fetchImpl ?? (vi.fn(async () => fakeResponse()) as unknown as FetchFn);
  const win: FetchHost = { fetch: impl };
  const capture = new NetworkCapture({
    endpoint: INGEST_ENDPOINT,
    baseUrl: BASE_URL,
    win,
    XHRImpl: undefined,
    emit,
    ...rest,
  });
  return { capture, emit, win, fetchImpl: impl };
}

/** A minimal `XMLHttpRequest`-shaped fake, fresh per call so tests never share a patched prototype. */
function createFakeXhrClass() {
  return class FakeXhr {
    status = 0;
    private listeners = new Map<string, Set<() => void>>();
    private headers: Record<string, string> = {};

    open(_method: string, _url: string): void {}
    send(_body?: unknown): void {}

    addEventListener(type: string, listener: () => void): void {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type)?.add(listener);
    }

    getAllResponseHeaders(): string {
      return Object.entries(this.headers)
        .map(([key, value]) => `${key}: ${value}`)
        .join('\r\n');
    }

    getResponseHeader(name: string): string | null {
      return this.headers[name.toLowerCase()] ?? null;
    }

    setHeaders(headers: Record<string, string>): void {
      this.headers = headers;
    }

    fire(type: string): void {
      for (const listener of this.listeners.get(type) ?? []) listener();
    }
  };
}

function buildXhrCapture(overrides: Partial<NetworkCaptureOptions> = {}) {
  const emit = vi.fn();
  const XHRImpl = createFakeXhrClass();
  const capture = new NetworkCapture({
    endpoint: INGEST_ENDPOINT,
    baseUrl: BASE_URL,
    win: undefined,
    XHRImpl: XHRImpl as unknown as XhrConstructorLike,
    emit,
    ...overrides,
  });
  return { capture, emit, XHRImpl };
}

describe('capture/network — fetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('success: emits exactly one api_timing event with method/host/path/status/duration, no api_error', async () => {
    const { capture, emit, win } = buildFetchCapture({
      fetchImpl: vi.fn(async () =>
        fakeResponse({ status: 200, headers: { 'content-type': 'application/json', 'content-length': '42' } }),
      ) as unknown as FetchFn,
    });
    capture.start();

    await (win.fetch as FetchFn)('https://api.customer.com/checkout?token=abc123', { method: 'GET' });

    expect(emit).toHaveBeenCalledTimes(1);
    const input = emit.mock.calls[0]?.[0] as EmitEventInput;
    expect(input.type).toBe('api_timing');
    expect(input.severity).toBe('low');

    const payload = timingPayloadOf(emit.mock.calls[0] ?? []);
    expect(payload.method).toBe('GET');
    expect(payload.host).toBe('api.customer.com');
    expect(payload.path).toBe('/checkout'); // query dropped
    expect(payload.status).toBe(200);
    expect(payload.response_bytes).toBe(42);
    expect(typeof payload.duration_ms).toBe('number');
  });

  it('defaults the method to GET when neither init.method nor a Request is supplied', async () => {
    const { capture, emit, win } = buildFetchCapture();
    capture.start();

    await (win.fetch as FetchFn)('https://api.customer.com/ping');

    const payload = timingPayloadOf(emit.mock.calls[0] ?? []);
    expect(payload.method).toBe('GET');
  });

  it('reads the method from a Request object when input is one', async () => {
    const { capture, emit, win } = buildFetchCapture();
    capture.start();

    const request = new Request('https://api.customer.com/orders', { method: 'post' });
    await (win.fetch as FetchFn)(request);

    const payload = timingPayloadOf(emit.mock.calls[0] ?? []);
    expect(payload.method).toBe('POST');
    // A Request's body is a stream already destined for the real call — never read here.
    expect(payload.request_bytes).toBeUndefined();
  });

  it('5xx: emits both api_timing (low) and api_error (high, error_kind http_5xx)', async () => {
    const { capture, emit, win } = buildFetchCapture({
      fetchImpl: vi.fn(async () => fakeResponse({ status: 503 })) as unknown as FetchFn,
    });
    capture.start();

    await (win.fetch as FetchFn)('https://api.customer.com/checkout');

    expect(emit).toHaveBeenCalledTimes(2);
    expect((emit.mock.calls[0]?.[0] as EmitEventInput).type).toBe('api_timing');
    expect((emit.mock.calls[0]?.[0] as EmitEventInput).severity).toBe('low');
    const errorInput = emit.mock.calls[1]?.[0] as EmitEventInput;
    expect(errorInput.type).toBe('api_error');
    expect(errorInput.severity).toBe('high');
    expect(errorPayloadOf(emit.mock.calls[1] ?? []).error_kind).toBe('http_5xx');
  });

  it('4xx: classifies as http_4xx', async () => {
    const { capture, emit, win } = buildFetchCapture({
      fetchImpl: vi.fn(async () => fakeResponse({ status: 404 })) as unknown as FetchFn,
    });
    capture.start();

    await (win.fetch as FetchFn)('https://api.customer.com/missing');

    expect(errorPayloadOf(emit.mock.calls[1] ?? []).error_kind).toBe('http_4xx');
  });

  it('network error (rejected fetch): emits api_timing then api_error(network_error), and the real rejection still propagates unchanged', async () => {
    const rejection = new TypeError('Failed to fetch');
    const { capture, emit, win } = buildFetchCapture({
      fetchImpl: vi.fn(async () => {
        throw rejection;
      }) as unknown as FetchFn,
    });
    capture.start();

    await expect((win.fetch as FetchFn)('https://api.customer.com/checkout')).rejects.toBe(rejection);

    expect(emit).toHaveBeenCalledTimes(2);
    expect((emit.mock.calls[0]?.[0] as EmitEventInput).type).toBe('api_timing');
    expect(errorPayloadOf(emit.mock.calls[1] ?? []).error_kind).toBe('network_error');
  });

  it('classifies an AbortError rejection as "aborted"', async () => {
    const rejection = new DOMException('The operation was aborted', 'AbortError');
    const { capture, emit, win } = buildFetchCapture({
      fetchImpl: vi.fn(async () => {
        throw rejection;
      }) as unknown as FetchFn,
    });
    capture.start();

    await expect((win.fetch as FetchFn)('https://api.customer.com/checkout')).rejects.toBe(rejection);
    expect(errorPayloadOf(emit.mock.calls[1] ?? []).error_kind).toBe('aborted');
  });

  it('header redaction: Authorization/Cookie are stripped, allowlisted headers survive', async () => {
    const { capture, emit, win } = buildFetchCapture({
      fetchImpl: vi.fn(async () =>
        fakeResponse({
          headers: { 'content-type': 'application/json', authorization: 'Bearer secret', 'set-cookie': 'a=b' },
        }),
      ) as unknown as FetchFn,
    });
    capture.start();

    await (win.fetch as FetchFn)('https://api.customer.com/me');

    const payload = timingPayloadOf(emit.mock.calls[0] ?? []);
    expect(payload.headers).toEqual({ 'content-type': 'application/json' });
    expect(payload.headers?.authorization).toBeUndefined();
  });

  it('a custom redactHeaderNames list is honoured as an additional backstop', async () => {
    const { capture, emit, win } = buildFetchCapture({
      redactHeaderNames: ['content-type'],
      fetchImpl: vi.fn(async () =>
        fakeResponse({ headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }),
      ) as unknown as FetchFn,
    });
    capture.start();

    await (win.fetch as FetchFn)('https://api.customer.com/me');

    expect(timingPayloadOf(emit.mock.calls[0] ?? []).headers).toEqual({ 'cache-control': 'no-store' });
  });

  it('ingest-endpoint exclusion: a call to the configured ingest endpoint is never instrumented, but still goes through', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse({ status: 200 })) as unknown as FetchFn;
    const { capture, emit, win } = buildFetchCapture({ fetchImpl });
    capture.start();

    const response = await (win.fetch as FetchFn)(`${INGEST_ENDPOINT}/v1/events`, { method: 'POST' });

    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(emit).not.toHaveBeenCalled();
  });

  it('exclusion also applies to a relative ingest-endpoint path resolved against baseUrl on the same host', async () => {
    const { capture, emit, win } = buildFetchCapture({ baseUrl: `${INGEST_ENDPOINT}/dashboard` });
    capture.start();

    await (win.fetch as FetchFn)('/v1/config');

    expect(emit).not.toHaveBeenCalled();
  });

  it('measures request byte size for a string body', async () => {
    const { capture, emit, win } = buildFetchCapture();
    capture.start();

    await (win.fetch as FetchFn)('https://api.customer.com/orders', { method: 'POST', body: 'hello' });

    expect(timingPayloadOf(emit.mock.calls[0] ?? []).request_bytes).toBe(5);
  });

  it('measures request byte size for an ArrayBuffer/typed-array body', async () => {
    const { capture, emit, win } = buildFetchCapture();
    capture.start();

    await (win.fetch as FetchFn)('https://api.customer.com/orders', {
      method: 'POST',
      body: new Uint8Array([1, 2, 3, 4]),
    });

    expect(timingPayloadOf(emit.mock.calls[0] ?? []).request_bytes).toBe(4);
  });

  it('measures request byte size for a URLSearchParams body', async () => {
    const { capture, emit, win } = buildFetchCapture();
    capture.start();

    await (win.fetch as FetchFn)('https://api.customer.com/orders', {
      method: 'POST',
      body: new URLSearchParams({ a: '1' }),
    });

    expect(timingPayloadOf(emit.mock.calls[0] ?? []).request_bytes).toBe('a=1'.length);
  });

  it('leaves request_bytes undefined for an unmeasurable body (FormData)', async () => {
    const { capture, emit, win } = buildFetchCapture();
    capture.start();

    const form = new FormData();
    form.append('a', '1');
    await (win.fetch as FetchFn)('https://api.customer.com/orders', { method: 'POST', body: form });

    expect(timingPayloadOf(emit.mock.calls[0] ?? []).request_bytes).toBeUndefined();
  });

  it('pulls fine-grained timing from a matching same-origin PerformanceResourceTiming entry', async () => {
    const entry = {
      name: 'https://api.customer.com/checkout',
      startTime: 100,
      domainLookupStart: 100,
      domainLookupEnd: 105,
      connectStart: 105,
      connectEnd: 120,
      secureConnectionStart: 110,
      requestStart: 120,
      responseStart: 150,
      responseEnd: 200,
    };
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([entry] as unknown as PerformanceEntryList);

    const { capture, emit, win } = buildFetchCapture({ now: () => 100 });
    capture.start();

    await (win.fetch as FetchFn)('https://api.customer.com/checkout');

    expect(timingPayloadOf(emit.mock.calls[0] ?? []).timing).toEqual({
      dns: 5,
      connect: 15,
      tls: 10,
      ttfb: 30,
      total: 100,
    });
  });

  it('omits fine-grained timing when Timing-Allow-Origin was not granted (all sub-fields zeroed)', async () => {
    const entry = {
      name: 'https://api.customer.com/checkout',
      startTime: 100,
      domainLookupStart: 0,
      domainLookupEnd: 0,
      connectStart: 0,
      connectEnd: 0,
      secureConnectionStart: 0,
      requestStart: 0,
      responseStart: 0,
      responseEnd: 250,
    };
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([entry] as unknown as PerformanceEntryList);

    const { capture, emit, win } = buildFetchCapture({ now: () => 100 });
    capture.start();

    await (win.fetch as FetchFn)('https://api.customer.com/checkout');

    expect(timingPayloadOf(emit.mock.calls[0] ?? []).timing).toBeUndefined();
  });

  it('never lets a bug in its own instrumentation (emit throws) change the real response the host receives', async () => {
    const response = fakeResponse({ status: 200 });
    const { capture, win } = buildFetchCapture({
      emit: () => {
        throw new Error('internal bug');
      },
      fetchImpl: vi.fn(async () => response) as unknown as FetchFn,
    });
    capture.start();

    const received = await (win.fetch as FetchFn)('https://api.customer.com/checkout');
    expect(received).toBe(response);
  });

  it('never lets a bug in its own pre-call metadata extraction (now() throws) change the real response', async () => {
    const response = fakeResponse({ status: 200 });
    const { capture, emit, win } = buildFetchCapture({
      now: () => {
        throw new Error('clock broken');
      },
      fetchImpl: vi.fn(async () => response) as unknown as FetchFn,
    });
    capture.start();

    const received = await (win.fetch as FetchFn)('https://api.customer.com/checkout');
    expect(received).toBe(response);
    expect(emit).not.toHaveBeenCalled(); // metadata prep failed before any capture existed
  });

  it('start()/stop() are idempotent and safe with no fetch host at all (e.g. SSR)', () => {
    const capture = new NetworkCapture({ endpoint: INGEST_ENDPOINT, win: undefined, XHRImpl: undefined });
    expect(() => {
      capture.start();
      capture.start();
      capture.stop();
      capture.stop();
    }).not.toThrow();
  });

  it('stop() restores the original fetch so a later call is no longer instrumented', async () => {
    const { capture, emit, win } = buildFetchCapture();
    const original = win.fetch;
    capture.start();
    expect(win.fetch).not.toBe(original);

    capture.stop();
    expect(win.fetch).toBe(original);

    await (win.fetch as FetchFn)('https://api.customer.com/checkout');
    expect(emit).not.toHaveBeenCalled();
  });

  it('start() twice does not re-wrap an already-patched fetch', () => {
    const { capture, win } = buildFetchCapture();
    capture.start();
    const patched = win.fetch;
    capture.start();
    expect(win.fetch).toBe(patched);
  });

  it('defaults to the real window/XMLHttpRequest when no host is injected', () => {
    const capture = new NetworkCapture({ endpoint: INGEST_ENDPOINT });
    const originalFetch = window.fetch;
    const originalOpen = XMLHttpRequest.prototype.open;

    capture.start();
    expect(window.fetch).not.toBe(originalFetch);
    expect(XMLHttpRequest.prototype.open).not.toBe(originalOpen);

    capture.stop();
    expect(window.fetch).toBe(originalFetch);
    expect(XMLHttpRequest.prototype.open).toBe(originalOpen);
  });

  it('rides the same emit path as every other capture module: default construction resolves getActiveClient()?.emitEvent', async () => {
    vi.resetModules();
    const emitEvent = vi.fn();
    const getActiveClient = vi.fn(() => ({ emitEvent }));
    vi.doMock('../runtime/client.js', () => ({ getActiveClient }));

    const { NetworkCapture: MockedNetworkCapture } = await import('./network.js');
    const fetchImpl = vi.fn(async () => fakeResponse({ status: 200 })) as unknown as FetchFn;
    const win: FetchHost = { fetch: fetchImpl };

    const capture = new MockedNetworkCapture({ endpoint: INGEST_ENDPOINT, win, XHRImpl: undefined });
    capture.start();
    await (win.fetch as FetchFn)('https://api.customer.com/checkout');

    expect(getActiveClient).toHaveBeenCalled();
    expect(emitEvent).toHaveBeenCalledTimes(1);

    vi.doUnmock('../runtime/client.js');
    vi.resetModules();
  });

  it('the default emit is a safe no-op before init() (getActiveClient() returns undefined)', async () => {
    vi.resetModules();
    const getActiveClient = vi.fn(() => undefined);
    vi.doMock('../runtime/client.js', () => ({ getActiveClient }));

    const { NetworkCapture: MockedNetworkCapture } = await import('./network.js');
    const fetchImpl = vi.fn(async () => fakeResponse({ status: 200 })) as unknown as FetchFn;
    const win: FetchHost = { fetch: fetchImpl };

    const capture = new MockedNetworkCapture({ endpoint: INGEST_ENDPOINT, win, XHRImpl: undefined });
    capture.start();
    await expect((win.fetch as FetchFn)('https://api.customer.com/checkout')).resolves.toBeDefined();
    expect(getActiveClient).toHaveBeenCalled();

    vi.doUnmock('../runtime/client.js');
    vi.resetModules();
  });
});

describe('capture/network — XMLHttpRequest', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('success: emits exactly one api_timing event, headers redacted', () => {
    const { capture, emit, XHRImpl } = buildXhrCapture();
    capture.start();

    const xhr = new XHRImpl();
    xhr.open('GET', 'https://api.customer.com/orders?token=abc');
    xhr.send();
    xhr.status = 200;
    xhr.setHeaders({ 'content-type': 'application/json', authorization: 'Bearer secret' });
    xhr.fire('load');
    xhr.fire('loadend');

    expect(emit).toHaveBeenCalledTimes(1);
    const input = emit.mock.calls[0]?.[0] as EmitEventInput;
    expect(input.type).toBe('api_timing');
    const payload = timingPayloadOf(emit.mock.calls[0] ?? []);
    expect(payload.method).toBe('GET');
    expect(payload.host).toBe('api.customer.com');
    expect(payload.path).toBe('/orders');
    expect(payload.status).toBe(200);
    expect(payload.headers).toEqual({ 'content-type': 'application/json' });
  });

  it('5xx: emits api_timing and api_error(http_5xx)', () => {
    const { capture, emit, XHRImpl } = buildXhrCapture();
    capture.start();

    const xhr = new XHRImpl();
    xhr.open('GET', 'https://api.customer.com/orders');
    xhr.send();
    xhr.status = 503;
    xhr.fire('load');
    xhr.fire('loadend');

    expect(emit).toHaveBeenCalledTimes(2);
    expect(errorPayloadOf(emit.mock.calls[1] ?? []).error_kind).toBe('http_5xx');
  });

  it('network error (status 0, error event): emits api_error(network_error)', () => {
    const { capture, emit, XHRImpl } = buildXhrCapture();
    capture.start();

    const xhr = new XHRImpl();
    xhr.open('GET', 'https://api.customer.com/orders');
    xhr.send();
    xhr.status = 0;
    xhr.fire('error');
    xhr.fire('loadend');

    expect(emit).toHaveBeenCalledTimes(2);
    expect(errorPayloadOf(emit.mock.calls[1] ?? []).error_kind).toBe('network_error');
    // A network failure exposes no meaningful status/headers/response size.
    expect(errorPayloadOf(emit.mock.calls[1] ?? []).status).toBeUndefined();
  });

  it('timeout: classifies as "timeout"', () => {
    const { capture, emit, XHRImpl } = buildXhrCapture();
    capture.start();

    const xhr = new XHRImpl();
    xhr.open('GET', 'https://api.customer.com/orders');
    xhr.send();
    xhr.status = 0;
    xhr.fire('timeout');
    xhr.fire('loadend');

    expect(errorPayloadOf(emit.mock.calls[1] ?? []).error_kind).toBe('timeout');
  });

  it('abort: classifies as "aborted"', () => {
    const { capture, emit, XHRImpl } = buildXhrCapture();
    capture.start();

    const xhr = new XHRImpl();
    xhr.open('GET', 'https://api.customer.com/orders');
    xhr.send();
    xhr.status = 0;
    xhr.fire('abort');
    xhr.fire('loadend');

    expect(errorPayloadOf(emit.mock.calls[1] ?? []).error_kind).toBe('aborted');
  });

  it('ingest-endpoint exclusion: open()/send() to the ingest endpoint are never instrumented', () => {
    const { capture, emit, XHRImpl } = buildXhrCapture();
    capture.start();

    const xhr = new XHRImpl();
    xhr.open('POST', `${INGEST_ENDPOINT}/v1/events`);
    xhr.send('{}');
    xhr.status = 200;
    xhr.fire('load');
    xhr.fire('loadend');

    expect(emit).not.toHaveBeenCalled();
  });

  it('measures request byte size from the send() body', () => {
    const { capture, emit, XHRImpl } = buildXhrCapture();
    capture.start();

    const xhr = new XHRImpl();
    xhr.open('POST', 'https://api.customer.com/orders');
    xhr.send('hello world');
    xhr.status = 200;
    xhr.fire('load');
    xhr.fire('loadend');

    expect(timingPayloadOf(emit.mock.calls[0] ?? []).request_bytes).toBe('hello world'.length);
  });

  it('never lets a bug in its own instrumentation (emit throws) stop the original open()/send() from running', () => {
    const { capture, XHRImpl } = buildXhrCapture({
      emit: () => {
        throw new Error('internal bug');
      },
    });
    capture.start();

    const xhr = new XHRImpl();
    expect(() => {
      xhr.open('GET', 'https://api.customer.com/orders');
      xhr.send();
      xhr.status = 200;
      xhr.fire('load');
      xhr.fire('loadend');
    }).not.toThrow();
  });

  it('start()/stop() are idempotent and safe with no XHR constructor at all (e.g. SSR)', () => {
    const capture = new NetworkCapture({ endpoint: INGEST_ENDPOINT, win: undefined, XHRImpl: undefined });
    expect(() => {
      capture.start();
      capture.start();
      capture.stop();
      capture.stop();
    }).not.toThrow();
  });

  it('stop() restores the original open/send so a later call is no longer instrumented', () => {
    const { capture, emit, XHRImpl } = buildXhrCapture();
    const originalOpen = XHRImpl.prototype.open;
    capture.start();
    expect(XHRImpl.prototype.open).not.toBe(originalOpen);

    capture.stop();
    expect(XHRImpl.prototype.open).toBe(originalOpen);

    const xhr = new XHRImpl();
    xhr.open('GET', 'https://api.customer.com/orders');
    xhr.send();
    xhr.status = 200;
    xhr.fire('load');
    xhr.fire('loadend');
    expect(emit).not.toHaveBeenCalled();
  });
});
