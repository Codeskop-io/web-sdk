/**
 * `@codeskop/tracker` public entry point.
 *
 * `init` lands in Phase 4 (`web-sdk-workflow.md`, `docs/05-api-reference.md` §5.1);
 * `identify`/`reset`/`recordException`/`setEnabled`/`flush` land once the capture
 * modules that need them exist (Phase 5+).
 */
export { init } from './facade.js';

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
