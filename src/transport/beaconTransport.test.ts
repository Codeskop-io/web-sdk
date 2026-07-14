/**
 * `BeaconTransport` tests. The `sendBeacon`-available path is exercised with
 * an injected `sendBeaconImpl` — jsdom (like real Node) has no
 * `navigator.sendBeacon` (see `docs/02` §2.4 / the module doc), so a genuine
 * browser call can't be driven from here; the injected function still
 * receives the exact URL/Blob our code builds; we assert on its real content
 * (bytes, type) rather than on a canned return value. The absence-of-
 * `sendBeacon` fallback path is a real `fetch` and is covered with actual
 * sockets: the mock ingest server (skipped if unreachable) and a controlled
 * HTTP stub for the no-retry assertion.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { BatchEnvelope, CodeskopEvent, DeviceContext } from '../model/types.js';
import { buildBatches, type BuildBatchesContext } from './envelope.js';
import { BeaconTransport } from './beaconTransport.js';
import { startHttpStub, type HttpStub } from './testSupport/httpStub.js';
import { isMockReachable, MOCK_INGEST_URL } from './testSupport/mockIngest.js';

const device: DeviceContext = {
  install_id: 'inst_beacon_test',
  platform: 'web',
  user_agent: 'vitest',
  locale: 'en-KE',
  screen: '1920x1080',
  viewport: '1280x720',
};

const context: BuildBatchesContext = {
  device,
  app: { page: '/checkout', sdk_version: '0.1.0-beta.0', origin: 'https://app.customer.com' },
};

function heartbeat(id: string): CodeskopEvent {
  return {
    event_id: id,
    type: 'heartbeat',
    occurred_at: '2026-07-13T09:00:00.000Z',
    severity: 'low',
    payload: { session_id: `s_${id}`, visible: true },
  };
}

async function buildOne(): Promise<BatchEnvelope> {
  const { batches } = await buildBatches([heartbeat('b1'), heartbeat('b2')], context);
  const batch = batches[0];
  if (!batch) throw new Error('expected exactly one batch');
  return batch;
}

describe('BeaconTransport — sendBeacon available (injected)', () => {
  it('sends the key as a query param and the raw uncompressed JSON as the Blob body (no custom headers possible)', async () => {
    let capturedUrl = '';
    let capturedBlob: Blob | undefined;
    const sendBeaconImpl = (url: string, data?: BodyInit | null) => {
      capturedUrl = url;
      capturedBlob = data as Blob;
      return true;
    };

    const transport = new BeaconTransport({
      endpoint: 'https://ingest.codeskop.com',
      apiKey: 'cs_test_pk_beacon',
      sendBeaconImpl,
    });
    const batch = await buildOne();

    const result = await transport.send(batch);

    expect(capturedUrl).toBe('https://ingest.codeskop.com/v1/events?key=cs_test_pk_beacon');
    expect(capturedBlob).toBeInstanceOf(Blob);
    expect(capturedBlob?.type).toBe('application/json');
    const text = await capturedBlob?.text();
    expect(text).toBe(JSON.stringify(batch)); // uncompressed — sendBeacon can't set Content-Encoding
    // Optimistic ok: sendBeacon only reports "queued", never the server's response.
    expect(result).toEqual({ ok: true, retryable: false });
  });

  it('reports retryable when the browser refuses to queue the beacon', async () => {
    const transport = new BeaconTransport({
      endpoint: 'https://ingest.codeskop.com',
      apiKey: 'cs_test_pk_beacon',
      sendBeaconImpl: () => false,
    });
    const batch = await buildOne();

    const result = await transport.send(batch);

    expect(result).toEqual({ ok: false, retryable: true });
  });

  it('URL-encodes an apiKey with characters that would otherwise break the query string', async () => {
    let capturedUrl = '';
    const transport = new BeaconTransport({
      endpoint: 'https://ingest.codeskop.com',
      apiKey: 'cs_test_pk_has&weird=chars',
      sendBeaconImpl: (url) => {
        capturedUrl = url;
        return true;
      },
    });
    const batch = await buildOne();

    await transport.send(batch);

    expect(capturedUrl).toBe(
      'https://ingest.codeskop.com/v1/events?key=cs_test_pk_has%26weird%3Dchars',
    );
  });
});

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
  console.warn(`mock ingest server not reachable at ${MOCK_INGEST_URL}; skipping BeaconTransport vs-mock tests`);
}

describe.runIf(mockReachable)(
  'BeaconTransport — sendBeacon unavailable, real fetch fallback vs the mock',
  () => {
    it('falls back to a real, fully-authenticated, gzip-compressed fetch and gets a genuine 2xx', async () => {
      // No `sendBeaconImpl` supplied and no global `navigator.sendBeacon` in
      // this test environment (jsdom) — exactly the "unit tests can still run"
      // case the workflow calls out.
      const transport = new BeaconTransport({
        endpoint: MOCK_INGEST_URL,
        apiKey: 'cs_test_pk_beacon_fallback',
      });
      const batch = await buildOne();

      const result = await transport.send(batch);

      expect(result.ok).toBe(true);
      expect(result.status).toBe(200);
    });
  },
);

describe.skipIf(mockReachable)(
  'BeaconTransport fallback vs the real mock ingest server (skipped)',
  () => {
    it(`skipped because the mock ingest server is not reachable at ${MOCK_INGEST_URL}`, () => {
      expect(true).toBe(true);
    });
  },
);

describe('BeaconTransport — sendBeacon unavailable, fallback vs a controlled HTTP stub', () => {
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

  it('never retries on the fallback path, even on a 5xx (the page may already be gone)', async () => {
    stub.queueResponses([{ status: 503 }]);
    const transport = new BeaconTransport({
      endpoint: stub.baseUrl,
      apiKey: 'cs_test_pk_beacon_no_retry',
    });
    const batch = await buildOne();

    const result = await transport.send(batch);

    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true); // still marked retryable for the *next* load's durable queue
    expect(stub.requests).toHaveLength(1); // but no retry loop was run here
  });

  it('fallback path is real, authenticated, and gzip-compressed', async () => {
    stub.queueResponses([{ status: 200, body: '{}' }]);
    const transport = new BeaconTransport({
      endpoint: stub.baseUrl,
      apiKey: 'cs_test_pk_beacon_gzip',
    });
    const batch = await buildOne();

    await transport.send(batch);

    const request = stub.requests[0];
    if (!request) throw new Error('expected a recorded request');
    expect(request.headers['content-encoding']).toBe('gzip');
    expect(request.headers.authorization).toBe('Bearer cs_test_pk_beacon_gzip');
  });

  it('reports a network error on the fallback path as retryable', async () => {
    const transport = new BeaconTransport({
      endpoint: 'http://127.0.0.1:1',
      apiKey: 'cs_test_pk_beacon_network',
    });
    const batch = await buildOne();

    const result = await transport.send(batch);

    expect(result).toEqual({ ok: false, retryable: true });
  });
});
