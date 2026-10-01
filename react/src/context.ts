/**
 * The React context this adapter wires (`docs/05-api-reference.md` §5.5,
 * `web-sdk-workflow.md` Phase 12). Holds the same guarded, no-op-before-`init()`
 * functions the vanilla core exports (`docs/05` §5.4) — the context exists so
 * a component can reach them via `useCodeskop()` without importing
 * `@codeskop/tracker` directly, and so tests can substitute a fake
 * implementation by rendering `CodeskopContext.Provider` with their own value
 * (`useCodeskop.test.tsx`).
 */
import { createContext } from 'react';
import { flush, identify, recordException, reset, screen, setEnabled, track } from '@codeskop/tracker';

export interface CodeskopContextValue {
  /** `docs/05` §5.3 — report a handled error the app caught itself. */
  recordException: typeof recordException;
  /** `docs/05` §5.3 — associate subsequent events with a stable logical user. */
  identify: typeof identify;
  /** `docs/05` §5.3 — clear the current user (e.g. on logout). */
  reset: typeof reset;
  /** `docs/05` §5.3 — local pause/resume of capture, independent of the remote kill-switch. */
  setEnabled: typeof setEnabled;
  /** `docs/05` §5.3 — best-effort expedited drain of the queue. */
  flush: typeof flush;
  /** Product analytics — a custom event with properties. */
  track: typeof track;
  /** Product analytics — a screen or page view (pages are captured automatically). */
  screen: typeof screen;
}

/**
 * The default context value: the real facade functions, singletons shared by
 * every consumer regardless of which (if any) `CodeskopProvider` is above
 * them. Every one of them is already a safe no-op before `init()`
 * (`docs/05` §5.4), so `useCodeskop()` never needs a provider to be safe to
 * call — the provider's only job is wiring `init()` itself.
 */
export const defaultCodeskopContextValue: CodeskopContextValue = {
  recordException,
  identify,
  reset,
  setEnabled,
  flush,
  track,
  screen,
};

export const CodeskopContext = createContext<CodeskopContextValue>(defaultCodeskopContextValue);
