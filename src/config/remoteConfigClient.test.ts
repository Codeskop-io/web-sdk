import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteConfigClient, type FetchLike } from './remoteConfigClient.js';
import { DEFAULT_REMOTE_CONFIG } from './defaults.js';
import { CONFIG_CACHE_KEY, readCachedConfig } from './cache.js';
import type { StorageLike } from './cache.js';

const LIVE_CONFIG = {
  enabled: true,
  sample_rates: { api_timing: 0.2 },
  features: { anr: true, network: true },
  max_queue_mb: 10,
};

function fakeStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, value),
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? headers[name] ?? null },
    json: async () => body,
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe('RemoteConfigClient.fetchConfig — happy path', () => {
  it('fetches, returns, and caches the config, sending the bearer key', async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValue(jsonResponse(200, LIVE_CONFIG, { etag: '"v1"' }));
    const storage = fakeStorage();
    const client = new RemoteConfigClient({
      endpoint: 'https://api.example.com',
      apiKey: 'cs_test_pk_abc',
      fetchImpl,
      storage,
    });

    const config = await client.fetchConfig();

    expect(config).toEqual({ ...LIVE_CONFIG, etag: '"v1"' });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.example.com/v1/config',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer cs_test_pk_abc' }),
      }),
    );
    expect(readCachedConfig(storage)).toEqual({ ...LIVE_CONFIG, etag: '"v1"' });
  });

  it('strips a trailing slash from the endpoint', async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, LIVE_CONFIG));
    const client = new RemoteConfigClient({
      endpoint: 'https://api.example.com/',
      apiKey: 'cs_test_pk_abc',
      fetchImpl,
    });

    await client.fetchConfig();

    expect(fetchImpl).toHaveBeenCalledWith('https://api.example.com/v1/config', expect.anything());
  });
});

describe('RemoteConfigClient.fetchConfig — feature gating & kill-switch data', () => {
  it('surfaces sample_rates, features, and max_queue_mb unchanged', async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, LIVE_CONFIG));
    const client = new RemoteConfigClient({
      endpoint: 'https://api.example.com',
      apiKey: 'cs_test_pk_abc',
      fetchImpl,
    });

    const config = await client.fetchConfig();

    expect(config.sample_rates).toEqual({ api_timing: 0.2 });
    expect(config.features).toEqual({ anr: true, network: true });
    expect(config.max_queue_mb).toBe(10);
  });

  it('honours enabled:false as a distinct field on the returned config', async () => {
    const killed = { ...LIVE_CONFIG, enabled: false };
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, killed));
    const client = new RemoteConfigClient({
      endpoint: 'https://api.example.com',
      apiKey: 'cs_test_pk_abc',
      fetchImpl,
    });

    const config = await client.fetchConfig();

    expect(config.enabled).toBe(false);
  });
});

describe('RemoteConfigClient.fetchConfig — ETag / 304 path', () => {
  it('sends If-None-Match on the second fetch, using the etag from the first response', async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(jsonResponse(200, LIVE_CONFIG, { etag: '"v1"' }))
      .mockResolvedValueOnce(jsonResponse(304, undefined));
    const client = new RemoteConfigClient({
      endpoint: 'https://api.example.com',
      apiKey: 'cs_test_pk_abc',
      fetchImpl,
    });

    const first = await client.fetchConfig();
    const second = await client.fetchConfig();

    expect(first).toEqual({ ...LIVE_CONFIG, etag: '"v1"' });
    // A 304 means "unchanged" — the previously-fetched config is returned as-is.
    expect(second).toEqual(first);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://api.example.com/v1/config',
      expect.objectContaining({ headers: expect.objectContaining({ 'If-None-Match': '"v1"' }) }),
    );
  });

  it('picks up a persisted etag from a prior session (new client instance)', async () => {
    const storage = fakeStorage();
    storage.setItem(CONFIG_CACHE_KEY, JSON.stringify({ ...LIVE_CONFIG, etag: '"persisted"' }));
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(304, undefined));
    const client = new RemoteConfigClient({
      endpoint: 'https://api.example.com',
      apiKey: 'cs_test_pk_abc',
      fetchImpl,
      storage,
    });

    const config = await client.fetchConfig();

    expect(config).toEqual({ ...LIVE_CONFIG, etag: '"persisted"' });
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        headers: expect.objectContaining({ 'If-None-Match': '"persisted"' }),
      }),
    );
  });

  it('does not send If-None-Match when there is no known etag yet', async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, LIVE_CONFIG));
    const client = new RemoteConfigClient({
      endpoint: 'https://api.example.com',
      apiKey: 'cs_test_pk_abc',
      fetchImpl,
    });

    await client.fetchConfig();

    const [, init] = fetchImpl.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers['If-None-Match']).toBeUndefined();
  });
});

describe('RemoteConfigClient.fetchConfig — failure fallback', () => {
  it('falls back to DEFAULT_REMOTE_CONFIG on a network error with no cache', async () => {
    const onError = vi.fn();
    const fetchImpl = vi.fn<FetchLike>().mockRejectedValue(new Error('network down'));
    const client = new RemoteConfigClient({
      endpoint: 'https://api.example.com',
      apiKey: 'cs_test_pk_abc',
      fetchImpl,
      onError,
    });

    await expect(client.fetchConfig()).resolves.toEqual(DEFAULT_REMOTE_CONFIG);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'config-fetch');
  });

  it('never rejects, even on a network error', async () => {
    const fetchImpl = vi.fn<FetchLike>().mockRejectedValue(new Error('network down'));
    const client = new RemoteConfigClient({
      endpoint: 'https://api.example.com',
      apiKey: 'cs_test_pk_abc',
      fetchImpl,
    });

    await expect(client.fetchConfig()).resolves.not.toThrow();
  });

  it('falls back to the last-known-good config (in-memory) on a subsequent network error', async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(jsonResponse(200, LIVE_CONFIG))
      .mockRejectedValueOnce(new Error('network down'));
    const client = new RemoteConfigClient({
      endpoint: 'https://api.example.com',
      apiKey: 'cs_test_pk_abc',
      fetchImpl,
    });

    const first = await client.fetchConfig();
    const second = await client.fetchConfig();

    expect(second).toEqual(first);
  });

  it('falls back to the persisted cache on a network error with no in-memory config yet', async () => {
    const storage = fakeStorage();
    storage.setItem(CONFIG_CACHE_KEY, JSON.stringify(LIVE_CONFIG));
    const fetchImpl = vi.fn<FetchLike>().mockRejectedValue(new Error('network down'));
    const client = new RemoteConfigClient({
      endpoint: 'https://api.example.com',
      apiKey: 'cs_test_pk_abc',
      fetchImpl,
      storage,
    });

    await expect(client.fetchConfig()).resolves.toEqual(LIVE_CONFIG);
  });

  it('falls back on a non-2xx status (e.g. 500) rather than throwing', async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(500, { error: 'boom' }));
    const client = new RemoteConfigClient({
      endpoint: 'https://api.example.com',
      apiKey: 'cs_test_pk_abc',
      fetchImpl,
    });

    await expect(client.fetchConfig()).resolves.toEqual(DEFAULT_REMOTE_CONFIG);
  });

  it('falls back on a 401 without throwing', async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValue(jsonResponse(401, { error: 'unauthorized' }));
    const client = new RemoteConfigClient({
      endpoint: 'https://api.example.com',
      apiKey: 'cs_test_pk_abc',
      fetchImpl,
    });

    await expect(client.fetchConfig()).resolves.toEqual(DEFAULT_REMOTE_CONFIG);
  });

  it('falls back when the body is well-formed JSON but not a valid RemoteConfig shape', async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValue(jsonResponse(200, { unexpected: 'shape' }));
    const client = new RemoteConfigClient({
      endpoint: 'https://api.example.com',
      apiKey: 'cs_test_pk_abc',
      fetchImpl,
    });

    await expect(client.fetchConfig()).resolves.toEqual(DEFAULT_REMOTE_CONFIG);
  });

  it('falls back when response.json() itself throws (e.g. invalid JSON body)', async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
    });
    const onError = vi.fn();
    const client = new RemoteConfigClient({
      endpoint: 'https://api.example.com',
      apiKey: 'cs_test_pk_abc',
      fetchImpl,
      onError,
    });

    await expect(client.fetchConfig()).resolves.toEqual(DEFAULT_REMOTE_CONFIG);
    expect(onError).toHaveBeenCalled();
  });

  it('falls back to DEFAULT_REMOTE_CONFIG when no fetch implementation is available at all', async () => {
    const client = new RemoteConfigClient({
      endpoint: 'https://api.example.com',
      apiKey: 'cs_test_pk_abc',
      fetchImpl: undefined,
    });

    await expect(client.fetchConfig()).resolves.toEqual(DEFAULT_REMOTE_CONFIG);
  });

  it('never lets a broken onError diagnostic handler propagate', async () => {
    const fetchImpl = vi.fn<FetchLike>().mockRejectedValue(new Error('network down'));
    const client = new RemoteConfigClient({
      endpoint: 'https://api.example.com',
      apiKey: 'cs_test_pk_abc',
      fetchImpl,
      onError: () => {
        throw new Error('diagnostic handler is broken');
      },
    });

    await expect(client.fetchConfig()).resolves.toEqual(DEFAULT_REMOTE_CONFIG);
  });
});

describe('RemoteConfigClient — construction picks up a pre-existing cache', () => {
  it('reads a config cached by a previous instance/session immediately', () => {
    const storage = fakeStorage();
    storage.setItem(CONFIG_CACHE_KEY, JSON.stringify(LIVE_CONFIG));
    new RemoteConfigClient({
      endpoint: 'https://api.example.com',
      apiKey: 'cs_test_pk_abc',
      storage,
      fetchImpl: vi.fn(),
    });

    // Sanity: the cache itself is intact and independently readable.
    expect(readCachedConfig(storage)).toEqual(LIVE_CONFIG);
  });
});
