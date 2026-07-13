/**
 * The `ConfigSource` implementation: fetches `GET /v1/config` on launch,
 * ETag-aware, and never lets a failure reach the caller unhandled (D4, D9,
 * `docs/04` §4.5). Every failure mode — network error, non-2xx, a malformed
 * body, even a broken diagnostic handler — resolves to the last-known-good
 * config (this session's, or the persisted `localStorage` cache) or, absent
 * any of that, the hardcoded `DEFAULT_REMOTE_CONFIG`. `fetchConfig()` is
 * guaranteed to resolve, never reject.
 */
import type { ConfigSource, RemoteConfig } from '../model/types.js';
import type { DiagnosticHandler } from '../core/safely.js';
import { safely } from '../core/safely.js';
import { DEFAULT_REMOTE_CONFIG } from './defaults.js';
import { parseRemoteConfig } from './validate.js';
import {
  readCachedConfig,
  writeCachedConfig,
  resolveDefaultStorage,
  type StorageLike,
} from './cache.js';

/** Just the slice of the `fetch` signature this client needs — trivial to stub in tests. */
export type FetchLike = (
  input: string,
  init: { method: 'GET'; headers: Record<string, string> },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

export interface RemoteConfigClientOptions {
  /** Ingest base URL (e.g. `https://api.codeskop.com`); `/v1/config` is appended. */
  endpoint: string;
  /** Public ingest key (`cs_*_pk_…`), sent as the bearer credential — same rule as `POST /v1/events` (D5). */
  apiKey: string;
  /** Injectable fetch, defaulting to the global `fetch`. */
  fetchImpl?: FetchLike;
  /** Injectable storage for the last-known-good cache, defaulting to `localStorage` when present. */
  storage?: StorageLike;
  /** Reports a swallowed fetch/parse failure. Defaults to a silent no-op — a failure here must never throw or block. */
  onError?: DiagnosticHandler;
}

const CONFIG_PATH = '/v1/config';

/** Fetches, caches, and safely falls back for the remote config seam (`ConfigSource`). */
export class RemoteConfigClient implements ConfigSource {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly storage: StorageLike | undefined;
  private readonly onError: DiagnosticHandler;

  /** This session's most recently successful fetch; checked before falling back to persisted storage. */
  private lastKnownGood: RemoteConfig | undefined;

  constructor(options: RemoteConfigClientOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    // `.bind(globalThis)`: real browsers (unlike jsdom/Node) throw `TypeError:
    // Illegal invocation` if the bare `fetch` reference is extracted and
    // later called detached from its `window` receiver — exactly what
    // storing `globalThis.fetch` itself and calling `this.fetchImpl(...)`
    // would do.
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch?.bind(globalThis) as FetchLike | undefined);
    this.storage = options.storage ?? resolveDefaultStorage();
    this.onError = options.onError ?? (() => {});
    this.lastKnownGood = readCachedConfig(this.storage);
  }

  /**
   * Fetches the current config. Always resolves — a network error, a
   * non-2xx status, an unparseable/invalid body, or the absence of `fetch`
   * itself all fall back to `fallback()` rather than rejecting.
   */
  async fetchConfig(): Promise<RemoteConfig> {
    const guarded = safely(() => this.requestConfig(), {
      onError: this.onError,
      context: 'config-fetch',
    });
    const fetched = await guarded();
    return fetched ?? this.fallback();
  }

  /** The best config available without a network round-trip: this session's, then the persisted cache, then the hardcoded default. */
  private fallback(): RemoteConfig {
    return this.lastKnownGood ?? readCachedConfig(this.storage) ?? DEFAULT_REMOTE_CONFIG;
  }

  /**
   * Performs the actual `GET /v1/config` round-trip. Returns `undefined`
   * (never throws its own expected-failure paths) for anything that should
   * fall back rather than propagate: no `fetch` available, a non-2xx
   * response, or a body that doesn't match the contract shape. A thrown
   * network error is left to propagate to `fetchConfig`'s `safely()` guard.
   */
  private async requestConfig(): Promise<RemoteConfig | undefined> {
    if (typeof this.fetchImpl !== 'function') return undefined;

    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}` };
    const knownEtag = this.lastKnownGood?.etag ?? readCachedConfig(this.storage)?.etag;
    if (knownEtag) headers['If-None-Match'] = knownEtag;

    const response = await this.fetchImpl(`${this.endpoint}${CONFIG_PATH}`, {
      method: 'GET',
      headers,
    });

    if (response.status === 304) {
      return this.lastKnownGood ?? readCachedConfig(this.storage);
    }
    if (!response.ok) return undefined;

    const body: unknown = await response.json();
    const etag = response.headers.get('etag') ?? undefined;
    const parsed = parseRemoteConfig(body, etag);
    if (!parsed) return undefined;

    this.lastKnownGood = parsed;
    writeCachedConfig(this.storage, parsed);
    return parsed;
  }
}
