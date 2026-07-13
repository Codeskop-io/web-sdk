/**
 * Wire-contract limits for `POST /v1/events` (`docs/03` §3.2, shared with the
 * backend and Android SDK). Enforced by the envelope builder (per-batch/
 * per-event) and defensively re-checked around compression (compressed cap),
 * since the compressed size can only be known after gzip.
 */

/** Maximum events in a single `BatchEnvelope.batch`. */
export const MAX_EVENTS_PER_BATCH = 100;

/** Maximum serialized (uncompressed) size of a single `CodeskopEvent`, in bytes. */
export const MAX_EVENT_BYTES = 64 * 1024;

/** Maximum gzip-compressed size of a single request body, in bytes. */
export const MAX_COMPRESSED_BYTES = 1 * 1024 * 1024;
