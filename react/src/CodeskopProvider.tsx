/**
 * `CodeskopProvider` (`docs/05-api-reference.md` §5.5, `web-sdk-workflow.md`
 * Phase 12): calls `init(config)` on its first render in the browser and makes
 * the facade functions reachable via `useCodeskop()`.
 *
 * **SSR-safe:** `init()` only runs when `window` exists, so a server render
 * (`renderToString`/`renderToPipeableStream`, Next.js Server and Client
 * Component pre-rendering) starts nothing. The package ships a `'use client'`
 * directive, so Next.js App Router Server Components can render it directly.
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
import { useRef, type ReactElement, type ReactNode } from 'react';
import { init, type CodeskopConfig } from '@codeskop/tracker';
import { CodeskopContext, defaultCodeskopContextValue } from './context.js';

export interface CodeskopProviderProps {
  /** Passed to `init()` as-is (`docs/05` §5.1/§5.2). */
  config: CodeskopConfig;
  children?: ReactNode;
}

export function CodeskopProvider({ config, children }: CodeskopProviderProps): ReactElement {
  // Start the SDK during the provider's first render in the browser, not in an
  // effect: React runs children's effects before their parent's, so an
  // effect-based init let a child's first-mount `identify()` run against no
  // client and be dropped. `config` is read once (see the header comment), so a
  // re-render with a new inline object never re-runs `init()`. On the server
  // there is no `window`, and nothing starts.
  const started = useRef(false);
  if (!started.current && typeof window !== 'undefined') {
    started.current = true;
    init(config);
  }

  return <CodeskopContext.Provider value={defaultCodeskopContextValue}>{children}</CodeskopContext.Provider>;
}
