import { describe, expect, it } from 'vitest';
import {
  CONFIG_CACHE_KEY,
  readCachedConfig,
  resolveDefaultStorage,
  writeCachedConfig,
} from './cache.js';
import type { RemoteConfig } from '../model/types.js';
import type { StorageLike } from './cache.js';

const CONFIG: RemoteConfig = {
  enabled: true,
  sample_rates: { api_timing: 0.5 },
  features: { network: true },
  max_queue_mb: 8,
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

describe('readCachedConfig / writeCachedConfig', () => {
  it('round-trips a written config', () => {
    const storage = fakeStorage();
    writeCachedConfig(storage, CONFIG);
    expect(readCachedConfig(storage)).toEqual(CONFIG);
  });

  it('returns undefined when nothing has been cached yet', () => {
    expect(readCachedConfig(fakeStorage())).toBeUndefined();
  });

  it('returns undefined when storage is absent', () => {
    expect(readCachedConfig(undefined)).toBeUndefined();
    expect(() => writeCachedConfig(undefined, CONFIG)).not.toThrow();
  });

  it('returns undefined and does not throw on corrupt JSON', () => {
    const storage = fakeStorage();
    storage.setItem(CONFIG_CACHE_KEY, '{not json');
    expect(readCachedConfig(storage)).toBeUndefined();
  });

  it('returns undefined and does not throw when the cached value is well-formed JSON but not a RemoteConfig', () => {
    const storage = fakeStorage();
    storage.setItem(CONFIG_CACHE_KEY, JSON.stringify({ hello: 'world' }));
    expect(readCachedConfig(storage)).toBeUndefined();
  });

  it('swallows a getItem that throws (e.g. disabled storage)', () => {
    const storage: StorageLike = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {},
      removeItem: () => {},
    };
    expect(readCachedConfig(storage)).toBeUndefined();
  });

  it('swallows a setItem that throws (e.g. quota exceeded)', () => {
    const storage: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {},
    };
    expect(() => writeCachedConfig(storage, CONFIG)).not.toThrow();
  });
});

describe('resolveDefaultStorage', () => {
  it('returns the jsdom-provided localStorage global', () => {
    const storage = resolveDefaultStorage();
    expect(storage).toBeDefined();
    storage?.setItem('codeskop:probe', '1');
    expect(storage?.getItem('codeskop:probe')).toBe('1');
    storage?.removeItem('codeskop:probe');
  });
});
