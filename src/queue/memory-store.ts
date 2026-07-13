/**
 * In-memory `QueueStore` — the fallback used when IndexedDB is unavailable
 * (locked-down embeds, some privacy modes, older browsers) and the double
 * unit tests reach for when they don't care about persistence
 * (`docs/02-architecture.md` §2.6).
 *
 * Durability is obviously best-effort here: a `MemoryStore`'s contents don't
 * survive a page reload. `DurableQueue` degrades to this rather than ever
 * refusing to queue events.
 */
import type { QueueRecord, QueueStore } from './types.js';

export class MemoryStore implements QueueStore {
  private readonly records = new Map<string, QueueRecord>();

  async loadAll(): Promise<QueueRecord[]> {
    return Array.from(this.records.values());
  }

  async put(record: QueueRecord): Promise<void> {
    this.records.set(record.eventId, record);
  }

  async delete(eventIds: string[]): Promise<void> {
    for (const eventId of eventIds) this.records.delete(eventId);
  }

  async close(): Promise<void> {
    // No underlying connection to release.
  }
}
