/**
 * Envelope builder — assembles the §7.5/§3.2 wire shape and enforces the
 * contract's batch limits *before* anything reaches a `Transport`
 * (`docs/03` §3.2, `docs/01` §1.5 D8): ≤ 100 events/batch, ≤ 64 KB/event,
 * ≤ 1 MB compressed. Oversized input is never handed to `Transport.send` as-is
 * — it is split or dropped here, since the backend would otherwise reject it
 * outright (`400`/`413`) and the caller would have burned a request for
 * nothing.
 *
 * The ≤ 1 MB cap applies to the *compressed* body, which can only be known
 * after gzip — so this builder actually compresses each candidate batch (via
 * the injectable `compress`, defaulting to the real `compressJson`) and
 * halves it until it fits. A single event can never trip this on its own: the
 * per-event cap (64 KB uncompressed) guarantees a lone event's gzip output is
 * always well under 1 MB, so recursion always has a safe floor.
 */
import type {
  AppContext,
  BatchEnvelope,
  Clock,
  CodeskopEvent,
  DeviceContext,
} from '../model/types.js';
import { systemClock } from '../core/id.js';
import { compressJson } from './compress.js';
import { resolveBrowserOrigin } from './origin.js';
import { MAX_COMPRESSED_BYTES, MAX_EVENT_BYTES, MAX_EVENTS_PER_BATCH } from './constants.js';

const textEncoder = new TextEncoder();

/** UTF-8 byte length of `event` once serialized — matches what actually goes on the wire. */
export function eventByteSize(event: CodeskopEvent): number {
  return textEncoder.encode(JSON.stringify(event)).length;
}

/** The batch-level context the caller supplies; `app.origin` is resolved/overridden here (D10). */
export interface BuildBatchesContext {
  device: DeviceContext;
  /** `origin` is filled from `window.location.origin` when a browser `window` is present; pass a fallback for non-browser callers/tests. */
  app: Omit<AppContext, 'origin'> & { origin?: string };
}

export interface BuildBatchesOptions {
  /** Injectable time source for `sent_at`. Defaults to the real clock. */
  clock?: Clock;
  maxEventsPerBatch?: number;
  maxEventBytes?: number;
  maxCompressedBytes?: number;
  /** Injectable compressor, used only to measure compressed size. Defaults to `compressJson`. */
  compress?: (json: string) => Promise<{ body: Uint8Array }>;
}

export interface BuildBatchesResult {
  /** Ready-to-send envelopes; each already respects every batch limit. */
  batches: BatchEnvelope[];
  /** `event_id`s dropped because a single event alone exceeds `maxEventBytes` — it could never fit, split or not. */
  droppedOversized: string[];
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) return items.length === 0 ? [] : [items.slice()];
  const groups: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    groups.push(items.slice(i, i + size));
  }
  return groups;
}

function splitInHalf<T>(items: readonly T[]): [T[], T[]] {
  const mid = Math.ceil(items.length / 2);
  return [items.slice(0, mid), items.slice(mid)];
}

function resolveContext(context: BuildBatchesContext): BatchEnvelope['context'] {
  const origin = resolveBrowserOrigin() ?? context.app.origin;
  return {
    device: context.device,
    // `origin` is `string | undefined` at runtime (no browser, no fallback
    // supplied) even though `AppContext.origin` is typed as a required
    // `string` — the wire contract tolerates its absence; see `docs/03` §3.3.
    app: { ...context.app, origin } as AppContext,
  };
}

/**
 * Splits `events` into one or more contract-shaped `BatchEnvelope`s. Drops any
 * single event over `maxEventBytes` (default 64 KB) into `droppedOversized`
 * rather than sending it to be rejected; chunks the remainder to at most
 * `maxEventsPerBatch` (default 100) events each; and, for any chunk whose
 * compressed size would exceed `maxCompressedBytes` (default 1 MB), halves it
 * repeatedly until every resulting envelope fits.
 */
export async function buildBatches(
  events: readonly CodeskopEvent[],
  context: BuildBatchesContext,
  options: BuildBatchesOptions = {},
): Promise<BuildBatchesResult> {
  const clock = options.clock ?? systemClock;
  const maxEventsPerBatch = options.maxEventsPerBatch ?? MAX_EVENTS_PER_BATCH;
  const maxEventBytes = options.maxEventBytes ?? MAX_EVENT_BYTES;
  const maxCompressedBytes = options.maxCompressedBytes ?? MAX_COMPRESSED_BYTES;
  const compress = options.compress ?? compressJson;

  const droppedOversized: string[] = [];
  const kept: CodeskopEvent[] = [];
  for (const event of events) {
    if (eventByteSize(event) > maxEventBytes) {
      droppedOversized.push(event.event_id);
      continue;
    }
    kept.push(event);
  }

  const resolvedContext = resolveContext(context);
  const sentAt = new Date(clock.now()).toISOString();

  const batches: BatchEnvelope[] = [];
  const pending: CodeskopEvent[][] = chunk(kept, maxEventsPerBatch);

  while (pending.length > 0) {
    const group = pending.shift();
    if (!group || group.length === 0) continue;

    const envelope: BatchEnvelope = { sent_at: sentAt, context: resolvedContext, batch: group };

    if (group.length === 1) {
      // The smallest possible unit: a lone event's gzip output can never
      // exceed the compressed cap (see the module doc), so accept it as-is
      // rather than measuring — and so this loop always terminates.
      batches.push(envelope);
      continue;
    }

    const { body } = await compress(JSON.stringify(envelope));
    if (body.length <= maxCompressedBytes) {
      batches.push(envelope);
      continue;
    }

    const [first, second] = splitInHalf(group);
    pending.unshift(first, second);
  }

  return { batches, droppedOversized };
}
