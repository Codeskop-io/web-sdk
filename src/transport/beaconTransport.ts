/**
 * Unload-path delivery: `navigator.sendBeacon` fires the batch as the page is
 * closing (`visibilitychange → hidden` / `pagehide`), since an in-flight
 * `fetch` is not guaranteed to complete once the page starts tearing down
 * (`docs/02` §2.4). There is deliberately no retry/backoff here — by the time
 * a backoff timer fired the page would likely be gone — so a failure just
 * reports `retryable: true` and leaves the batch in the durable queue for the
 * next load.
 *
 * Two real constraints of the Beacon API shape this implementation:
 *
 * - **No custom headers.** `sendBeacon` cannot carry an `Authorization`
 *   header, so the public key travels as a query parameter on this path only
 *   (`?key=…`) — today's mock/backend (`docs/03` §3.2) authenticates via the
 *   header alone and does not honor this, so a real `sendBeacon` delivery
 *   currently 401s server-side. This is a known contract gap for whoever owns
 *   the real endpoint (flagged for Phase 11), not something this transport can
 *   paper over from the browser.
 * - **No response visibility.** `sendBeacon` only reports whether the browser
 *   *queued* the request, never the server's response, so a queued beacon is
 *   reported optimistically as `ok: true` — an intentional
 *   durability/certainty tradeoff the Beacon API forces on every caller.
 *
 * `navigator.sendBeacon` is unavailable outside a browser context (e.g. Node
 * during unit tests, or older browsers): this transport detects its absence
 * and falls back to a single, non-retrying keepalive `fetch` — gzip-compressed
 * and fully authenticated, unlike the beacon path — so behavior (and a real
 * `TransportResult`) is exercised in headless test runs.
 */
import type { BatchEnvelope, Transport, TransportResult } from '../model/types.js';
import { compressJson } from './compress.js';
import { NETWORK_ERROR_RESULT, resultForStatus } from './responseHandling.js';
import type { FetchLike } from './fetchTransport.js';

/** The subset of `navigator.sendBeacon` this transport needs. */
export type SendBeaconLike = (url: string, data?: BodyInit | null) => boolean;

export interface BeaconTransportOptions {
  /** Ingest base URL, e.g. `https://api.codeskop.com`. `/v1/events` is appended. */
  endpoint: string;
  /** The public ingest key (`cs_*_pk_…`). */
  apiKey: string;
  /** Injectable `navigator.sendBeacon`-shaped function. Defaults to the global when present. */
  sendBeaconImpl?: SendBeaconLike;
  /** Fallback `fetch`, used only when `sendBeacon` is unavailable. Defaults to the global. */
  fetchImpl?: FetchLike;
}

const EVENTS_PATH = '/v1/events';

function globalSendBeacon(): SendBeaconLike | undefined {
  if (typeof navigator === 'undefined') return undefined;
  const beacon = navigator.sendBeacon;
  if (typeof beacon !== 'function') return undefined;
  return beacon.bind(navigator);
}

/**
 * `navigator.sendBeacon` delivery with a keepalive-`fetch` fallback when
 * `sendBeacon` is unavailable. Implements `Transport`.
 */
export class BeaconTransport implements Transport {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly sendBeaconImpl: SendBeaconLike | undefined;
  private readonly fetchImpl: FetchLike;

  constructor(options: BeaconTransportOptions) {
    this.endpoint = options.endpoint.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.sendBeaconImpl = options.sendBeaconImpl ?? globalSendBeacon();
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  /**
   * Sends `batch` via `sendBeacon` when available, falling back to a single
   * keepalive `fetch` attempt otherwise. Always resolves — never throws into
   * the caller (the unload path can least afford it).
   */
  async send(batch: BatchEnvelope): Promise<TransportResult> {
    if (this.sendBeaconImpl) {
      return this.sendViaBeacon(batch, this.sendBeaconImpl);
    }
    return this.sendViaFetchFallback(batch);
  }

  private sendViaBeacon(batch: BatchEnvelope, sendBeacon: SendBeaconLike): TransportResult {
    // `sendBeacon` cannot set `Content-Encoding`, so the body must be
    // uncompressed JSON for the server to parse it (see module doc).
    const json = JSON.stringify(batch);
    const blob = new Blob([json], { type: 'application/json' });
    const url = `${this.endpoint}${EVENTS_PATH}?key=${encodeURIComponent(this.apiKey)}`;

    const queued = sendBeacon(url, blob);
    // The browser never surfaces the server's response for a beacon: `queued`
    // only means "accepted for delivery", not "the server 2xx'd it".
    return queued ? { ok: true, retryable: false } : { ok: false, retryable: true };
  }

  private async sendViaFetchFallback(batch: BatchEnvelope): Promise<TransportResult> {
    const { body, contentEncoding } = await compressJson(JSON.stringify(batch));
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
    if (contentEncoding) {
      headers['Content-Encoding'] = contentEncoding;
    }

    try {
      const response = await this.fetchImpl(`${this.endpoint}${EVENTS_PATH}`, {
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
