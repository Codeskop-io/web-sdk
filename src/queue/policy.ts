/**
 * The durable queue's critical-event policy (`web-sdk-workflow.md` Phase 2):
 * decides which queued events are protected by the byte cap's reserved
 * slice. Kept in its own pure module so the eviction logic in
 * `durable-queue.ts` never has to duplicate — or drift from — this
 * definition.
 *
 * Per the phase spec, "critical" means high-severity events and exceptions
 * specifically (`severity: 'high'` or `type: 'exception'`) — narrower than
 * the full `Severity` scale's `'critical'` value, which is left for a future
 * policy revision and intentionally not special-cased here.
 */
import type { CodeskopEvent } from '../model/types.js';

/** `true` if `event` must be protected from drop-oldest eviction under a low-severity flood. */
export function isCriticalEvent(event: CodeskopEvent): boolean {
  return event.severity === 'high' || event.type === 'exception';
}

/** Default fraction of the byte cap reserved exclusively for critical events. */
export const DEFAULT_CRITICAL_RESERVE_RATIO = 0.2;

/** Clamps a reserve ratio to the sane `[0, 1]` range; never throws on bad input (e.g. `NaN`). */
export function clampReserveRatio(ratio: number): number {
  if (Number.isNaN(ratio)) return DEFAULT_CRITICAL_RESERVE_RATIO;
  return Math.min(1, Math.max(0, ratio));
}
