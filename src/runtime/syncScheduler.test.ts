import { afterEach, describe, expect, it, vi } from 'vitest';
import { SyncScheduler, type SyncSchedulerOptions } from './syncScheduler.js';

type Listener = () => void;

/** A minimal fake `Window`/`Document` — just enough surface for `SyncScheduler` to attach to. */
function fakeEventTarget(): {
  addEventListener: (type: string, listener: Listener) => void;
  removeEventListener: (type: string, listener: Listener) => void;
  fire: (type: string) => void;
  listenerCount: (type: string) => number;
} {
  const listeners = new Map<string, Set<Listener>>();
  return {
    addEventListener: (type, listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)?.add(listener);
    },
    removeEventListener: (type, listener) => {
      listeners.get(type)?.delete(listener);
    },
    fire: (type) => {
      for (const listener of listeners.get(type) ?? []) listener();
    },
    listenerCount: (type) => listeners.get(type)?.size ?? 0,
  };
}

function buildScheduler(overrides: Partial<SyncSchedulerOptions> = {}) {
  vi.stubGlobal('requestIdleCallback', undefined); // exercise the deterministic setTimeout(0) fallback
  const win = fakeEventTarget();
  const docBase = fakeEventTarget();
  let visibilityState = 'visible';
  const doc = { ...docBase, get visibilityState() { return visibilityState; } };
  const setVisibility = (state: 'visible' | 'hidden') => {
    visibilityState = state;
  };

  const onSteadyStateSync = vi.fn();
  const onUnloadSync = vi.fn();
  const getQueueSize = vi.fn(async () => 0);

  const scheduler = new SyncScheduler({
    batchSizeThreshold: 5,
    intervalMs: 10_000,
    getQueueSize,
    onSteadyStateSync,
    onUnloadSync,
    win: win as unknown as SyncSchedulerOptions['win'],
    doc: doc as unknown as SyncSchedulerOptions['doc'],
    ...overrides,
  });

  return { scheduler, win, doc, setVisibility, onSteadyStateSync, onUnloadSync, getQueueSize };
}

describe('SyncScheduler', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('start() attaches the online and visibilitychange listeners exactly once', () => {
    const { scheduler, win, doc } = buildScheduler();
    scheduler.start();
    scheduler.start(); // idempotent
    expect(win.listenerCount('online')).toBe(1);
    expect(doc.listenerCount('visibilitychange')).toBe(1);
  });

  it('stop() detaches every listener and the interval timer', () => {
    vi.useFakeTimers();
    const { scheduler, win, doc, onSteadyStateSync } = buildScheduler();
    scheduler.start();
    scheduler.stop();

    expect(win.listenerCount('online')).toBe(0);
    expect(doc.listenerCount('visibilitychange')).toBe(0);

    vi.runAllTimers();
    expect(onSteadyStateSync).not.toHaveBeenCalled();
  });

  it('the online event schedules a steady-state sync', async () => {
    const { scheduler, win, onSteadyStateSync } = buildScheduler();
    scheduler.start();
    win.fire('online');
    await vi.waitFor(() => expect(onSteadyStateSync).toHaveBeenCalledTimes(1));
  });

  it('visibilitychange while hidden triggers the unload (beacon) sync, not the steady-state one', () => {
    const { scheduler, doc, setVisibility, onUnloadSync, onSteadyStateSync } = buildScheduler();
    scheduler.start();
    setVisibility('hidden');
    doc.fire('visibilitychange');

    expect(onUnloadSync).toHaveBeenCalledTimes(1);
    expect(onSteadyStateSync).not.toHaveBeenCalled();
  });

  it('visibilitychange while visible (tab regains focus) triggers neither sync', () => {
    const { scheduler, doc, setVisibility, onUnloadSync, onSteadyStateSync } = buildScheduler();
    scheduler.start();
    setVisibility('hidden');
    doc.fire('visibilitychange');
    setVisibility('visible');
    doc.fire('visibilitychange');

    expect(onUnloadSync).toHaveBeenCalledTimes(1); // only the hidden transition
    expect(onSteadyStateSync).not.toHaveBeenCalled();
  });

  it('the time-window interval schedules a steady-state sync on each tick', () => {
    vi.useFakeTimers();
    const { scheduler, onSteadyStateSync } = buildScheduler({ intervalMs: 1000 });
    scheduler.start();

    // +1ms past each interval boundary so the nested `setTimeout(0,…)` the
    // idle-fallback schedules (from *inside* the interval tick) is also due.
    vi.advanceTimersByTime(1001);
    expect(onSteadyStateSync).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(onSteadyStateSync).toHaveBeenCalledTimes(2);
  });

  it('notifyEnqueued() schedules a steady-state sync once the queue reaches the batch-size threshold', async () => {
    const { scheduler, onSteadyStateSync } = buildScheduler({
      batchSizeThreshold: 5,
      getQueueSize: vi.fn(async () => 5),
    });
    scheduler.start();
    scheduler.notifyEnqueued();

    await vi.waitFor(() => expect(onSteadyStateSync).toHaveBeenCalledTimes(1));
  });

  it('notifyEnqueued() does nothing while the queue is under the batch-size threshold', async () => {
    const { scheduler, onSteadyStateSync } = buildScheduler({
      batchSizeThreshold: 5,
      getQueueSize: vi.fn(async () => 1),
    });
    scheduler.start();
    scheduler.notifyEnqueued();

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(onSteadyStateSync).not.toHaveBeenCalled();
  });

  it('a rapid burst of notifyEnqueued() calls only checks the queue once (idle check is coalesced)', async () => {
    let calls = 0;
    const { scheduler, onSteadyStateSync } = buildScheduler({
      batchSizeThreshold: 5,
      getQueueSize: vi.fn(async () => {
        calls += 1;
        return 5;
      }),
    });
    scheduler.start();
    scheduler.notifyEnqueued();
    scheduler.notifyEnqueued();
    scheduler.notifyEnqueued();

    await vi.waitFor(() => expect(onSteadyStateSync).toHaveBeenCalled());
    expect(calls).toBe(1);
  });
});
