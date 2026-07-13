/**
 * The last-known-good `RemoteConfig` cache (`docs/01` D4/D9, `docs/04` §4.5):
 * persisted so a page reload — or a launch with no network — still has a
 * real config to apply instead of falling straight to the hardcoded
 * default. Backed by `localStorage`, but every operation is defensive:
 * storage can be absent (SSR, some embedded webviews), full (quota
 * exceeded), or disabled (Safari private mode throws on `setItem`), and
 * none of that may ever propagate into the caller.
 */
import type { RemoteConfig } from '../model/types.js';
import { isRemoteConfig } from './validate.js';

/** The subset of the `Storage` interface the cache needs — narrow enough to fake trivially in tests. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Versioned so a future incompatible shape change can be ignored instead of misread. */
export const CONFIG_CACHE_KEY = 'codeskop:config:v1';

/**
 * The default storage for a browser environment: the global `localStorage`,
 * when one exists and is actually usable. Returns `undefined` rather than
 * throwing when it's absent or inaccessible (e.g. `SecurityError` on some
 * locked-down embeds).
 */
export function resolveDefaultStorage(): StorageLike | undefined {
  try {
    const storage = (globalThis as { localStorage?: StorageLike }).localStorage;
    return storage ?? undefined;
  } catch {
    return undefined;
  }
}

/** Reads and validates the cached last-known-good config. `undefined` on any absence/corruption/error. */
export function readCachedConfig(storage: StorageLike | undefined): RemoteConfig | undefined {
  if (!storage) return undefined;
  try {
    const raw = storage.getItem(CONFIG_CACHE_KEY);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    return isRemoteConfig(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Persists `config` as the new last-known-good. Swallows any storage error (quota, disabled, absent). */
export function writeCachedConfig(storage: StorageLike | undefined, config: RemoteConfig): void {
  if (!storage) return;
  try {
    storage.setItem(CONFIG_CACHE_KEY, JSON.stringify(config));
  } catch {
    // Intentionally swallowed: a full/disabled store must not block config handling.
  }
}
