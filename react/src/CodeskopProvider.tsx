/**
 * `CodeskopProvider` (`docs/05-api-reference.md` §5.5, `web-sdk-workflow.md`
 * Phase 12): wires `init(config)` on mount and makes the facade functions
 * reachable via `useCodeskop()`.
 *
 * **SSR-safe by construction, not by an explicit `typeof window` check here:**
 * `init()` is only ever called from inside `useEffect`, and React never runs
 * effects while rendering on the server (`renderToString`/`renderToPipeableStream`
 * execute only the render phase) — so this component touches no browser
 * global during a server render. The core's own guards
 * (`core/scriptConfig.ts`'s `typeof document === 'undefined'` check, every
 * facade entrypoint's `safely()` wrapper) are the second line of defense if
 * it were ever imported in a context that did evaluate eagerly.
 *
 * `config` is read once, at mount — matching `init()`'s own contract
 * (`docs/05` §5.1/§5.4): a fresh `CodeskopClient` is cheap to construct and
 * every capture entrypoint is a safe no-op before it runs, so there is no
 * partially-initialized state to protect against. A later change to the
 * `config` prop does **not** re-run `init()` (most apps configure the SDK
 * once, with a value that is stable for the life of the page); call `init()`
 * yourself (re-exported from `@codeskop/tracker`) if a runtime config swap is
 * ever needed.
 */
import { useEffect, useRef, type ReactElement, type ReactNode } from 'react';
import { init, type CodeskopConfig } from '@codeskop/tracker';
import { CodeskopContext, defaultCodeskopContextValue } from './context.js';

export interface CodeskopProviderProps {
  /** Passed to `init()` as-is (`docs/05` §5.1/§5.2). */
  config: CodeskopConfig;
  children?: ReactNode;
}

export function CodeskopProvider({ config, children }: CodeskopProviderProps): ReactElement {
  // Captures whatever `config` was on the first render; effect deps are
  // deliberately empty (see the header comment) so a re-render with a new
  // object identity — the common case for an inline `config={{ ... }}` — never
  // re-triggers `init()`.
  const configRef = useRef(config);

  useEffect(() => {
    init(configRef.current);
  }, []);

  return <CodeskopContext.Provider value={defaultCodeskopContextValue}>{children}</CodeskopContext.Provider>;
}
