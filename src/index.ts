/**
 * `@codeskop/tracker` public entry point (`docs/05-api-reference.md`,
 * finalized in `web-sdk-workflow.md` Phase 10). Every export below is a safe
 * no-op before `init()` and never throws into the host page (`docs/05`
 * §5.4) — see `facade.ts` for `init`/`identify`/`reset`/`setEnabled`/`flush`
 * and `capture/errors.ts` for `recordException`.
 */
export { init, identify, reset, setEnabled, flush, track, screen } from './facade.js';
export { recordException } from './capture/errors.js';

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
  AnalyticsPayload,
  IdentifyPayload,
  Properties,
  PropertyValue,
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
