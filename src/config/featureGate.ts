/**
 * The applied-config lookup surface later capture modules (network, error,
 * heartbeat) check before doing work (`docs/02` §2.6, Phase 8 goal). Wraps
 * whatever `RemoteConfig` is currently in effect and answers three
 * questions: is the kill-switch tripped, is this named feature on, and
 * what's the sample rate / queue cap. Kept separate from
 * `core/state.ts`'s `ClientStateMachine` — the kill-switch is a distinct,
 * directly-checkable fact about the *last-fetched config*, independent of
 * whatever lifecycle state the client happens to be in.
 */
import type { RemoteConfig } from '../model/types.js';
import { DEFAULT_REMOTE_CONFIG } from './defaults.js';

/** Read/update view over the currently-applied `RemoteConfig`. */
export class FeatureGate {
  private config: RemoteConfig;

  constructor(initial: RemoteConfig = DEFAULT_REMOTE_CONFIG) {
    this.config = initial;
  }

  /** Swaps in a newly-fetched config, e.g. after each `ConfigSource.fetchConfig()`. */
  update(config: RemoteConfig): void {
    this.config = config;
  }

  /** The config currently in effect. */
  get current(): RemoteConfig {
    return this.config;
  }

  /**
   * The kill-switch, as a distinct checkable state: `true` only when the
   * server has explicitly sent `enabled:false`. Every capture entrypoint
   * should treat this as an immediate, total no-op regardless of any other
   * per-feature gate.
   */
  isKillSwitched(): boolean {
    return this.config.enabled === false;
  }

  /**
   * Whether a named feature (e.g. `"network"`, `"anr"`) is enabled. A
   * feature absent from the response is *not* the same as `false` — it
   * means the current plan/backend doesn't gate that feature at all, so it
   * defaults to `fallback` (permissive: `true`) rather than being silently
   * disabled by an incomplete config payload.
   */
  isFeatureEnabled(name: string, fallback = true): boolean {
    if (this.isKillSwitched()) return false;
    const value = this.config.features[name];
    return value === undefined ? fallback : value;
  }

  /** The configured sample rate for `eventType`, or `fallback` (default: keep everything) when unset. */
  sampleRate(eventType: string, fallback = 1): number {
    const value = this.config.sample_rates[eventType];
    return value === undefined ? fallback : value;
  }

  /** The local queue's byte cap, in megabytes. */
  maxQueueMb(): number {
    return this.config.max_queue_mb;
  }
}
