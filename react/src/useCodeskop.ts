/**
 * `useCodeskop()` (`docs/05-api-reference.md` §5.5): reads `CodeskopContext`.
 * Works with or without a `CodeskopProvider` above it in the tree — the
 * context's default value is the real facade functions (`context.ts`), and
 * every one of them is already a safe no-op before `init()` (`docs/05` §5.4)
 * — so a component can call `useCodeskop().recordException(...)` and it
 * simply does nothing useful until `init()` has run, exactly like calling the
 * vanilla function directly would.
 */
import { useContext } from 'react';
import { CodeskopContext, type CodeskopContextValue } from './context.js';

export function useCodeskop(): CodeskopContextValue {
  return useContext(CodeskopContext);
}
