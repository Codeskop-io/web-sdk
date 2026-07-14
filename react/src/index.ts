/**
 * `@codeskop/tracker-react` public entry point (`docs/05-api-reference.md`
 * §5.5, `web-sdk-workflow.md` Phase 12). A thin adapter over the vanilla core
 * (`@codeskop/tracker`) — the core stays a zero-dependency, framework-free
 * package (`docs/02-architecture.md` §2.1); this package is the only one that
 * depends on `react`, so a vanilla consumer of `@codeskop/tracker` never pays
 * for it.
 */
export { CodeskopProvider, type CodeskopProviderProps } from './CodeskopProvider.js';
export { CodeskopErrorBoundary, type CodeskopErrorBoundaryProps } from './CodeskopErrorBoundary.js';
export { useCodeskop } from './useCodeskop.js';
export { CodeskopContext, type CodeskopContextValue } from './context.js';
