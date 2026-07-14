/**
 * Integration-style test against the real `backend/mock-ingest-server`
 * process (`python server.py`, contract per `backend/docs/07` §7.5) rather
 * than a stubbed `fetch` — proves `RemoteConfigClient` speaks the actual
 * wire shape the mock (and eventually the real backend) serves, not just
 * the shape our own stubs assume.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { RemoteConfigClient } from './remoteConfigClient.js';

const MOCK_ENDPOINT = process.env.MOCK_INGEST_URL ?? 'http://localhost:8080';

// Checked with a top-level `await`, not inside `beforeAll` — `describe.runIf`/
// `describe.skipIf` evaluate their condition synchronously while Vitest
// *collects* this file (before any lifecycle hook runs), so a `beforeAll`
// assigning `mockReachable` later would always be too late to affect either
// gate; a plain module-level `let mockReachable = true` default would make
// `describe.runIf(mockReachable)` run unconditionally regardless of whether
// the mock is actually up. Vitest awaits a test file's own top-level
// `Promise`s during collection, so this genuinely gates on the real check.
const mockReachable = await (async () => {
  try {
    const res = await fetch(`${MOCK_ENDPOINT}/v1/config`);
    return res.ok;
  } catch {
    return false;
  }
})();

beforeEach(() => {
  localStorage.clear();
});

describe.runIf(mockReachable)('RemoteConfigClient vs the real mock ingest server', () => {
  it('fetches the mock’s static config over a real HTTP request', async () => {
    const client = new RemoteConfigClient({
      endpoint: MOCK_ENDPOINT,
      apiKey: 'cs_test_pk_integration',
    });

    const config = await client.fetchConfig();

    // Mirrors mock-ingest-server/server.py's STATIC_CONFIG exactly.
    expect(config.enabled).toBe(true);
    expect(config.sample_rates).toEqual({ api_timing: 0.2 });
    expect(config.features).toEqual({ anr: true, network: true });
    expect(config.max_queue_mb).toBe(10);
  });

  it('caches the mock’s response as the last-known-good config', async () => {
    const client = new RemoteConfigClient({
      endpoint: MOCK_ENDPOINT,
      apiKey: 'cs_test_pk_integration',
    });

    await client.fetchConfig();

    const cached = localStorage.getItem('codeskop:config:v1');
    expect(cached).not.toBeNull();
    expect(JSON.parse(cached ?? '{}')).toMatchObject({ enabled: true, max_queue_mb: 10 });
  });

  it('falls back safely when pointed at a path the mock does not serve', async () => {
    const client = new RemoteConfigClient({
      endpoint: `${MOCK_ENDPOINT}/does-not-exist`,
      apiKey: 'cs_test_pk_integration',
    });

    // The mock 404s anything but /v1/config at the root; requesting through a
    // bogus base path exercises the real non-2xx fallback path end-to-end.
    await expect(client.fetchConfig()).resolves.toMatchObject({ enabled: true });
  });
});

describe.skipIf(mockReachable)(
  'RemoteConfigClient vs the real mock ingest server (skipped)',
  () => {
    it('skipped because the mock ingest server is not reachable at ' + MOCK_ENDPOINT, () => {
      expect(true).toBe(true);
    });
  },
);
