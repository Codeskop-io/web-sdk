/**
 * `CodeskopErrorBoundary` (`docs/05-api-reference.md` §5.5, `web-sdk-workflow.md`
 * Phase 12): a class component (React error boundaries have no Hook
 * equivalent) that reports render errors caught anywhere in its subtree as
 * `exception` events via `recordException` (`capture/errors.ts`'s handled-error
 * path, `handled: true`), then renders `fallback` in place of the crashed
 * subtree.
 *
 * Imports `recordException` directly from `@codeskop-io/tracker` rather than
 * through `useCodeskop()`/context: it is a process-wide singleton either way
 * (`context.ts`), a class component cannot call a Hook, and this keeps the
 * boundary usable standing alone, without requiring it to be nested inside a
 * `CodeskopProvider` (the `docs/05` §5.5 example nests
 * `<CodeskopProvider><CodeskopErrorBoundary>`, but `recordException` is
 * already a safe no-op before `init()` regardless of nesting order).
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { recordException } from '@codeskop-io/tracker';

export interface CodeskopErrorBoundaryProps {
  children?: ReactNode;
  /**
   * Rendered in place of the crashed subtree. Either a fixed node (matching
   * `docs/05` §5.5's `fallback={<Oops />}`) or a function of the caught error
   * and a `reset()` callback that clears the error and re-renders `children`
   * (useful for a "try again" affordance).
   */
  fallback?: ReactNode | ((error: Error, reset: () => void) => ReactNode);
  /** Optional extra hook for host app logging/analytics, run alongside `recordException`. */
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface CodeskopErrorBoundaryState {
  error: Error | null;
}

/** Normalizes whatever a render threw (React allows any thrown value, not just `Error`) into an `Error`. */
function toError(thrown: unknown): Error {
  return thrown instanceof Error ? thrown : new Error(String(thrown));
}

export class CodeskopErrorBoundary extends Component<CodeskopErrorBoundaryProps, CodeskopErrorBoundaryState> {
  override state: CodeskopErrorBoundaryState = { error: null };

  static getDerivedStateFromError(thrown: unknown): CodeskopErrorBoundaryState {
    return { error: toError(thrown) };
  }

  override componentDidCatch(thrown: unknown, errorInfo: ErrorInfo): void {
    const error = toError(thrown);
    recordException(error, {
      source: 'react-error-boundary',
      componentStack: errorInfo.componentStack ?? undefined,
    });
    this.props.onError?.(error, errorInfo);
  }

  private readonly reset = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const { fallback } = this.props;
    if (typeof fallback === 'function') return fallback(error, this.reset);
    return fallback ?? null;
  }
}
