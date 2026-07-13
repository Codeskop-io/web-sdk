/**
 * `DurableQueue` — the `QueueLike` implementation (`src/model/types.ts`):
 * offline-first, byte-capped with drop-oldest-plus-a-critical-reserve,
 * idempotent by `event_id`, and resilient to a failed/corrupt load
 * (`web-sdk-workflow.md` Phase 2, `docs/02-architecture.md` §2.5-2.6).
 *
 * Enqueue/peek/ack never throw: if the very first load of the backing store
 * fails outright, the queue degrades to an empty in-memory one rather than
 * wedging the SDK — the same structural guarantee `safely()` gives capture
 * hooks (D4's prime directive), applied here to storage instead of host code.
 *
 * Byte-cap policy: the configured cap is split into a critical slice
 * (`criticalReserveRatio`, sized by `isCriticalEvent`) and the remaining
 * shared slice. Non-critical events are hard-capped at the shared slice —
 * they can never grow into the reserve — so a flood of low-severity events
 * can't evict a critical one, regardless of arrival order. Critical events
 * may use the whole cap: they evict the oldest non-critical events first
 * and, only once none remain, the oldest critical ones.
 */
import type { DiagnosticHandler } from '../core/safely.js';
import type { CodeskopEvent, QueueLike } from '../model/types.js';
import { estimateEventBytes } from './byte-size.js';
import { createQueueStore } from './create-store.js';
import { MemoryStore } from './memory-store.js';
import { clampReserveRatio, DEFAULT_CRITICAL_RESERVE_RATIO, isCriticalEvent } from './policy.js';
import type { QueueRecord, QueueStore } from './types.js';

const BYTES_PER_MB = 1024 * 1024;
/** Mirrors `CodeskopConfig.maxQueueMb`'s own documented default. */
const DEFAULT_MAX_QUEUE_MB = 5;

export interface DurableQueueOptions {
  /** Byte cap in MB. Defaults to `CodeskopConfig.maxQueueMb`'s documented default, `5`. */
  maxQueueMb?: number;
  /** Fraction of the cap reserved exclusively for critical events. Defaults to `0.2`. */
  criticalReserveRatio?: number;
  /** Injectable storage backend, e.g. a test double. Defaults to `createQueueStore(...)`. */
  store?: QueueStore;
  /** Convenience passthrough to the default `IndexedDbStore` when `store` isn't given. */
  dbName?: string;
  /** Convenience passthrough to the default `IndexedDbStore` when `store` isn't given. */
  storeName?: string;
  /** Reports a swallowed storage failure. Defaults to a silent no-op. */
  onError?: DiagnosticHandler;
}

export class DurableQueue implements QueueLike {
  private store: QueueStore;
  private readonly onError: DiagnosticHandler;
  private readonly maxBytes: number;
  private readonly nonCriticalCapBytes: number;

  private readonly records = new Map<string, QueueRecord>();
  private nextSeq = 0;
  private criticalBytes = 0;
  private nonCriticalBytes = 0;
  private loadPromise?: Promise<void>;

  constructor(options: DurableQueueOptions = {}) {
    this.store = options.store ?? createQueueStore({ dbName: options.dbName, storeName: options.storeName });
    this.onError = options.onError ?? (() => {});

    const maxQueueMb = options.maxQueueMb ?? DEFAULT_MAX_QUEUE_MB;
    this.maxBytes = Math.max(0, maxQueueMb) * BYTES_PER_MB;
    const ratio = clampReserveRatio(options.criticalReserveRatio ?? DEFAULT_CRITICAL_RESERVE_RATIO);
    const reservedCriticalBytes = Math.floor(this.maxBytes * ratio);
    this.nonCriticalCapBytes = Math.max(0, this.maxBytes - reservedCriticalBytes);
  }

  /** Idempotent by `event.event_id`; a duplicate insert is a no-op (`QueueLike`). */
  async enqueue(event: CodeskopEvent): Promise<void> {
    await this.ensureLoaded();
    if (this.records.has(event.event_id)) return;

    const critical = isCriticalEvent(event);
    const sizeBytes = estimateEventBytes(event);
    const record: QueueRecord = { eventId: event.event_id, seq: this.nextSeq, sizeBytes, critical, event };

    const evicted = critical ? this.makeRoomForCritical(sizeBytes) : this.makeRoomForNonCritical(sizeBytes);
    if (evicted === null) return; // this event alone can never fit its budget; drop without storing

    this.nextSeq += 1;
    this.records.set(record.eventId, record);
    this.addBytes(record);

    try {
      if (evicted.length > 0) await this.store.delete(evicted);
      await this.store.put(record);
    } catch (error) {
      this.report(error, 'queue.enqueue');
    }
  }

  /** Returns up to `maxEvents` queued events, oldest first, without removing them (`QueueLike`). */
  async peekBatch(maxEvents: number): Promise<CodeskopEvent[]> {
    await this.ensureLoaded();
    return this.sortedRecords()
      .slice(0, Math.max(0, maxEvents))
      .map((record) => record.event);
  }

  /** Removes the given event ids after a successful/permanent delivery outcome (`QueueLike`). */
  async ack(eventIds: string[]): Promise<void> {
    await this.ensureLoaded();

    const present: string[] = [];
    for (const id of eventIds) {
      const record = this.records.get(id);
      if (!record) continue; // already absent (unknown id, or already acked) — silently ignored
      present.push(id);
      this.records.delete(id);
      this.subtractBytes(record);
    }
    if (present.length === 0) return;

    try {
      await this.store.delete(present);
    } catch (error) {
      this.report(error, 'queue.ack');
    }
  }

  /** Current queue depth, in number of events (`QueueLike`). */
  async size(): Promise<number> {
    await this.ensureLoaded();
    return this.records.size;
  }

  /** Releases the underlying storage connection, if any. Safe to call more than once. */
  async close(): Promise<void> {
    if (!this.store.close) return;
    try {
      await this.store.close();
    } catch (error) {
      this.report(error, 'queue.close');
    }
  }

  private ensureLoaded(): Promise<void> {
    if (!this.loadPromise) this.loadPromise = this.load();
    return this.loadPromise;
  }

  private async load(): Promise<void> {
    let loaded: QueueRecord[];
    try {
      loaded = await this.store.loadAll();
    } catch (error) {
      this.report(error, 'queue.load');
      this.store = new MemoryStore();
      return;
    }
    for (const record of loaded.slice().sort((a, b) => a.seq - b.seq)) {
      this.records.set(record.eventId, record);
      this.addBytes(record);
      this.nextSeq = Math.max(this.nextSeq, record.seq + 1);
    }
  }

  /** Evicts oldest non-critical records until `sizeBytes` fits the shared budget; `null` if it never can. */
  private makeRoomForNonCritical(sizeBytes: number): string[] | null {
    if (sizeBytes > this.nonCriticalCapBytes) return null;
    const evicted: string[] = [];
    while (this.nonCriticalBytes + sizeBytes > this.nonCriticalCapBytes) {
      const victim = this.oldestMatching((record) => !record.critical);
      if (!victim) break;
      this.evictLocal(victim);
      evicted.push(victim.eventId);
    }
    return evicted;
  }

  /**
   * Evicts oldest non-critical records first, then (only once none remain)
   * oldest critical records, until `sizeBytes` fits the total cap. `null` if
   * it never can (the event alone exceeds the entire cap).
   */
  private makeRoomForCritical(sizeBytes: number): string[] | null {
    if (sizeBytes > this.maxBytes) return null;
    const evicted: string[] = [];
    while (this.totalBytes() + sizeBytes > this.maxBytes) {
      const victim = this.oldestMatching((record) => !record.critical) ?? this.oldestMatching((record) => record.critical);
      if (!victim) break;
      this.evictLocal(victim);
      evicted.push(victim.eventId);
    }
    return evicted;
  }

  /**
   * The first record matching `predicate` is the oldest: `this.records`'
   * iteration order is always seq-ascending (`enqueue` appends with a
   * strictly increasing `nextSeq`; `load` inserts already sorted by `seq`),
   * so no separate min-by-seq scan is needed.
   */
  private oldestMatching(predicate: (record: QueueRecord) => boolean): QueueRecord | undefined {
    for (const record of this.records.values()) {
      if (predicate(record)) return record;
    }
    return undefined;
  }

  private evictLocal(record: QueueRecord): void {
    this.records.delete(record.eventId);
    this.subtractBytes(record);
  }

  private addBytes(record: QueueRecord): void {
    if (record.critical) this.criticalBytes += record.sizeBytes;
    else this.nonCriticalBytes += record.sizeBytes;
  }

  private subtractBytes(record: QueueRecord): void {
    if (record.critical) this.criticalBytes -= record.sizeBytes;
    else this.nonCriticalBytes -= record.sizeBytes;
  }

  private totalBytes(): number {
    return this.criticalBytes + this.nonCriticalBytes;
  }

  private sortedRecords(): QueueRecord[] {
    return Array.from(this.records.values()).sort((a, b) => a.seq - b.seq);
  }

  private report(error: unknown, context: string): void {
    try {
      this.onError(error, context);
    } catch {
      // A broken diagnostic handler must never itself throw into the queue.
    }
  }
}
