/**
 * Exponential backoff with full jitter for transient (`5xx`/network) send
 * failures (`docs/02` §2.4). Pure given an injectable random source, so retry
 * timing is deterministic and fast under test — no real timers needed to
 * assert the schedule.
 */

/** A source of randomness in `[0, 1)`, injectable for deterministic tests. */
export type RandomSource = () => number;

export interface BackoffOptions {
  /** Delay before the first retry, in ms. Defaults to `500`. */
  baseMs?: number;
  /** Upper bound on the (pre-jitter) exponential delay, in ms. Defaults to `30_000`. */
  maxMs?: number;
  /** Injectable randomness source. Defaults to `Math.random`. */
  random?: RandomSource;
}

const DEFAULT_BASE_MS = 500;
const DEFAULT_MAX_MS = 30_000;

/**
 * The delay before retry attempt `attempt` (1-indexed: `1` is the delay before
 * the *first* retry, after the initial send already failed). Full-jitter:
 * `random() * min(maxMs, baseMs * 2^(attempt-1))`, so retries spread out
 * rather than colliding in lockstep.
 */
export function computeBackoffMs(attempt: number, options: BackoffOptions = {}): number {
  const baseMs = options.baseMs ?? DEFAULT_BASE_MS;
  const maxMs = options.maxMs ?? DEFAULT_MAX_MS;
  const random = options.random ?? Math.random;

  const boundedAttempt = Math.max(1, attempt);
  const exponential = baseMs * 2 ** (boundedAttempt - 1);
  const cappedExponential = Math.min(maxMs, exponential);
  return Math.floor(random() * cappedExponential);
}
