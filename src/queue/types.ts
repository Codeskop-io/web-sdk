/**
 * Storage-layer types for the durable queue (`web-sdk-workflow.md` Phase 2).
 * `QueueStore` is the seam between the cap/eviction policy in
 * `durable-queue.ts` and the concrete backend (`IndexedDbStore` in
 * production, `MemoryStore` as the fallback/test double) — the queue's own
 * instance of the `Storage` seam in `docs/02-architecture.md` §2.6.
 */
import type { CodeskopEvent } from '../model/types.js';

/** A queued event plus the bookkeeping the cap/eviction policy needs, as persisted. */
export interface QueueRecord {
  /** Mirrors `event.event_id`; the store's primary key. */
  eventId: string;
  /** Monotonic insertion order — the drop-oldest tiebreaker, stable across reloads. */
  seq: number;
  /** Precomputed by `estimateEventBytes`, cached so eviction never re-serializes. */
  sizeBytes: number;
  /** Precomputed by `isCriticalEvent`, cached for the same reason. */
  critical: boolean;
  event: CodeskopEvent;
}

/** The storage backend seam a `DurableQueue` persists through. */
export interface QueueStore {
  /**
   * Loads every persisted record. A record that fails to deserialize/validate
   * is skipped rather than thrown — resilience against a corrupt row is this
   * method's job, not its caller's.
   */
  loadAll(): Promise<QueueRecord[]>;
  /** Persists (inserts or overwrites) one record. */
  put(record: QueueRecord): Promise<void>;
  /** Removes records by `eventId`; ids not present are silently ignored. */
  delete(eventIds: string[]): Promise<void>;
  /** Releases any underlying connection. Safe to call more than once. Optional: `MemoryStore` has nothing to release. */
  close?(): Promise<void>;
}
