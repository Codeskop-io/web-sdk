/**
 * The production `QueueStore` — a single `keyPath: 'eventId'` object store in
 * IndexedDB, one row per queued event (`web-sdk-workflow.md` Phase 2,
 * `docs/02-architecture.md` §2.6). Any row that doesn't shape-check as a
 * `QueueRecord` is dropped during `loadAll` rather than surfaced — a corrupt
 * row must never wedge the whole queue.
 */
import type { CodeskopEvent } from '../model/types.js';
import type { QueueRecord, QueueStore } from './types.js';

export const DEFAULT_DB_NAME = 'codeskop-tracker-queue';
export const DEFAULT_STORE_NAME = 'events';
const DB_VERSION = 1;

export interface IndexedDbStoreOptions {
  /** The IndexedDB database name. Distinct SDK instances/tests isolate by name. */
  dbName?: string;
  /** The object store (table) name within the database. */
  storeName?: string;
  /** Injectable `IDBFactory`, for tests. Defaults to the global `indexedDB`. */
  idbFactory?: IDBFactory;
}

/** Thrown internally when a stored row doesn't shape-check as a `QueueRecord`; never escapes `loadAll`. */
class MalformedRecordError extends Error {}

function isCodeskopEvent(value: unknown): value is CodeskopEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.event_id === 'string' &&
    typeof event.type === 'string' &&
    typeof event.occurred_at === 'string' &&
    typeof event.severity === 'string' &&
    'payload' in event
  );
}

/** Validates + narrows a raw stored row; throws `MalformedRecordError` on anything unexpected. */
function toQueueRecord(raw: unknown): QueueRecord {
  if (!raw || typeof raw !== 'object') throw new MalformedRecordError('row is not an object');
  const row = raw as Record<string, unknown>;

  if (typeof row.eventId !== 'string' || row.eventId.length === 0) {
    throw new MalformedRecordError('missing eventId');
  }
  if (typeof row.seq !== 'number' || !Number.isFinite(row.seq)) {
    throw new MalformedRecordError('missing seq');
  }
  if (typeof row.sizeBytes !== 'number' || !Number.isFinite(row.sizeBytes)) {
    throw new MalformedRecordError('missing sizeBytes');
  }
  if (typeof row.critical !== 'boolean') {
    throw new MalformedRecordError('missing critical flag');
  }
  if (!isCodeskopEvent(row.event)) {
    throw new MalformedRecordError('missing/invalid event payload');
  }

  return {
    eventId: row.eventId,
    seq: row.seq,
    sizeBytes: row.sizeBytes,
    critical: row.critical,
    event: row.event,
  };
}

/** IndexedDB-backed `QueueStore`. One row per `QueueRecord`, keyed by `eventId`. */
export class IndexedDbStore implements QueueStore {
  private readonly dbName: string;
  private readonly storeName: string;
  private readonly idb: IDBFactory;
  private dbPromise?: Promise<IDBDatabase>;

  constructor(options: IndexedDbStoreOptions = {}) {
    this.dbName = options.dbName ?? DEFAULT_DB_NAME;
    this.storeName = options.storeName ?? DEFAULT_STORE_NAME;
    const factory = options.idbFactory ?? globalThis.indexedDB;
    if (!factory) {
      throw new Error('IndexedDB is not available in this environment.');
    }
    this.idb = factory;
  }

  private openDb(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const request = this.idb.open(this.dbName, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(this.storeName)) {
            db.createObjectStore(this.storeName, { keyPath: 'eventId' });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('Failed to open the queue database.'));
        request.onblocked = () => reject(new Error('Opening the queue database is blocked.'));
      });
    }
    return this.dbPromise;
  }

  async loadAll(): Promise<QueueRecord[]> {
    const db = await this.openDb();
    const results: QueueRecord[] = [];
    const corruptKeys: string[] = [];

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readonly');
      const cursorRequest = tx.objectStore(this.storeName).openCursor();

      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return; // exhausted; tx.oncomplete settles the outer promise
        try {
          results.push(toQueueRecord(cursor.value));
        } catch {
          // Corrupt/undeserializable row: skip it and mark it for cleanup —
          // never let one bad row wedge the read.
          const key = (cursor.value as Record<string, unknown> | undefined)?.eventId;
          if (typeof key === 'string') corruptKeys.push(key);
        }
        cursor.continue();
      };
      cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error('Failed to read the queue store.'));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Queue read transaction failed.'));
      tx.onabort = () => reject(tx.error ?? new Error('Queue read transaction aborted.'));
    });

    if (corruptKeys.length > 0) {
      // Best-effort cleanup; if this fails the row is simply skipped again next load.
      await this.delete(corruptKeys).catch(() => {});
    }
    return results;
  }

  async put(record: QueueRecord): Promise<void> {
    const db = await this.openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readwrite');
      tx.objectStore(this.storeName).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Queue write transaction failed.'));
      tx.onabort = () => reject(tx.error ?? new Error('Queue write transaction aborted.'));
    });
  }

  async delete(eventIds: string[]): Promise<void> {
    if (eventIds.length === 0) return;
    const db = await this.openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readwrite');
      const store = tx.objectStore(this.storeName);
      for (const eventId of eventIds) store.delete(eventId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Queue delete transaction failed.'));
      tx.onabort = () => reject(tx.error ?? new Error('Queue delete transaction aborted.'));
    });
  }

  /** Closes the underlying connection, if one was opened. Safe to call more than once. */
  async close(): Promise<void> {
    if (!this.dbPromise) return;
    const db = await this.dbPromise.catch(() => undefined);
    db?.close();
    this.dbPromise = undefined;
  }
}
