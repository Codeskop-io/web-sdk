import { describe, expect, it } from 'vitest';
import { createQueueStore } from './create-store.js';
import { IndexedDbStore } from './indexeddb-store.js';
import { MemoryStore } from './memory-store.js';

describe('createQueueStore', () => {
  it('returns an IndexedDbStore when an IDBFactory is available', () => {
    const store = createQueueStore({ dbName: 'codeskop-create-store-test' });
    expect(store).toBeInstanceOf(IndexedDbStore);
  });

  it('falls back to MemoryStore when no IDBFactory is available anywhere', () => {
    const original = globalThis.indexedDB;
    // @ts-expect-error simulating an environment without IndexedDB (e.g. a locked-down embed)
    delete globalThis.indexedDB;
    try {
      const store = createQueueStore({});
      expect(store).toBeInstanceOf(MemoryStore);
    } finally {
      globalThis.indexedDB = original;
    }
  });

  it('prefers an explicitly injected idbFactory over the global', () => {
    const store = createQueueStore({ idbFactory: globalThis.indexedDB, dbName: 'codeskop-create-store-test-2' });
    expect(store).toBeInstanceOf(IndexedDbStore);
  });
});
