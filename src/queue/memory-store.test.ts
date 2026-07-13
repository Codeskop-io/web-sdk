import { describe, expect, it } from 'vitest';
import type { CodeskopEvent } from '../model/types.js';
import { MemoryStore } from './memory-store.js';
import type { QueueRecord } from './types.js';

function makeRecord(eventId: string, seq: number): QueueRecord {
  const event: CodeskopEvent = {
    event_id: eventId,
    type: 'heartbeat',
    occurred_at: '2026-07-13T00:00:00.000Z',
    severity: 'low',
    payload: { session_id: 's', visible: true },
  };
  return { eventId, seq, sizeBytes: JSON.stringify(event).length, critical: false, event };
}

describe('MemoryStore', () => {
  it('starts empty', async () => {
    const store = new MemoryStore();
    await expect(store.loadAll()).resolves.toEqual([]);
  });

  it('round-trips put/loadAll', async () => {
    const store = new MemoryStore();
    const record = makeRecord('evt-1', 0);
    await store.put(record);
    await expect(store.loadAll()).resolves.toEqual([record]);
  });

  it('overwrites a record put twice with the same eventId', async () => {
    const store = new MemoryStore();
    const first = makeRecord('evt-1', 0);
    const second = { ...makeRecord('evt-1', 1), critical: true };
    await store.put(first);
    await store.put(second);
    const all = await store.loadAll();
    expect(all).toEqual([second]);
  });

  it('deletes by eventId and silently ignores unknown ids', async () => {
    const store = new MemoryStore();
    await store.put(makeRecord('evt-1', 0));
    await store.delete(['evt-1', 'does-not-exist']);
    await expect(store.loadAll()).resolves.toEqual([]);
  });

  it('close is a no-op that never throws', async () => {
    const store = new MemoryStore();
    await expect(store.close()).resolves.toBeUndefined();
  });
});
