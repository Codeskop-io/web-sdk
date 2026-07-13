import { afterEach, describe, expect, it, vi } from 'vitest';
import { init } from './facade.js';
import { getActiveClient, setActiveClient } from './runtime/client.js';

// A reserved/unassigned port (connection refused near-instantly) — the same
// convention `fetchTransport.integration.test.ts` uses — so these tests never
// attempt a real network call to the production default endpoint.
const TEST_ENDPOINT = 'http://127.0.0.1:1';

afterEach(() => {
  setActiveClient(undefined);
  document.querySelectorAll('script').forEach((script) => script.remove());
});

describe('init', () => {
  it('returns synchronously and activates a client for a valid public key', () => {
    init({ apiKey: 'cs_test_pk_facade', endpoint: TEST_ENDPOINT });
    expect(getActiveClient()).toBeDefined();
  });

  it('disables the SDK fail-soft for a secret key rather than throwing', () => {
    expect(() =>
      init({ apiKey: 'cs_test_sk_should_never_be_sent', endpoint: TEST_ENDPOINT }),
    ).not.toThrow();
    expect(getActiveClient()).toBeUndefined();
  });

  it('disables the SDK fail-soft for a malformed key rather than throwing', () => {
    expect(() => init({ apiKey: 'not-a-codeskop-key', endpoint: TEST_ENDPOINT })).not.toThrow();
    expect(getActiveClient()).toBeUndefined();
  });

  it('never throws even if something downstream misbehaves', () => {
    expect(() => init(null as unknown as Parameters<typeof init>[0])).not.toThrow();
  });

  it('a second call replaces (and disposes) the previously active client', () => {
    init({ apiKey: 'cs_test_pk_first', endpoint: TEST_ENDPOINT });
    const first = getActiveClient();
    const disposeSpy = first ? vi.spyOn(first, 'dispose') : undefined;

    init({ apiKey: 'cs_test_pk_second', endpoint: TEST_ENDPOINT });

    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(getActiveClient()).not.toBe(first);
  });
});
