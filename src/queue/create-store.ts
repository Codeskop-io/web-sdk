/**
 * Picks the production `QueueStore`: IndexedDB when available, the
 * in-memory fallback otherwise (`docs/02-architecture.md` §2.6's Storage
 * seam; `web-sdk-workflow.md` Phase 2).
 */
import { IndexedDbStore, type IndexedDbStoreOptions } from './indexeddb-store.js';
import { MemoryStore } from './memory-store.js';
import type { QueueStore } from './types.js';

/** Returns an `IndexedDbStore` if an `IDBFactory` is available (injected or global), else a `MemoryStore`. */
export function createQueueStore(options: IndexedDbStoreOptions = {}): QueueStore {
  const factory = options.idbFactory ?? globalThis.indexedDB;
  if (!factory) return new MemoryStore();
  return new IndexedDbStore({ ...options, idbFactory: factory });
}
