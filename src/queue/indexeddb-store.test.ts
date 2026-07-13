import { describe, expect, it } from 'vitest';
import type { CodeskopEvent } from '../model/types.js';
import { DEFAULT_STORE_NAME, IndexedDbStore } from './indexeddb-store.js';
import type { QueueRecord } from './types.js';

let dbCounter = 0;
function uniqueDbName(): string {
  dbCounter += 1;
  return `codeskop-idb-store-test-${dbCounter}`;
}

function makeRecord(eventId: string, seq: number): QueueRecord {
  const event: CodeskopEvent = {
    event_id: eventId,
    type: 'api_timing',
    occurred_at: '2026-07-13T00:00:00.000Z',
    severity: 'low',
    payload: { method: 'GET', host: 'example.com', path: '/x', duration_ms: 1 },
  };
  return { eventId, seq, sizeBytes: JSON.stringify(event).length, critical: false, event };
}

/** Writes a raw row directly through the global `indexedDB`, bypassing `IndexedDbStore.put`'s type safety. */
function rawPut(dbName: string, storeName: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(value);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    request.onerror = () => reject(request.error);
  });
}

describe('IndexedDbStore', () => {
  it('round-trips put/loadAll/delete', async () => {
    const dbName = uniqueDbName();
    const store = new IndexedDbStore({ dbName });
    const record = makeRecord('evt-1', 0);

    await store.put(record);
    await expect(store.loadAll()).resolves.toEqual([record]);

    await store.delete(['evt-1']);
    await expect(store.loadAll()).resolves.toEqual([]);

    await store.close();
  });

  it('skips a corrupt row on read instead of throwing, and cleans it up', async () => {
    const dbName = uniqueDbName();
    const store = new IndexedDbStore({ dbName });
    const good = makeRecord('evt-good', 0);
    await store.put(good);

    // Missing seq/sizeBytes/critical/event — still has the keyPath, so the raw write succeeds.
    await rawPut(dbName, DEFAULT_STORE_NAME, { eventId: 'evt-corrupt' });

    const loaded = await store.loadAll();
    expect(loaded).toEqual([good]);

    // The corrupt row was deleted as part of the first load; a second load is unaffected.
    await expect(store.loadAll()).resolves.toEqual([good]);

    await store.close();
  });

  it.each([
    { label: 'non-string eventId', row: { eventId: 42 } },
    { label: 'missing seq', row: { eventId: 'c1', extra: true } },
    { label: 'missing sizeBytes', row: { eventId: 'c2', seq: 0 } },
    { label: 'missing critical flag', row: { eventId: 'c3', seq: 0, sizeBytes: 10 } },
    { label: 'missing event payload', row: { eventId: 'c4', seq: 0, sizeBytes: 10, critical: false } },
    {
      label: 'event missing required fields',
      row: { eventId: 'c5', seq: 0, sizeBytes: 10, critical: false, event: { event_id: 'e5' } },
    },
  ])('skips a corrupt row: $label', async ({ row }) => {
    const dbName = uniqueDbName();
    const store = new IndexedDbStore({ dbName });
    await store.loadAll(); // opens the db, creating the object store, before the raw write below
    await rawPut(dbName, DEFAULT_STORE_NAME, row);
    await expect(store.loadAll()).resolves.toEqual([]);
    await store.close();
  });

  it('isolates records by database name', async () => {
    const storeA = new IndexedDbStore({ dbName: uniqueDbName() });
    const storeB = new IndexedDbStore({ dbName: uniqueDbName() });

    await storeA.put(makeRecord('evt-a', 0));
    await expect(storeA.loadAll()).resolves.toHaveLength(1);
    await expect(storeB.loadAll()).resolves.toHaveLength(0);

    await storeA.close();
    await storeB.close();
  });

  it('close is safe to call without ever having opened a connection, and more than once', async () => {
    const store = new IndexedDbStore({ dbName: uniqueDbName() });
    await expect(store.close()).resolves.toBeUndefined();
    await expect(store.close()).resolves.toBeUndefined();
  });

  it('falls back to the global indexedDB when idbFactory is omitted', () => {
    expect(() => new IndexedDbStore({ idbFactory: undefined, dbName: uniqueDbName() })).not.toThrow();
  });

  it('throws synchronously when constructed with no IDBFactory available anywhere', () => {
    const original = globalThis.indexedDB;
    // @ts-expect-error simulating an environment without IndexedDB
    delete globalThis.indexedDB;
    try {
      expect(() => new IndexedDbStore({ dbName: uniqueDbName() })).toThrow(/IndexedDB is not available/);
    } finally {
      globalThis.indexedDB = original;
    }
  });
});
