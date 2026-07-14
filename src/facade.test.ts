import { afterEach, describe, expect, it, vi } from 'vitest';
import { flush, identify, init, reset, setEnabled } from './facade.js';
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

  it('disposes the previous client before constructing the next, so network/error patches never nest', () => {
    // Each `init()` constructs a real `NetworkCapture` that patches
    // `window.fetch`, saving whatever was there as "the original" to hand
    // back on `stop()`. If the previous client were disposed *after* the
    // next one is constructed, the second patch would nest on top of the
    // first, and disposing the first would restore to *its* pre-patch
    // fetch — unwinding the second client's patch and leaving it silently
    // un-instrumented. Asserting three *different* function identities
    // (pristine → patch 1 → patch 2) and a clean return to pristine on
    // final teardown proves patches are always applied one at a time.
    const pristineFetch = window.fetch;

    init({ apiKey: 'cs_test_pk_first', endpoint: TEST_ENDPOINT });
    const firstPatchedFetch = window.fetch;
    expect(firstPatchedFetch).not.toBe(pristineFetch);

    init({ apiKey: 'cs_test_pk_second', endpoint: TEST_ENDPOINT });
    const secondPatchedFetch = window.fetch;
    expect(secondPatchedFetch).not.toBe(firstPatchedFetch);

    setActiveClient(undefined);
    expect(window.fetch).toBe(pristineFetch);
  });
});

describe('identify / reset — safe no-ops before init()', () => {
  it('never throws and delegates to nothing when there is no active client', () => {
    expect(() => identify('user_1', { plan: 'pro' })).not.toThrow();
    expect(() => reset()).not.toThrow();
  });

  it('delegates to the active client once initialized', () => {
    init({ apiKey: 'cs_test_pk_identify', endpoint: TEST_ENDPOINT });
    const client = getActiveClient();
    const identifySpy = client ? vi.spyOn(client, 'identify') : undefined;
    const resetSpy = client ? vi.spyOn(client, 'reset') : undefined;

    identify('user_1', { plan: 'pro' });
    reset();

    expect(identifySpy).toHaveBeenCalledWith('user_1', { plan: 'pro' });
    expect(resetSpy).toHaveBeenCalledTimes(1);
  });
});

describe('setEnabled — safe no-op before init()', () => {
  it('never throws when there is no active client', () => {
    expect(() => setEnabled(false)).not.toThrow();
  });

  it('delegates to the active client once initialized', () => {
    init({ apiKey: 'cs_test_pk_set_enabled', endpoint: TEST_ENDPOINT });
    const client = getActiveClient();
    const setEnabledSpy = client ? vi.spyOn(client, 'setEnabled') : undefined;

    setEnabled(false);

    expect(setEnabledSpy).toHaveBeenCalledWith(false);
  });
});

describe('flush — safe no-op before init()', () => {
  it('resolves false when there is no active client', async () => {
    await expect(flush()).resolves.toBe(false);
  });

  it('resolves true once a sync attempt actually runs against the active client', async () => {
    init({ apiKey: 'cs_test_pk_flush', endpoint: TEST_ENDPOINT });
    const client = getActiveClient();
    vi.spyOn(client!, 'flush').mockResolvedValue(true);

    await expect(flush()).resolves.toBe(true);
  });

  it('never rejects even if the underlying client throws', async () => {
    init({ apiKey: 'cs_test_pk_flush_throws', endpoint: TEST_ENDPOINT });
    const client = getActiveClient();
    vi.spyOn(client!, 'flush').mockRejectedValue(new Error('boom'));

    await expect(flush()).resolves.toBe(false);
  });
});
