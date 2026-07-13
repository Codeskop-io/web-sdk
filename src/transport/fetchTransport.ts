/**
 * Steady-state delivery: `fetch(url, { keepalive: true })` with bounded
 * exponential-backoff retry on `5xx`/network failures (`docs/02` §2.4,
 * `docs/03` §3.2). Used on the batch-size/time/`online` sync triggers; the
 * unload path (`visibilitychange`/`pagehide`) is `BeaconTransport`
 * (`beaconTransport.ts`).
 *
 * Auth is the public ingest key only, as `Authorization: Bearer cs_*_pk_…`
 * (D5, D7) — never the secret key, and never a client-set `Origin` header
 * (browsers forbid scripts from setting it; it rides along automatically and
 * is what the backend actually enforces origin binding against, D10).
 */
import type { BatchEnvelope, Transport, TransportResult } from '../model/types.js';
import { compressJson } from './compress.js';
import { computeBackoffMs, type BackoffOptions } from './backoff.js';
import { NETWORK_ERROR_RESULT, resultForStatus } from './responseHandling.js';

/** The subset of the `fetch` signature this transport needs — matches the global `fetch`. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface FetchTransportOptions {
  /** Ingest base URL, e.g. `https://api.codeskop.com`. `/v1/events` is appended. */
  endpoint: string;
  /** The public ingest key (`cs_*_pk_…`), sent as `Authorization: Bearer <apiKey>`. */
  apiKey: string;
  /** Injectable `fetch`. Defaults to the global. */
  fetchImpl?: FetchLike;
  /** Retry attempts after the first send, for `5xx`/network failures only. Defaults to `3`. */
  maxRetries?: number;
  /** Backoff timing between retries. Injectable for deterministic tests. */
  backoff?: BackoffOptions;
  /** Injectable delay so retry tests don't need to wait on real timers. Defaults to a real `setTimeout`. */
  delay?: (ms: number) => Promise<void>;
}

const EVENTS_PATH = '/v1/events';

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * `fetch(url, { keepalive: true })` delivery, retrying `5xx`/network failures
 * with exponential backoff up to `maxRetries` before giving up. Implements
 * `Transport`.
 */
export class FetchTransport implements Transport {
  private readonly url: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly maxRetries: number;
  private readonly backoffOptions: BackoffOptions;
  private readonly delay: (ms: number) => Promise<void>;

  constructor(options: FetchTransportOptions) {
    this.url = `${options.endpoint.replace(/\/$/, '')}${EVENTS_PATH}`;
    this.apiKey = options.apiKey;
    // `.bind(globalThis)`: real browsers (unlike jsdom/Node) throw `TypeError:
    // Illegal invocation` if the bare `fetch` reference is extracted and
    // later called detached from its `window` receiver — exactly what
    // storing `globalThis.fetch` itself and calling `this.fetchImpl(...)`
    // would do.
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch?.bind(globalThis) as unknown as FetchLike);
    this.maxRetries = options.maxRetries ?? 3;
    this.backoffOptions = options.backoff ?? {};
    this.delay = options.delay ?? defaultDelay;
  }

  /** Sends `batch`, gzipped, retrying transient failures. Always resolves — never throws into the caller. */
  async send(batch: BatchEnvelope): Promise<TransportResult> {
    const { body, contentEncoding } = await compressJson(JSON.stringify(batch));

    let lastResult: TransportResult = NETWORK_ERROR_RESULT;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (attempt > 0) {
        await this.delay(computeBackoffMs(attempt, this.backoffOptions));
      }
      lastResult = await this.attempt(body, contentEncoding);
      if (!lastResult.retryable) {
        return lastResult;
      }
    }
    // Retries exhausted while still transient: report `retryable: true` so a
    // caller with its own outer retry loop (e.g. the next sync cycle reading
    // from the durable queue) knows the batch is still worth another try.
    return lastResult;
  }

  private async attempt(
    body: Uint8Array<ArrayBuffer>,
    contentEncoding: 'gzip' | undefined,
  ): Promise<TransportResult> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
    if (contentEncoding) {
      headers['Content-Encoding'] = contentEncoding;
    }

    try {
      const response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers,
        body,
        keepalive: true,
      });
      const text = await response.text();
      return resultForStatus(response.status, text);
    } catch {
      return NETWORK_ERROR_RESULT;
    }
  }
}
