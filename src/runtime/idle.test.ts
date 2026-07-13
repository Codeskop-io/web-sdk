import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWhenIdle } from './idle.js';

describe('runWhenIdle', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('prefers requestIdleCallback when the host provides one', () => {
    const requestIdleCallback = vi.fn((cb: () => void) => {
      cb();
      return 1;
    });
    const cancelIdleCallback = vi.fn();
    vi.stubGlobal('requestIdleCallback', requestIdleCallback);
    vi.stubGlobal('cancelIdleCallback', cancelIdleCallback);

    const callback = vi.fn();
    runWhenIdle(callback);

    expect(requestIdleCallback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('cancels via cancelIdleCallback when requestIdleCallback is available', () => {
    const cancelIdleCallback = vi.fn();
    vi.stubGlobal('requestIdleCallback', vi.fn(() => 42));
    vi.stubGlobal('cancelIdleCallback', cancelIdleCallback);

    const cancel = runWhenIdle(() => {});
    cancel();

    expect(cancelIdleCallback).toHaveBeenCalledWith(42);
  });

  it('falls back to setTimeout when requestIdleCallback is unavailable', () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestIdleCallback', undefined);

    const callback = vi.fn();
    runWhenIdle(callback);

    expect(callback).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('the setTimeout fallback canceller prevents the callback from firing', () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestIdleCallback', undefined);

    const callback = vi.fn();
    const cancel = runWhenIdle(callback);
    cancel();
    vi.runAllTimers();

    expect(callback).not.toHaveBeenCalled();
  });
});
