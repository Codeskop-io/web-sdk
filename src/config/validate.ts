/**
 * Defensive parsing for `GET /v1/config` response bodies. The server is
 * trusted infrastructure, but the SDK still validates shape before trusting
 * it — a malformed or unexpected body must be treated the same as a failed
 * fetch (fall back to last-known-good), never crash a capture path with a
 * bad `.features[x]` lookup (`docs/04` §4.5).
 */
import type { RemoteConfig } from '../model/types.js';

function isRecordOf<T>(
  value: unknown,
  isValue: (v: unknown) => v is T,
): value is Record<string, T> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every(isValue);
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

/** `true` if `value` has every field `RemoteConfig` requires, correctly typed. */
export function isRemoteConfig(value: unknown): value is RemoteConfig {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    isBoolean(candidate.enabled) &&
    isRecordOf(candidate.sample_rates, isNumber) &&
    isRecordOf(candidate.features, isBoolean) &&
    isNumber(candidate.max_queue_mb) &&
    (candidate.etag === undefined || typeof candidate.etag === 'string')
  );
}

/**
 * Parses an unknown response body into a `RemoteConfig`, stamping `etag`
 * (from the response's `ETag` header, when present) onto the result.
 * Returns `undefined` for anything that doesn't match the contract shape —
 * callers must treat that identically to a fetch failure.
 */
export function parseRemoteConfig(body: unknown, etag?: string): RemoteConfig | undefined {
  if (!isRemoteConfig(body)) return undefined;
  return etag ? { ...body, etag } : { ...body };
}
