/**
 * Byte-size estimation for queued events (`docs/02-architecture.md` §2.5-2.6,
 * `web-sdk-workflow.md` Phase 2) — the durable queue's byte cap and its
 * critical-event reserve are both enforced in terms of this estimate, not
 * event count, so a handful of oversized payloads can't silently blow the
 * footprint budget.
 *
 * The estimate is the UTF-8 byte length of the same JSON the event would take
 * on the wire (`BatchEnvelope.batch`) — close enough for a soft client-side
 * cap; the server independently enforces the hard `64 KB/event` limit
 * (`docs/03` §3.2).
 */
import type { CodeskopEvent } from '../model/types.js';

const encoder = new TextEncoder();

/** UTF-8 byte length of `event` serialized as wire JSON. */
export function estimateEventBytes(event: CodeskopEvent): number {
  return encoder.encode(JSON.stringify(event)).length;
}
