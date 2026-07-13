/**
 * Schedules non-urgent work off the critical path (`docs/02` §2.3,
 * `web-sdk-workflow.md` Phase 4): prefers `requestIdleCallback` so a
 * sync-trigger check never competes with the host page's own
 * rendering/input work, falling back to a zero-delay `setTimeout` on hosts
 * that lack it (Safari, Node/SSR, some WebViews) so scheduling still works
 * everywhere, just without the idle-time preference.
 */

export type CancelIdle = () => void;

interface IdleCapableGlobal {
  requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
}

/** Runs `callback` when idle (or on the next macrotask if unavailable). Returns a canceller, safe to call more than once. */
export function runWhenIdle(callback: () => void, timeoutMs = 2000): CancelIdle {
  const idleGlobal = globalThis as unknown as IdleCapableGlobal;

  if (typeof idleGlobal.requestIdleCallback === 'function') {
    const handle = idleGlobal.requestIdleCallback(callback, { timeout: timeoutMs });
    return () => idleGlobal.cancelIdleCallback?.(handle);
  }

  const handle = setTimeout(callback, 0);
  return () => clearTimeout(handle);
}
