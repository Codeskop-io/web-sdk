import { describe, expect, it, vi } from 'vitest';
import type { CodeskopEvent, ExceptionPayload, HeartbeatPayload, Severity } from '../model/types.js';
import { estimateEventBytes } from './byte-size.js';
import { DurableQueue } from './durable-queue.js';
import { MemoryStore } from './memory-store.js';
import type { QueueStore } from './types.js';

let dbCounter = 0;
function uniqueDbName(): string {
  dbCounter += 1;
  return `codeskop-durable-queue-test-${dbCounter}`;
}

/** A non-critical `heartbeat` event, padded with a `session_id` filler to hit ~`targetBytes`. */
function paddedHeartbeat(eventId: string, targetBytes: number): CodeskopEvent {
  const event: CodeskopEvent = {
    event_id: eventId,
    type: 'heartbeat',
    occurred_at: '2026-07-13T00:00:00.000Z',
    severity: 'low',
    payload: { session_id: '', visible: true },
  };
  const baseLen = JSON.stringify(event).length;
  const padLen = Math.max(0, targetBytes - baseLen);
  (event.payload as HeartbeatPayload).session_id = 'x'.repeat(padLen);
  return event;
}

/** A critical (`exception`) event, padded with a `message` filler to hit ~`targetBytes`. */
function paddedException(eventId: string, targetBytes: number, severity: Severity = 'high'): CodeskopEvent {
  const event: CodeskopEvent = {
    event_id: eventId,
    type: 'exception',
    occurred_at: '2026-07-13T00:00:00.000Z',
    severity,
    payload: { exception_class: 'Error', message: '', stacktrace: [], handled: false, page: '/' },
  };
  const baseLen = JSON.stringify(event).length;
  const padLen = Math.max(0, targetBytes - baseLen);
  (event.payload as ExceptionPayload).message = 'x'.repeat(padLen);
  return event;
}

describe('DurableQueue — idempotency', () => {
  it('treats a duplicate event_id as a no-op, keeping the first write', async () => {
    const queue = new DurableQueue({ store: new MemoryStore(), maxQueueMb: 5 });
    const first = paddedHeartbeat('dup-1', 100);
    await queue.enqueue(first);
    await queue.enqueue({ ...paddedHeartbeat('dup-1', 100), occurred_at: '2026-07-13T01:00:00.000Z' });

    await expect(queue.size()).resolves.toBe(1);
    const batch = await queue.peekBatch(10);
    expect(batch).toHaveLength(1);
    expect(batch[0]?.occurred_at).toBe(first.occurred_at);
  });
});

describe('DurableQueue — byte cap enforcement', () => {
  it('drops the oldest non-critical events once the cap is exceeded', async () => {
    const capBytes = 900;
    const queue = new DurableQueue({
      store: new MemoryStore(),
      maxQueueMb: capBytes / (1024 * 1024),
      criticalReserveRatio: 0,
    });

    await queue.enqueue(paddedHeartbeat('old-1', 300));
    await queue.enqueue(paddedHeartbeat('old-2', 300));
    await queue.enqueue(paddedHeartbeat('new-1', 300));
    await expect(queue.size()).resolves.toBe(3);

    await queue.enqueue(paddedHeartbeat('new-2', 300)); // pushes total over the cap

    const remaining = (await queue.peekBatch(10)).map((e) => e.event_id);
    expect(remaining).toHaveLength(3);
    expect(remaining).not.toContain('old-1');
    expect(remaining).toContain('new-2');
  });

  it('drops a non-critical event outright if it can never fit its own budget', async () => {
    const capBytes = 500;
    const queue = new DurableQueue({
      store: new MemoryStore(),
      maxQueueMb: capBytes / (1024 * 1024),
      criticalReserveRatio: 0.5, // 250B shared budget for non-critical
    });

    await queue.enqueue(paddedHeartbeat('too-big', 400)); // exceeds the 250B non-critical budget alone
    await expect(queue.size()).resolves.toBe(0);
  });

  it('drops a critical event outright if it can never fit even the entire cap', async () => {
    const capBytes = 300;
    const queue = new DurableQueue({
      store: new MemoryStore(),
      maxQueueMb: capBytes / (1024 * 1024),
      criticalReserveRatio: 1,
    });

    await queue.enqueue(paddedException('too-big-even-for-critical', 1000, 'high'));
    await expect(queue.size()).resolves.toBe(0);
  });

  it('never lets total queued bytes exceed the configured cap', async () => {
    const capBytes = 2000;
    const queue = new DurableQueue({
      store: new MemoryStore(),
      maxQueueMb: capBytes / (1024 * 1024),
      criticalReserveRatio: 0.2,
    });

    for (let i = 0; i < 40; i += 1) {
      await queue.enqueue(paddedHeartbeat(`evt-${i}`, 150));
    }

    const remaining = await queue.peekBatch(1000);
    const totalBytes = remaining.reduce((sum, e) => sum + estimateEventBytes(e), 0);
    expect(totalBytes).toBeLessThanOrEqual(capBytes);
  });
});

describe('DurableQueue — critical reserve', () => {
  it('never evicts a critical event under a flood of low-severity events', async () => {
    const capBytes = 1000;
    const queue = new DurableQueue({
      store: new MemoryStore(),
      maxQueueMb: capBytes / (1024 * 1024),
      criticalReserveRatio: 0.3, // 300B reserved for critical
    });

    await queue.enqueue(paddedException('crit-1', 250, 'high'));
    await expect(queue.size()).resolves.toBe(1);

    // Flood with many small non-critical events, far exceeding the cap in aggregate.
    for (let i = 0; i < 50; i += 1) {
      await queue.enqueue(paddedHeartbeat(`flood-${i}`, 100));
    }

    const remaining = await queue.peekBatch(1000);
    const ids = remaining.map((e) => e.event_id);
    expect(ids).toContain('crit-1');
    const totalBytes = remaining.reduce((sum, e) => sum + estimateEventBytes(e), 0);
    expect(totalBytes).toBeLessThanOrEqual(capBytes);
  });

  it('exception-typed events are protected even at low severity', async () => {
    const capBytes = 1000;
    const queue = new DurableQueue({
      store: new MemoryStore(),
      maxQueueMb: capBytes / (1024 * 1024),
      criticalReserveRatio: 0.3,
    });

    await queue.enqueue(paddedException('crit-exc', 250, 'low'));
    for (let i = 0; i < 50; i += 1) {
      await queue.enqueue(paddedHeartbeat(`flood-${i}`, 100));
    }

    const ids = (await queue.peekBatch(1000)).map((e) => e.event_id);
    expect(ids).toContain('crit-exc');
  });

  it('evicts critical events to make room for a newer critical event only once no non-critical events remain', async () => {
    const capBytes = 500;
    const queue = new DurableQueue({
      store: new MemoryStore(),
      maxQueueMb: capBytes / (1024 * 1024),
      criticalReserveRatio: 1, // the whole cap is the critical reserve; no non-critical budget at all
    });

    await queue.enqueue(paddedException('crit-old', 250, 'high'));
    await queue.enqueue(paddedException('crit-new', 250, 'high'));
    await expect(queue.size()).resolves.toBe(2);

    await queue.enqueue(paddedException('crit-newest', 250, 'high'));
    const ids = (await queue.peekBatch(10)).map((e) => e.event_id);
    expect(ids).not.toContain('crit-old');
    expect(ids).toContain('crit-newest');
    expect(ids).toHaveLength(2);
  });
});

describe('DurableQueue — peek/ack semantics', () => {
  it('peekBatch returns events oldest-first without removing them', async () => {
    const queue = new DurableQueue({ store: new MemoryStore(), maxQueueMb: 5 });
    await queue.enqueue(paddedHeartbeat('a', 50));
    await queue.enqueue(paddedHeartbeat('b', 50));

    await expect(queue.peekBatch(1).then((b) => b.map((e) => e.event_id))).resolves.toEqual(['a']);
    await expect(queue.size()).resolves.toBe(2);
  });

  it('ack removes only the given ids and silently ignores unknown ones', async () => {
    const queue = new DurableQueue({ store: new MemoryStore(), maxQueueMb: 5 });
    await queue.enqueue(paddedHeartbeat('a', 50));
    await queue.enqueue(paddedHeartbeat('b', 50));

    await queue.ack(['a', 'does-not-exist']);
    const remaining = (await queue.peekBatch(10)).map((e) => e.event_id);
    expect(remaining).toEqual(['b']);
  });

  it('ack is a no-op when every given id is unknown', async () => {
    const queue = new DurableQueue({ store: new MemoryStore(), maxQueueMb: 5 });
    await queue.enqueue(paddedHeartbeat('a', 50));

    await expect(queue.ack(['does-not-exist'])).resolves.toBeUndefined();
    await expect(queue.size()).resolves.toBe(1);
  });

  it('ack is a no-op given an empty array', async () => {
    const queue = new DurableQueue({ store: new MemoryStore(), maxQueueMb: 5 });
    await queue.enqueue(paddedHeartbeat('a', 50));

    await expect(queue.ack([])).resolves.toBeUndefined();
    await expect(queue.size()).resolves.toBe(1);
  });
});

describe('DurableQueue — reload survival', () => {
  it('keeps unacked events across a fresh instance against the same IndexedDB database', async () => {
    const dbName = uniqueDbName();

    const first = new DurableQueue({ dbName, maxQueueMb: 5 });
    await first.enqueue(paddedHeartbeat('persist-1', 100));
    await first.enqueue(paddedException('persist-2', 100, 'high'));
    await expect(first.size()).resolves.toBe(2);
    await first.close();

    const second = new DurableQueue({ dbName, maxQueueMb: 5 });
    const idsAfterReload = (await second.peekBatch(10)).map((e) => e.event_id).sort();
    expect(idsAfterReload).toEqual(['persist-1', 'persist-2']);
    await expect(second.size()).resolves.toBe(2);

    await second.ack(['persist-1']);
    await second.close();

    const third = new DurableQueue({ dbName, maxQueueMb: 5 });
    const idsAfterAck = (await third.peekBatch(10)).map((e) => e.event_id);
    expect(idsAfterAck).toEqual(['persist-2']);
    await third.close();
  });

  it('a duplicate enqueue after reload is still a no-op', async () => {
    const dbName = uniqueDbName();

    const first = new DurableQueue({ dbName, maxQueueMb: 5 });
    const original = paddedHeartbeat('reload-dup', 80);
    await first.enqueue(original);
    await first.close();

    const second = new DurableQueue({ dbName, maxQueueMb: 5 });
    await second.enqueue({ ...paddedHeartbeat('reload-dup', 80), occurred_at: '2099-01-01T00:00:00.000Z' });
    await expect(second.size()).resolves.toBe(1);
    const batch = await second.peekBatch(10);
    expect(batch[0]?.occurred_at).toBe(original.occurred_at);
    await second.close();
  });
});

describe('DurableQueue — resilience', () => {
  it('degrades to an empty in-memory queue, without throwing, if the initial load fails', async () => {
    const failingStore: QueueStore = {
      loadAll: () => Promise.reject(new Error('boom')),
      put: async () => {},
      delete: async () => {},
    };
    const onError = vi.fn();
    const queue = new DurableQueue({ store: failingStore, onError });

    await expect(queue.size()).resolves.toBe(0);
    await queue.enqueue(paddedHeartbeat('after-failure', 50));
    await expect(queue.size()).resolves.toBe(1);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'queue.load');
  });

  it('reports but swallows a store.put failure during enqueue', async () => {
    const onError = vi.fn();
    const store: QueueStore = {
      loadAll: async () => [],
      put: () => Promise.reject(new Error('put failed')),
      delete: async () => {},
    };
    const queue = new DurableQueue({ store, onError });

    await expect(queue.enqueue(paddedHeartbeat('a', 50))).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'queue.enqueue');
    // The in-memory index still reflects the enqueue even though persistence failed.
    await expect(queue.size()).resolves.toBe(1);
  });

  it('reports but swallows a store.delete failure during ack', async () => {
    const onError = vi.fn();
    const store: QueueStore = {
      loadAll: async () => [],
      put: async () => {},
      delete: () => Promise.reject(new Error('delete failed')),
    };
    const queue = new DurableQueue({ store, onError });

    await queue.enqueue(paddedHeartbeat('a', 50));
    await expect(queue.ack(['a'])).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'queue.ack');
    await expect(queue.size()).resolves.toBe(0); // still removed from the in-memory index
  });

  it('reports but swallows a store.close failure', async () => {
    const onError = vi.fn();
    const store: QueueStore = {
      loadAll: async () => [],
      put: async () => {},
      delete: async () => {},
      close: () => Promise.reject(new Error('close failed')),
    };
    const queue = new DurableQueue({ store, onError });

    await expect(queue.close()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'queue.close');
  });

  it('close is a no-op when the store has no close method', async () => {
    const store: QueueStore = { loadAll: async () => [], put: async () => {}, delete: async () => {} };
    const queue = new DurableQueue({ store });
    await expect(queue.close()).resolves.toBeUndefined();
  });

  it('a broken onError diagnostic handler never itself throws out of enqueue', async () => {
    const failingStore: QueueStore = {
      loadAll: () => Promise.reject(new Error('boom')),
      put: async () => {},
      delete: async () => {},
    };
    const queue = new DurableQueue({
      store: failingStore,
      onError: () => {
        throw new Error('diagnostic handler is itself broken');
      },
    });

    await expect(queue.enqueue(paddedHeartbeat('still-works', 50))).resolves.toBeUndefined();
    await expect(queue.size()).resolves.toBe(1);
  });
});
