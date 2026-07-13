/**
 * Interprets a delivery attempt against the contract's response semantics
 * (`docs/03` §3.2): `2xx` accept (optionally with a partial `{ "rejected":
 * [...] }` body), `4xx` permanent failure, `5xx`/network transient. Shared by
 * every `Transport` implementation so `fetch` and the beacon fallback agree on
 * what each outcome means.
 */
import type { TransportResult } from '../model/types.js';

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * Parses a `2xx` response body for an optional partial-reject list. Never
 * throws: a malformed or empty body on an accepted batch is treated as
 * "nothing rejected" rather than a delivery failure — the batch already
 * succeeded.
 */
export function parseRejected(bodyText: string): string[] | undefined {
  if (!bodyText) return undefined;
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (parsed && typeof parsed === 'object' && 'rejected' in parsed) {
      const rejected = (parsed as { rejected?: unknown }).rejected;
      if (isStringArray(rejected)) return rejected;
    }
  } catch {
    // Malformed body on an already-accepted batch is a diagnostics concern,
    // not a delivery failure — fall through to "nothing rejected".
  }
  return undefined;
}

/** Builds the `TransportResult` for a response that reached the server (i.e. not a network-level failure). */
export function resultForStatus(status: number, bodyText: string): TransportResult {
  if (status >= 200 && status < 300) {
    return { ok: true, status, rejected: parseRejected(bodyText), retryable: false };
  }
  if (status >= 500) {
    return { ok: false, status, retryable: true };
  }
  // 4xx (and any other non-2xx/5xx) is a permanent failure per contract — the
  // caller drops the batch rather than retrying it forever.
  return { ok: false, status, retryable: false };
}

/** The `TransportResult` for a request that never reached the server (DNS/connection/abort/etc). */
export const NETWORK_ERROR_RESULT: TransportResult = { ok: false, retryable: true };
