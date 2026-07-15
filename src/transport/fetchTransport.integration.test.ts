/**
 * Real integration tests for `FetchTransport`: the happy path, partial
 * reject, and oversized-batch scenarios run against the actual
 * `backend/mock-ingest-server/` process over a real socket (skipped if it
 * isn't running); the transient-`5xx`-retry and gzip/header scenarios run
 * against a small controlled HTTP stub (`testSupport/httpStub.ts`), since the
 * mock server has no way to fake a `5xx` on demand. Nothing here stubs
 * `fetch` itself — every assertion observes bytes that actually crossed a
 * socket.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { gunzipSync } from 'node:zlib';
import type { AppContext, BatchEnvelope, CodeskopEvent, DeviceContext } from '../model/types.js';
import { buildBatches, type BuildBatchesContext } from './envelope.js';
import { FetchTransport } from './fetchTransport.js';
import { startHttpStub, type HttpStub } from './testSupport/httpStub.js';
import { isMockReachable, MOCK_INGEST_URL } from './testSupport/mockIngest.js';

const device: DeviceContext = {
  install_id: 'inst_fetch_integration',
  platform: 'web',
  user_agent: 'vitest-integration',
  locale: 'en-KE',
  screen: '1920x1080',
  viewport: '1280x720',
};

const context: BuildBatchesContext = {
  device,
  app: { page: '/checkout', sdk_version: '1.0.0', origin: 'https://app.customer.com' },
};

function heartbeat(id: string, extraBytes = 0): CodeskopEvent {
  return {
    event_id: id,
    type: 'heartbeat',
    occurred_at: '2026-07-13T09:00:00.000Z',
    severity: 'low',
    payload: { session_id: `s_${id}`, visible: true, padding: 'x'.repeat(extraBytes) },
  } as unknown as CodeskopEvent;
}

function randomBase64(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Buffer.from(buf).toString('base64');
}

// Checked with a top-level `await`, not inside `beforeAll` — `describe.runIf`/
// `describe.skipIf` below evaluate their condition synchronously while Vitest
// *collects* this file (before any lifecycle hook runs), so a `beforeAll`
// assigning `mockReachable` later would always be too late to affect either
// gate; a plain module-level `let mockReachable = true` default would make
// `describe.runIf(mockReachable)` run unconditionally regardless of whether
// the mock is actually up. Vitest awaits a test file's own top-level
// `Promise`s during collection, so this genuinely gates on the real check.
const mockReachable = await isMockReachable();
if (!mockReachable) {
  console.warn(`mock ingest server not reachable at ${MOCK_INGEST_URL}; skipping FetchTransport vs-mock tests`);
}

describe.runIf(mockReachable)('FetchTransport vs the real mock ingest server', () => {
  it('delivers a valid batch: 2xx, ok, no rejects (happy path)', async () => {
    const transport = new FetchTransport({
      endpoint: MOCK_INGEST_URL,
      apiKey: 'cs_test_pk_fetch_happy',
    });
    const { batches } = await buildBatches([heartbeat('h1'), heartbeat('h2')], context);
    expect(batches).toHaveLength(1);

    const result = await transport.send(batches[0] as BatchEnvelope);

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.retryable).toBe(false);
    expect(result.rejected).toBeUndefined();
  });

  it('reports a partial reject for the one malformed event in an otherwise-valid batch', async () => {
    const transport = new FetchTransport({
      endpoint: MOCK_INGEST_URL,
      apiKey: 'cs_test_pk_fetch_partial',
    });
    const good = heartbeat('good_1');
    // Missing `occurred_at` — server.py's validate_event rejects this one
    // event without failing the whole batch.
    const bad = {
      event_id: 'bad_1',
      type: 'heartbeat',
      severity: 'low',
      payload: { session_id: 's', visible: true },
    };
    const envelope: BatchEnvelope = {
      sent_at: new Date().toISOString(),
      context: {
        device,
        app: { ...context.app, origin: context.app.origin as string } as AppContext,
      },
      batch: [good, bad as unknown as CodeskopEvent],
    };

    const result = await transport.send(envelope);

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.rejected).toEqual(['bad_1']);
  });

  it('rejects a secret key with a permanent (non-retryable) failure', async () => {
    const transport = new FetchTransport({
      endpoint: MOCK_INGEST_URL,
      apiKey: 'cs_test_sk_should_never_be_sent',
    });
    const { batches } = await buildBatches([heartbeat('h1')], context);

    const result = await transport.send(batches[0] as BatchEnvelope);

    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
    expect(result.retryable).toBe(false);
  });

  it('splits an oversized batch (>100 events) into ≤100-event requests, all accepted', async () => {
    const events = Array.from({ length: 250 }, (_, i) => heartbeat(`h${i}`));
    const { batches, droppedOversized } = await buildBatches(events, context);

    expect(droppedOversized).toEqual([]);
    expect(batches.every((b) => b.batch.length <= 100)).toBe(true);
    expect(batches.reduce((sum, b) => sum + b.batch.length, 0)).toBe(250);

    const transport = new FetchTransport({
      endpoint: MOCK_INGEST_URL,
      apiKey: 'cs_test_pk_fetch_oversize_count',
    });
    const results = await Promise.all(batches.map((batch) => transport.send(batch)));

    expect(results.every((r) => r.ok && r.status === 200)).toBe(true);
  });

  it('drops an event over the 64 KB per-event cap and still delivers the rest', async () => {
    const events = [heartbeat('small_1'), heartbeat('too_big', 100_000)];
    const { batches, droppedOversized } = await buildBatches(events, context);

    expect(droppedOversized).toEqual(['too_big']);
    expect(batches).toHaveLength(1);

    const transport = new FetchTransport({
      endpoint: MOCK_INGEST_URL,
      apiKey: 'cs_test_pk_fetch_oversize_event',
    });
    const result = await transport.send(batches[0] as BatchEnvelope);

    expect(result.ok).toBe(true);
    expect(batches[0]?.batch.map((e) => e.event_id)).toEqual(['small_1']);
  });

  it('splits a batch whose real gzip output would exceed 1 MB compressed, and delivers every piece', async () => {
    // Base64 of random bytes carries ~6 bits of entropy per 8-bit char, so it
    // resists gzip enough that ~40 events of it (each ~44 KB, safely under the
    // 64 KB per-event cap) comfortably clears 1 MB even after compression,
    // forcing the real (non-stubbed) compressor to split.
    const events = Array.from({ length: 40 }, (_, i) => ({
      event_id: `big_${i}`,
      type: 'heartbeat' as const,
      occurred_at: '2026-07-13T09:00:00.000Z',
      severity: 'low' as const,
      payload: { session_id: `s_${i}`, visible: true, blob: randomBase64(33_000) },
    }));

    const { batches, droppedOversized } = await buildBatches(
      events as unknown as CodeskopEvent[],
      context,
    );

    expect(droppedOversized).toEqual([]);
    expect(batches.length).toBeGreaterThan(1); // the split actually happened
    expect(batches.flatMap((b) => b.batch.map((e) => e.event_id)).sort()).toEqual(
      events.map((e) => e.event_id).sort(),
    );

    const transport = new FetchTransport({
      endpoint: MOCK_INGEST_URL,
      apiKey: 'cs_test_pk_fetch_oversize_bytes',
    });
    const results = await Promise.all(batches.map((batch) => transport.send(batch)));

    expect(results.every((r) => r.ok && r.status === 200)).toBe(true);
  }, 20_000);
});

describe.skipIf(mockReachable)('FetchTransport vs the real mock ingest server (skipped)', () => {
  it(`skipped because the mock ingest server is not reachable at ${MOCK_INGEST_URL}`, () => {
    expect(true).toBe(true);
  });
});

describe('FetchTransport vs a controlled HTTP stub (5xx retry, gzip, headers)', () => {
  let stub: HttpStub;

  beforeAll(async () => {
    stub = await startHttpStub();
  });

  afterAll(async () => {
    await stub.close();
  });

  afterEach(() => {
    stub.requests.length = 0;
  });

  it('retries a transient 5xx with backoff and eventually succeeds', async () => {
    stub.queueResponses([
      { status: 503, body: '{"error":"temporarily unavailable"}' },
      { status: 200, body: '{}' },
    ]);

    const delays: number[] = [];
    const transport = new FetchTransport({
      endpoint: stub.baseUrl,
      apiKey: 'cs_test_pk_retry',
      maxRetries: 3,
      backoff: { baseMs: 10, maxMs: 100, random: () => 1 },
      delay: async (ms) => {
        delays.push(ms);
      },
    });
    const { batches } = await buildBatches([heartbeat('r1')], context);

    const result = await transport.send(batches[0] as BatchEnvelope);

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(stub.requests).toHaveLength(2); // one 503, one 200 — no more attempts once non-retryable
    expect(delays).toEqual([10]); // a single backoff wait, before the second (successful) attempt
  });

  it('exhausts retries against a persistently-failing server and reports retryable', async () => {
    stub.queueResponses([{ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }]);

    const transport = new FetchTransport({
      endpoint: stub.baseUrl,
      apiKey: 'cs_test_pk_retry_exhausted',
      maxRetries: 2,
      backoff: { baseMs: 1, maxMs: 1, random: () => 0 },
      delay: async () => {},
    });
    const { batches } = await buildBatches([heartbeat('r2')], context);

    const result = await transport.send(batches[0] as BatchEnvelope);

    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
    expect(stub.requests).toHaveLength(3); // 1 initial + 2 retries = maxRetries + 1
  });

  it('does not retry a permanent 4xx', async () => {
    stub.queueResponses([{ status: 400, body: '{"error":"bad envelope"}' }]);

    const transport = new FetchTransport({
      endpoint: stub.baseUrl,
      apiKey: 'cs_test_pk_permanent',
      maxRetries: 5,
      delay: async () => {},
    });
    const { batches } = await buildBatches([heartbeat('r3')], context);

    const result = await transport.send(batches[0] as BatchEnvelope);

    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.retryable).toBe(false);
    expect(stub.requests).toHaveLength(1);
  });

  it('treats a network-level failure (nothing listening) as retryable', async () => {
    const transport = new FetchTransport({
      endpoint: 'http://127.0.0.1:1', // reserved/unassigned port — connection refused
      apiKey: 'cs_test_pk_network_error',
      maxRetries: 1,
      delay: async () => {},
    });
    const { batches } = await buildBatches([heartbeat('r4')], context);

    const result = await transport.send(batches[0] as BatchEnvelope);

    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.status).toBeUndefined();
  });

  it('sends a real gzip-encoded body with the correct Content-Encoding and no client-set Origin header', async () => {
    stub.queueResponses([{ status: 200, body: '{}' }]);

    const transport = new FetchTransport({
      endpoint: stub.baseUrl,
      apiKey: 'cs_test_pk_gzip_check',
    });
    const events = [heartbeat('g1', 5_000), heartbeat('g2', 5_000)];
    const { batches } = await buildBatches(events, context);

    await transport.send(batches[0] as BatchEnvelope);

    expect(stub.requests).toHaveLength(1);
    const request = stub.requests[0];
    if (!request) throw new Error('expected a recorded request');

    expect(request.headers['content-encoding']).toBe('gzip');
    expect(request.headers.authorization).toBe('Bearer cs_test_pk_gzip_check');
    expect(request.headers.origin).toBeUndefined(); // we never set Origin ourselves

    // Real gzip magic number, and it actually decompresses to the envelope we sent.
    expect(request.body[0]).toBe(0x1f);
    expect(request.body[1]).toBe(0x8b);
    const decompressed = gunzipSync(request.body).toString('utf-8');
    expect(JSON.parse(decompressed)).toEqual(batches[0]);
    expect(request.body.length).toBeLessThan(Buffer.byteLength(decompressed));
  });
});
