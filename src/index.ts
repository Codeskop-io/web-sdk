/**
 * `@codeskop/tracker` public entry point.
 *
 * Phase 0 exports only the wire-contract and seam types other work streams build
 * against; `init`/`identify`/etc. land in later phases (`docs/05-api-reference.md`).
 */
export type {
  EventType,
  Severity,
  UserRef,
  DeviceContext,
  AppContext,
  NetworkTiming,
  ApiErrorPayload,
  ApiTimingPayload,
  StackFrame,
  ExceptionPayload,
  HeartbeatPayload,
  EventPayload,
  CodeskopEvent,
  BatchEnvelope,
  Clock,
  QueueLike,
  TransportResult,
  Transport,
  RemoteConfig,
  ConfigSource,
  CodeskopConfig,
} from './model/types.js';
