/**
 * `src/transport` public surface (`docs/02` §2.1) — envelope building, gzip,
 * and the two `Transport` implementations (steady-state `fetch` keepalive and
 * unload-path `sendBeacon`). Consumed by the runtime (Phase 4) to drain the
 * durable queue.
 */
export { MAX_COMPRESSED_BYTES, MAX_EVENT_BYTES, MAX_EVENTS_PER_BATCH } from './constants.js';
export { eventByteSize, buildBatches } from './envelope.js';
export type { BuildBatchesContext, BuildBatchesOptions, BuildBatchesResult } from './envelope.js';
export { compressJson } from './compress.js';
export type { CompressedBody } from './compress.js';
export { computeBackoffMs } from './backoff.js';
export type { BackoffOptions, RandomSource } from './backoff.js';
export { parseRejected, resultForStatus, NETWORK_ERROR_RESULT } from './responseHandling.js';
export { resolveBrowserOrigin } from './origin.js';
export { FetchTransport } from './fetchTransport.js';
export type { FetchLike, FetchTransportOptions } from './fetchTransport.js';
export { BeaconTransport } from './beaconTransport.js';
export type { BeaconTransportOptions, SendBeaconLike } from './beaconTransport.js';
