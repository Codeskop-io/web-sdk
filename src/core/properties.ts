/**
 * Property cleaning shared by `track`, `identify` traits and
 * `recordException` attributes: the wire only carries scalars and lists of
 * scalars (`model/types.ts` `Properties`).
 */
import type { Properties } from '../model/types.js';

/** Keeps scalars and lists of scalars; drops nested objects, functions and non-finite numbers. */
export function cleanProperties(raw: Record<string, unknown> | undefined): Properties {
  const out: Properties = {};
  if (!raw || typeof raw !== 'object') return out;
  const scalar = (v: unknown): string | number | boolean | null | undefined => {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
    if (v instanceof Date) return v.toISOString();
    return undefined;
  };
  for (const [key, value] of Object.entries(raw).slice(0, 100)) {
    if (!key) continue;
    if (Array.isArray(value)) {
      out[key] = value
        .slice(0, 50)
        .map(scalar)
        .filter((v): v is string | number | boolean => v !== undefined && v !== null);
    } else {
      const v = scalar(value);
      if (v !== undefined) out[key] = v;
    }
  }
  return out;
}
