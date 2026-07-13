/**
 * Event sampling (`docs/03` §3.6, `CodeskopConfig.sampleRates` / `RemoteConfig.sample_rates`).
 * `exception` and `api_error` are never sampled away — every failure is kept —
 * while high-volume, low-severity `api_timing` is sampled at a configurable
 * rate to bound wire volume without losing failure signal.
 */
import type { EventType } from '../model/types.js';

/** Event types always kept at 100%, regardless of any configured rate. */
export const ALWAYS_SAMPLED_TYPES: readonly EventType[] = ['api_error', 'exception'];

/** A source of randomness in `[0, 1)`. Injectable so sampling decisions are deterministic in tests. */
export type RandomSource = () => number;

export interface SamplerOptions {
  /** Per-type sample rate in `[0, 1]`, keyed by `EventType` (e.g. `{ api_timing: 0.1 }`). Missing types default to `1`. */
  sampleRates?: Partial<Record<EventType, number>>;
  /** Injectable randomness source. Defaults to `Math.random`. */
  random?: RandomSource;
}

function isAlwaysSampled(type: EventType): boolean {
  return ALWAYS_SAMPLED_TYPES.includes(type);
}

function clampRate(rate: number): number {
  if (Number.isNaN(rate)) return 1;
  return Math.min(1, Math.max(0, rate));
}

/**
 * Decides which events are kept for delivery, per `EventType` sample rate.
 * `rateFor`/`shouldSample` are pure given the injected `random`, so decisions
 * are fully deterministic and testable.
 */
export class Sampler {
  private readonly sampleRates: Partial<Record<EventType, number>>;
  private readonly random: RandomSource;

  constructor(options: SamplerOptions = {}) {
    this.sampleRates = options.sampleRates ?? {};
    this.random = options.random ?? Math.random;
  }

  /** The effective rate for `type`, clamped to `[0, 1]`. Always-sampled types report `1`. */
  rateFor(type: EventType): number {
    if (isAlwaysSampled(type)) return 1;
    const configured = this.sampleRates[type];
    if (configured === undefined) return 1;
    return clampRate(configured);
  }

  /** `true` if an event of `type` should be kept for delivery. */
  shouldSample(type: EventType): boolean {
    const rate = this.rateFor(type);
    if (rate >= 1) return true;
    if (rate <= 0) return false;
    return this.random() < rate;
  }
}
