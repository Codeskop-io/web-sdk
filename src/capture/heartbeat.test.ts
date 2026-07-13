import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  HeartbeatCapture,
  type HeartbeatCaptureOptions,
} from './heartbeat.js';

type Listener = () => void;

/** A minimal fake `Document` — just enough surface for `HeartbeatCapture` to attach to (mirrors `runtime/syncScheduler.test.ts`). */
function fakeDocument(initialVisibility: 'visible' | 'hidden' = 'visible') {
  const listeners = new Map<string, Set<Listener>>();
  let visibilityState: 'visible' | 'hidden' = initialVisibility;

  return {
    addEventListener: (type: string, listener: Listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)?.add(listener);
    },
    removeEventListener: (type: string, listener: Listener) => {
      listeners.get(type)?.delete(listener);
    },
    fire: (type: string) => {
      for (const listener of listeners.get(type) ?? []) listener();
    },
    listenerCount: (type: string) => listeners.get(type)?.size ?? 0,
    setVisibility: (state: 'visible' | 'hidden') => {
      visibilityState = state;
    },
    get visibilityState() {
      return visibilityState;
    },
  };
}

function buildCapture(
  overrides: Partial<HeartbeatCaptureOptions> = {},
  initialVisibility: 'visible' | 'hidden' = 'visible',
) {
  const doc = fakeDocument(initialVisibility);
  const emit = vi.fn();

  const capture = new HeartbeatCapture({
    intervalMs: 10_000,
    sessionId: 'sess_test',
    doc: doc as unknown as HeartbeatCaptureOptions['doc'],
    emit,
    ...overrides,
  });

  return { capture, doc, emit };
}

describe('HeartbeatCapture', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('emits nothing until start() is called', () => {
    vi.useFakeTimers();
    const { emit } = buildCapture();
    vi.advanceTimersByTime(50_000);
    expect(emit).not.toHaveBeenCalled();
  });

  it('cadence while visible: emits a low-severity heartbeat on every interval tick', () => {
    vi.useFakeTimers();
    const { capture, emit } = buildCapture({ intervalMs: 1000 });
    capture.start();

    vi.advanceTimersByTime(1000);
    expect(emit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(emit).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1000);
    expect(emit).toHaveBeenCalledTimes(3);

    expect(emit).toHaveBeenCalledWith({
      type: 'heartbeat',
      severity: 'low',
      payload: { session_id: 'sess_test', visible: true },
    });
  });

  it('silence while hidden: never starts a timer, so no ticks fire', () => {
    vi.useFakeTimers();
    const { capture, emit } = buildCapture({ intervalMs: 1000 }, 'hidden');
    capture.start();

    vi.advanceTimersByTime(50_000);
    expect(emit).not.toHaveBeenCalled();
  });

  it('a tab going hidden mid-run stops further heartbeats', () => {
    vi.useFakeTimers();
    const { capture, doc, emit } = buildCapture({ intervalMs: 1000 });
    capture.start();

    vi.advanceTimersByTime(1000);
    expect(emit).toHaveBeenCalledTimes(1);

    doc.setVisibility('hidden');
    doc.fire('visibilitychange');

    vi.advanceTimersByTime(10_000);
    expect(emit).toHaveBeenCalledTimes(1); // no further ticks once hidden
  });

  it('a tab becoming visible again resumes heartbeats on the same cadence', () => {
    vi.useFakeTimers();
    const { capture, doc, emit } = buildCapture({ intervalMs: 1000 }, 'hidden');
    capture.start();

    vi.advanceTimersByTime(5000);
    expect(emit).not.toHaveBeenCalled();

    doc.setVisibility('visible');
    doc.fire('visibilitychange');

    vi.advanceTimersByTime(1000);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('repeated visibility flapping does not stack multiple intervals', () => {
    vi.useFakeTimers();
    const { capture, doc, emit } = buildCapture({ intervalMs: 1000 });
    capture.start();

    // Fire "visible" again while already visible/running — must not double-start the timer.
    doc.fire('visibilitychange');
    doc.fire('visibilitychange');

    vi.advanceTimersByTime(1000);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('start() is idempotent: calling it twice attaches exactly one listener', () => {
    const { capture, doc } = buildCapture();
    capture.start();
    capture.start();
    expect(doc.listenerCount('visibilitychange')).toBe(1);
  });

  it('stop() detaches the listener and clears the interval; no more heartbeats after', () => {
    vi.useFakeTimers();
    const { capture, doc, emit } = buildCapture({ intervalMs: 1000 });
    capture.start();
    vi.advanceTimersByTime(1000);
    expect(emit).toHaveBeenCalledTimes(1);

    capture.stop();
    expect(doc.listenerCount('visibilitychange')).toBe(0);

    vi.advanceTimersByTime(10_000);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('stop() is a safe no-op when start() was never called', () => {
    const { capture } = buildCapture();
    expect(() => capture.stop()).not.toThrow();
  });

  it('stop() then start() again resumes normal cadence', () => {
    vi.useFakeTimers();
    const { capture, emit } = buildCapture({ intervalMs: 1000 });
    capture.start();
    capture.stop();
    capture.start();

    vi.advanceTimersByTime(1000);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('uses a stable session_id across every heartbeat from one instance', () => {
    vi.useFakeTimers();
    const { capture, emit } = buildCapture({ intervalMs: 1000, sessionId: undefined });
    capture.start();

    vi.advanceTimersByTime(3000);
    expect(emit).toHaveBeenCalledTimes(3);
    const sessionIds = emit.mock.calls.map(
      ([input]) => (input.payload as { session_id: string }).session_id,
    );
    expect(new Set(sessionIds).size).toBe(1);
    expect(sessionIds[0]).toMatch(/^sess_[0-9a-f]+$/);
  });

  it('defaults intervalMs to DEFAULT_HEARTBEAT_INTERVAL_MS when unset', () => {
    vi.useFakeTimers();
    const { capture, emit } = buildCapture({ intervalMs: undefined });
    capture.start();

    vi.advanceTimersByTime(DEFAULT_HEARTBEAT_INTERVAL_MS - 1);
    expect(emit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('with no injected doc and no global document (SSR-like), start()/stop() never throw and nothing emits', () => {
    vi.stubGlobal('document', undefined);
    const emit = vi.fn();
    const capture = new HeartbeatCapture({ intervalMs: 1000, emit });

    expect(() => capture.start()).not.toThrow();
    vi.useFakeTimers();
    vi.advanceTimersByTime(10_000);
    expect(emit).not.toHaveBeenCalled();
    expect(() => capture.stop()).not.toThrow();
  });

  it('rides the same emit path as every other capture module: default construction resolves getActiveClient()?.emitEvent, with no special-cased delivery', async () => {
    vi.resetModules();
    const emitEvent = vi.fn();
    const getActiveClient = vi.fn(() => ({ emitEvent }));

    vi.doMock('../runtime/client.js', () => ({ getActiveClient }));

    const { HeartbeatCapture: MockedHeartbeatCapture } = await import('./heartbeat.js');
    const doc = fakeDocument('visible');

    vi.useFakeTimers();
    const capture = new MockedHeartbeatCapture({
      intervalMs: 1000,
      sessionId: 'sess_test',
      doc: doc as unknown as HeartbeatCaptureOptions['doc'],
    });
    capture.start();
    vi.advanceTimersByTime(1000);

    expect(getActiveClient).toHaveBeenCalled();
    expect(emitEvent).toHaveBeenCalledTimes(1);
    expect(emitEvent).toHaveBeenCalledWith({
      type: 'heartbeat',
      severity: 'low',
      payload: { session_id: 'sess_test', visible: true },
    });

    vi.doUnmock('../runtime/client.js');
    vi.resetModules();
  });

  it('the default emit is a safe no-op before init() (getActiveClient() returns undefined)', async () => {
    vi.resetModules();
    const getActiveClient = vi.fn(() => undefined);
    vi.doMock('../runtime/client.js', () => ({ getActiveClient }));

    const { HeartbeatCapture: MockedHeartbeatCapture } = await import('./heartbeat.js');
    const doc = fakeDocument('visible');

    vi.useFakeTimers();
    const capture = new MockedHeartbeatCapture({
      intervalMs: 1000,
      doc: doc as unknown as HeartbeatCaptureOptions['doc'],
    });
    capture.start();
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    expect(getActiveClient).toHaveBeenCalled();

    vi.doUnmock('../runtime/client.js');
    vi.resetModules();
  });
});
