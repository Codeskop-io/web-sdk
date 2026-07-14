import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodeskopConfig, CodeskopEvent, ConfigSource, QueueLike, RemoteConfig, Transport, TransportResult } from '../model/types.js';
import { DEFAULT_REMOTE_CONFIG } from '../config/index.js';
import { BATCH_SIZE_TRIGGER, CodeskopClient, getActiveClient, setActiveClient } from './client.js';

const config: CodeskopConfig = { apiKey: 'cs_test_pk_client', endpoint: 'https://ingest.example.com' };

function heartbeatEvent(id: string): CodeskopEvent {
  return {
    event_id: id,
    type: 'heartbeat',
    occurred_at: '2026-07-13T00:00:00.000Z',
    severity: 'low',
    payload: { session_id: id, visible: true },
  };
}

function fakeQueue(initial: CodeskopEvent[] = []): QueueLike & { events: CodeskopEvent[] } {
  const events = [...initial];
  return {
    events,
    async enqueue(event) {
      if (!events.some((existing) => existing.event_id === event.event_id)) events.push(event);
    },
    async peekBatch(maxEvents) {
      return events.slice(0, maxEvents);
    },
    async ack(eventIds) {
      for (const id of eventIds) {
        const index = events.findIndex((event) => event.event_id === id);
        if (index >= 0) events.splice(index, 1);
      }
    },
    async size() {
      return events.length;
    },
  };
}

function fakeTransport(result: TransportResult = { ok: true, retryable: false }): Transport & { calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async send() {
      calls += 1;
      return result;
    },
  };
}

function fakeConfigSource(remoteConfig: RemoteConfig = DEFAULT_REMOTE_CONFIG): ConfigSource {
  return { fetchConfig: async () => remoteConfig };
}

let client: CodeskopClient | undefined;

afterEach(() => {
  client?.dispose();
  client = undefined;
  setActiveClient(undefined);
  Reflect.deleteProperty(document, 'visibilityState');
  vi.unstubAllGlobals();
});

describe('CodeskopClient — emitEvent', () => {
  it('enqueues a well-formed event attributed to the anonymous install id', async () => {
    const queue = fakeQueue();
    client = new CodeskopClient(config, {
      installId: 'inst_test',
      queue,
      fetchTransport: fakeTransport(),
      beaconTransport: fakeTransport(),
      configSource: fakeConfigSource(),
    });

    client.emitEvent({ type: 'heartbeat', severity: 'low', payload: { session_id: 's1', visible: true } });

    await vi.waitFor(() => expect(queue.events).toHaveLength(1));
    const [event] = queue.events;
    expect(event?.type).toBe('heartbeat');
    expect(event?.severity).toBe('low');
    expect(event?.user).toEqual({ id: 'inst_test', is_anonymous: true });
    expect(event?.event_id).toBeTruthy();
    expect(event?.occurred_at).toBeTruthy();
  });

  it('is a no-op once the remote kill-switch has tripped', async () => {
    const queue = fakeQueue();
    client = new CodeskopClient(config, {
      installId: 'inst_test',
      queue,
      fetchTransport: fakeTransport(),
      beaconTransport: fakeTransport(),
      configSource: fakeConfigSource({ ...DEFAULT_REMOTE_CONFIG, enabled: false }),
    });

    // Let the async `GET /v1/config` fetch (deferred at construction) resolve
    // and trip the kill-switch before asserting the no-op behavior it causes
    // — otherwise this races the still-`enabled` window right after construction.
    await vi.waitFor(() => expect(client?.isActive()).toBe(false));

    client.emitEvent({ type: 'heartbeat', severity: 'low', payload: { session_id: 's', visible: true } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(queue.events).toHaveLength(0);
  });

  it('never throws even when the queue rejects', async () => {
    const queue: QueueLike = {
      enqueue: () => Promise.reject(new Error('boom')),
      peekBatch: async () => [],
      ack: async () => {},
      size: async () => 0,
    };
    client = new CodeskopClient(config, {
      installId: 'inst_test',
      queue,
      fetchTransport: fakeTransport(),
      beaconTransport: fakeTransport(),
      configSource: fakeConfigSource(),
    });

    expect(() =>
      client?.emitEvent({ type: 'heartbeat', severity: 'low', payload: { session_id: 's', visible: true } }),
    ).not.toThrow();
  });
});

describe('CodeskopClient — setEnabled (local pause/resume)', () => {
  it('is a no-op independent of, and does not touch, the remote kill-switch state', async () => {
    const queue = fakeQueue();
    client = new CodeskopClient(config, {
      installId: 'inst_test',
      queue,
      fetchTransport: fakeTransport(),
      beaconTransport: fakeTransport(),
      configSource: fakeConfigSource(),
    });
    await vi.waitFor(() => expect(client?.isActive()).toBe(true));

    client.setEnabled(false);
    client.emitEvent({ type: 'heartbeat', severity: 'low', payload: { session_id: 's', visible: true } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(queue.events).toHaveLength(0);
    expect(client.isActive()).toBe(false);

    client.setEnabled(true);
    expect(client.isActive()).toBe(true);
    client.emitEvent({ type: 'heartbeat', severity: 'low', payload: { session_id: 's', visible: true } });
    await vi.waitFor(() => expect(queue.events).toHaveLength(1));
  });

  it('leaves a tripped kill-switch tripped even after setEnabled(true)', async () => {
    const queue = fakeQueue();
    client = new CodeskopClient(config, {
      installId: 'inst_test',
      queue,
      fetchTransport: fakeTransport(),
      beaconTransport: fakeTransport(),
      configSource: fakeConfigSource({ ...DEFAULT_REMOTE_CONFIG, enabled: false }),
    });
    await vi.waitFor(() => expect(client?.isActive()).toBe(false));

    client.setEnabled(true);
    client.emitEvent({ type: 'heartbeat', severity: 'low', payload: { session_id: 's', visible: true } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(queue.events).toHaveLength(0);
    expect(client.isActive()).toBe(false);
  });
});

describe('CodeskopClient — identify / reset', () => {
  it('attributes subsequent events to the identified user, then back to anonymous after reset', async () => {
    const queue = fakeQueue();
    client = new CodeskopClient(config, {
      installId: 'inst_test',
      queue,
      fetchTransport: fakeTransport(),
      beaconTransport: fakeTransport(),
      configSource: fakeConfigSource(),
    });

    client.identify('user_42', { plan: 'pro' });
    client.emitEvent({ type: 'heartbeat', severity: 'low', payload: { session_id: 's1', visible: true } });
    await vi.waitFor(() => expect(queue.events).toHaveLength(1));
    expect(queue.events[0]?.user).toEqual({ id: 'user_42', is_anonymous: false });

    client.reset();
    client.emitEvent({ type: 'heartbeat', severity: 'low', payload: { session_id: 's2', visible: true } });
    await vi.waitFor(() => expect(queue.events).toHaveLength(2));
    expect(queue.events[1]?.user).toEqual({ id: 'inst_test', is_anonymous: true });
  });
});

describe('CodeskopClient — flush', () => {
  it('resolves true and drains the queue via the fetch transport (never beacon)', async () => {
    const queue = fakeQueue([heartbeatEvent('e1')]);
    const fetchTransport = fakeTransport();
    const beaconTransport = fakeTransport();
    client = new CodeskopClient(config, {
      installId: 'inst_test',
      queue,
      fetchTransport,
      beaconTransport,
      configSource: fakeConfigSource(),
    });

    await expect(client.flush()).resolves.toBe(true);
    expect(fetchTransport.calls).toBe(1);
    expect(beaconTransport.calls).toBe(0);
    expect(queue.events).toHaveLength(0);
  });

  it('resolves false when a drain is already in flight', async () => {
    let resolveSend: (() => void) | undefined;
    const slowTransport: Transport = {
      send: () =>
        new Promise((resolve) => {
          resolveSend = () => resolve({ ok: true, retryable: false });
        }),
    };
    const queue = fakeQueue([heartbeatEvent('e1')]);
    client = new CodeskopClient(config, {
      installId: 'inst_test',
      queue,
      fetchTransport: slowTransport,
      beaconTransport: fakeTransport(),
      configSource: fakeConfigSource(),
    });

    const first = client.flush();
    const second = client.flush();

    await expect(second).resolves.toBe(false);
    resolveSend?.();
    await expect(first).resolves.toBe(true);
  });

  it('still resolves true (an attempt ran) even if the drain throws internally', async () => {
    const queue: QueueLike = {
      enqueue: async () => {},
      peekBatch: () => Promise.reject(new Error('boom')),
      ack: async () => {},
      size: async () => 0,
    };
    client = new CodeskopClient(config, {
      installId: 'inst_test',
      queue,
      fetchTransport: fakeTransport(),
      beaconTransport: fakeTransport(),
      configSource: fakeConfigSource(),
    });

    await expect(client.flush()).resolves.toBe(true);
  });
});

describe('CodeskopClient — sync triggers', () => {
  it('reaching the batch-size threshold drains via the fetch transport', async () => {
    const seed = Array.from({ length: BATCH_SIZE_TRIGGER - 1 }, (_, i) => heartbeatEvent(`seed-${i}`));
    const queue = fakeQueue(seed);
    const fetchTransport = fakeTransport();
    client = new CodeskopClient(config, {
      installId: 'inst_test',
      queue,
      fetchTransport,
      beaconTransport: fakeTransport(),
      configSource: fakeConfigSource(),
    });

    client.emitEvent({ type: 'heartbeat', severity: 'low', payload: { session_id: 'last', visible: true } });

    await vi.waitFor(() => expect(fetchTransport.calls).toBeGreaterThan(0));
    await vi.waitFor(() => expect(queue.events).toHaveLength(0));
  });

  it('the browser online event drains the queue via the fetch transport', async () => {
    const queue = fakeQueue([heartbeatEvent('e1')]);
    const fetchTransport = fakeTransport();
    const beaconTransport = fakeTransport();
    client = new CodeskopClient(config, {
      installId: 'inst_test',
      queue,
      fetchTransport,
      beaconTransport,
      configSource: fakeConfigSource(),
    });

    window.dispatchEvent(new Event('online'));

    await vi.waitFor(() => expect(fetchTransport.calls).toBe(1));
    expect(beaconTransport.calls).toBe(0);
    expect(queue.events).toHaveLength(0);
  });

  it('the tab going hidden drains via the beacon transport, not fetch', async () => {
    const queue = fakeQueue([heartbeatEvent('e1')]);
    const fetchTransport = fakeTransport();
    const beaconTransport = fakeTransport();
    client = new CodeskopClient(config, {
      installId: 'inst_test',
      queue,
      fetchTransport,
      beaconTransport,
      configSource: fakeConfigSource(),
    });

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    await vi.waitFor(() => expect(beaconTransport.calls).toBe(1));
    expect(fetchTransport.calls).toBe(0);
  });

  it('a retryable transport failure leaves the batch queued for the next sync', async () => {
    const queue = fakeQueue([heartbeatEvent('e1')]);
    const fetchTransport = fakeTransport({ ok: false, retryable: true });
    client = new CodeskopClient(config, {
      installId: 'inst_test',
      queue,
      fetchTransport,
      beaconTransport: fakeTransport(),
      configSource: fakeConfigSource(),
    });

    window.dispatchEvent(new Event('online'));

    await vi.waitFor(() => expect(fetchTransport.calls).toBe(1));
    expect(queue.events).toHaveLength(1);
  });

  it('a permanent (non-retryable) failure drops the batch rather than retrying it forever', async () => {
    const queue = fakeQueue([heartbeatEvent('e1')]);
    const fetchTransport = fakeTransport({ ok: false, status: 400, retryable: false });
    client = new CodeskopClient(config, {
      installId: 'inst_test',
      queue,
      fetchTransport,
      beaconTransport: fakeTransport(),
      configSource: fakeConfigSource(),
    });

    window.dispatchEvent(new Event('online'));

    await vi.waitFor(() => expect(fetchTransport.calls).toBe(1));
    await vi.waitFor(() => expect(queue.events).toHaveLength(0));
  });

  it('dispose() detaches listeners so a later online event does nothing', async () => {
    const queue = fakeQueue([heartbeatEvent('e1')]);
    const fetchTransport = fakeTransport();
    client = new CodeskopClient(config, {
      installId: 'inst_test',
      queue,
      fetchTransport,
      beaconTransport: fakeTransport(),
      configSource: fakeConfigSource(),
    });

    client.dispose();
    window.dispatchEvent(new Event('online'));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchTransport.calls).toBe(0);
  });
});

describe('setActiveClient / getActiveClient', () => {
  it('is undefined before any client has been set', () => {
    expect(getActiveClient()).toBeUndefined();
  });

  it('returns the most recently set client and disposes the previous one', () => {
    const first = new CodeskopClient(config, {
      installId: 'inst_1',
      queue: fakeQueue(),
      fetchTransport: fakeTransport(),
      beaconTransport: fakeTransport(),
      configSource: fakeConfigSource(),
    });
    const disposeSpy = vi.spyOn(first, 'dispose');
    setActiveClient(first);
    expect(getActiveClient()).toBe(first);

    const second = new CodeskopClient(config, {
      installId: 'inst_2',
      queue: fakeQueue(),
      fetchTransport: fakeTransport(),
      beaconTransport: fakeTransport(),
      configSource: fakeConfigSource(),
    });
    setActiveClient(second);

    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(getActiveClient()).toBe(second);
    client = second;
  });
});

function fakeCapture(): { start: () => void; stop: () => void; startCalls: number; stopCalls: number } {
  let startCalls = 0;
  let stopCalls = 0;
  return {
    get startCalls() {
      return startCalls;
    },
    get stopCalls() {
      return stopCalls;
    },
    start: () => {
      startCalls += 1;
    },
    stop: () => {
      stopCalls += 1;
    },
  };
}

describe('CodeskopClient — capture module lifecycle (Phases 6/7/9 integration)', () => {
  it('starts the network, error, and heartbeat captures on construction', () => {
    const networkCapture = fakeCapture();
    const errorCapture = fakeCapture();
    const heartbeatCapture = fakeCapture();
    client = new CodeskopClient(config, {
      installId: 'inst_test',
      queue: fakeQueue(),
      fetchTransport: fakeTransport(),
      beaconTransport: fakeTransport(),
      configSource: fakeConfigSource(),
      networkCapture,
      errorCapture,
      heartbeatCapture,
    });

    expect(networkCapture.startCalls).toBe(1);
    expect(errorCapture.startCalls).toBe(1);
    expect(heartbeatCapture.startCalls).toBe(1);
  });

  it('stops every started capture module on dispose', () => {
    const networkCapture = fakeCapture();
    const errorCapture = fakeCapture();
    const heartbeatCapture = fakeCapture();
    client = new CodeskopClient(config, {
      installId: 'inst_test',
      queue: fakeQueue(),
      fetchTransport: fakeTransport(),
      beaconTransport: fakeTransport(),
      configSource: fakeConfigSource(),
      networkCapture,
      errorCapture,
      heartbeatCapture,
    });

    client.dispose();

    expect(networkCapture.stopCalls).toBe(1);
    expect(errorCapture.stopCalls).toBe(1);
    expect(heartbeatCapture.stopCalls).toBe(1);
    client = undefined;
  });

  it('a config-supplied override is never even constructed/started when captureNetwork is false', () => {
    const networkCapture = fakeCapture();
    const errorCapture = fakeCapture();
    const heartbeatCapture = fakeCapture();
    client = new CodeskopClient(
      { ...config, captureNetwork: false },
      {
        installId: 'inst_test',
        queue: fakeQueue(),
        fetchTransport: fakeTransport(),
        beaconTransport: fakeTransport(),
        configSource: fakeConfigSource(),
        networkCapture,
        errorCapture,
        heartbeatCapture,
      },
    );

    expect(networkCapture.startCalls).toBe(0);
    expect(errorCapture.startCalls).toBe(1);
    expect(heartbeatCapture.startCalls).toBe(1);
  });

  it('a config-supplied override is never even constructed/started when captureErrors is false', () => {
    const networkCapture = fakeCapture();
    const errorCapture = fakeCapture();
    const heartbeatCapture = fakeCapture();
    client = new CodeskopClient(
      { ...config, captureErrors: false },
      {
        installId: 'inst_test',
        queue: fakeQueue(),
        fetchTransport: fakeTransport(),
        beaconTransport: fakeTransport(),
        configSource: fakeConfigSource(),
        networkCapture,
        errorCapture,
        heartbeatCapture,
      },
    );

    expect(networkCapture.startCalls).toBe(1);
    expect(errorCapture.startCalls).toBe(0);
    expect(heartbeatCapture.startCalls).toBe(1);
  });

  it('always starts the heartbeat capture regardless of captureNetwork/captureErrors', () => {
    const networkCapture = fakeCapture();
    const errorCapture = fakeCapture();
    const heartbeatCapture = fakeCapture();
    client = new CodeskopClient(
      { ...config, captureNetwork: false, captureErrors: false },
      {
        installId: 'inst_test',
        queue: fakeQueue(),
        fetchTransport: fakeTransport(),
        beaconTransport: fakeTransport(),
        configSource: fakeConfigSource(),
        networkCapture,
        errorCapture,
        heartbeatCapture,
      },
    );

    expect(networkCapture.startCalls).toBe(0);
    expect(errorCapture.startCalls).toBe(0);
    expect(heartbeatCapture.startCalls).toBe(1);
  });
});
