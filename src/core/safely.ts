/**
 * The `safely()` guard — the structural enforcement of the prime directive
 * (D4, `docs/01` §1.2, `docs/04` §4.5): a defect in *our* code becomes a
 * dropped event and an internal diagnostic, **never** a host-page error, a
 * blocked main thread, or a broken network request.
 *
 * Every future capture hook and public entrypoint gets wrapped in this before
 * it touches host code or host data.
 */

/** Reports a swallowed error. Never let this itself throw — see `safely`'s catch-around-onError. */
export type DiagnosticHandler = (error: unknown, context?: string) => void;

export interface SafelyOptions {
  /** Called with the swallowed error. Defaults to a silent no-op. */
  onError?: DiagnosticHandler;
  /** A label (e.g. the hook name) attached to diagnostics, to aid triage without a stack. */
  context?: string;
}

const noopDiagnosticHandler: DiagnosticHandler = () => {};

/** Invokes `onError`, swallowing anything *it* throws too — a diagnostic callback must never become the new unguarded failure. */
function reportSafely(onError: DiagnosticHandler, error: unknown, context: string | undefined): void {
  try {
    onError(error, context);
  } catch {
    // Intentionally swallowed: a broken diagnostic handler must not defeat the guard it's attached to.
  }
}

/**
 * Wraps an async (or `Promise`-returning) `fn` so a rejection is swallowed and
 * reported instead of propagating; the wrapped function always resolves.
 */
export function safely<Args extends unknown[], R>(
  fn: (...args: Args) => Promise<R>,
  options?: SafelyOptions,
): (...args: Args) => Promise<R | undefined>;
/**
 * Wraps a sync `fn` so a thrown error is swallowed and reported instead of
 * propagating; the wrapped function always returns (never throws).
 */
export function safely<Args extends unknown[], R>(
  fn: (...args: Args) => R,
  options?: SafelyOptions,
): (...args: Args) => R | undefined;
export function safely(
  fn: (...args: unknown[]) => unknown,
  options: SafelyOptions = {},
): (...args: unknown[]) => unknown {
  const onError = options.onError ?? noopDiagnosticHandler;
  const context = options.context;

  return (...args: unknown[]): unknown => {
    try {
      const result = fn(...args);
      if (result instanceof Promise) {
        return result.catch((error: unknown) => {
          reportSafely(onError, error, context);
          return undefined;
        });
      }
      return result;
    } catch (error) {
      reportSafely(onError, error, context);
      return undefined;
    }
  };
}
