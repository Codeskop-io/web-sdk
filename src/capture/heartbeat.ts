/**
 * Presence heartbeat (D2; `docs/01` §D2, `docs/03-capture-and-event-model.md`
 * §3.1/§3.2, `web-sdk-workflow.md` Phase 9). Presence is derived server-side
 * from these timestamps — there is no dedicated connection or socket, only a
 * low-severity `heartbeat` event on an interval, and only while the page is
 * visible (Page Visibility API). A hidden/backgrounded tab's timer is torn
 * down entirely rather than merely skipping the emit, so a background tab
 * costs nothing (D2's battery/CPU rationale).
 *
 * Every heartbeat rides the SDK's normal batched sync path: this module's
 * only job is to call `emitEvent` (`runtime/client.ts`'s seam, resolved via
 * `getActiveClient()`) on the right cadence — the queue, batching, and
 * transport it flows through afterwards are identical to every other event
 * type. `undefined` before `init()` is a safe no-op, same as any other
 * capture module (`docs/05` §5.4).
 */
import type { EventPayload } from '../model/types.js';
import type { EmitEventInput } from '../runtime/client.js';
import { getActiveClient } from '../runtime/client.js';
import { safely } from '../core/safely.js';

/** How often a visible tab emits a heartbeat, in ms. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

/** The slice of `Document` this module needs — trivial to fake in tests. */
type DocumentLike = Pick<Document, 'addEventListener' | 'removeEventListener'> & {
  readonly visibilityState: string;
};

/** An opaque interval handle — deliberately not `typeof setInterval`'s own (overloaded, DOM-vs-Node) return type (`runtime/syncScheduler.ts`). */
type IntervalHandle = ReturnType<typeof setInterval>;

export interface HeartbeatCaptureOptions {
  /** How often a visible tab emits, in ms. Defaults to `DEFAULT_HEARTBEAT_INTERVAL_MS`. */
  intervalMs?: number;
  /** Injectable `Document` for tests; defaults to the real global `document` (`undefined` outside a browser). */
  doc?: DocumentLike;
  /** Injectable emit seam for tests; defaults to `getActiveClient()?.emitEvent`. */
  emit?: (input: EmitEventInput) => void;
  /** The session id, or a function returning the current one (shared with analytics events). Defaults to a fresh id per page load. */
  sessionId?: string | (() => string);
  /** Narrowed to exactly the shape this module calls — see the note above `defaultSetInterval` in `runtime/syncScheduler.ts`. */
  setIntervalImpl?: (callback: () => void, intervalMs: number) => IntervalHandle;
  clearIntervalImpl?: (handle: IntervalHandle) => void;
}

function resolveDefaultDocument(): DocumentLike | undefined {
  return typeof document !== 'undefined' ? document : undefined;
}

/** Resolves the currently-active client's `emitEvent` lazily, on every call — never captured at construction, since `init()` may run after this module is. */
function defaultEmit(input: EmitEventInput): void {
  getActiveClient()?.emitEvent(input);
}

// `setInterval`/`clearInterval` are WebIDL platform methods that real
// browsers throw `TypeError: Illegal invocation` for if called detached from
// their `window` receiver (`runtime/syncScheduler.ts`'s note on this exact
// bug). Calling through an unqualified identifier inside a plain wrapper
// resolves via the global object at call time instead of a stored, detached
// reference.
function defaultSetInterval(callback: () => void, intervalMs: number): IntervalHandle {
  return setInterval(callback, intervalMs);
}

function defaultClearInterval(handle: IntervalHandle): void {
  clearInterval(handle);
}

/** Fills `length` random bytes via Web Crypto where available, else `Math.random` — mirrors `core/id.ts`/`core/installId.ts`; never throws. */
function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  const cryptoObj: Crypto | undefined = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    cryptoObj.getRandomValues(bytes);
    return bytes;
  }
  for (let i = 0; i < length; i += 1) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

/** Generates a fresh per-page-load session id — random, not persisted (unlike `installId`; a reload starts a new session). */
function generateSessionId(): string {
  const hex = Array.from(randomBytes(16), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `sess_${hex}`;
}

/**
 * Emits a low-severity `heartbeat` on `intervalMs`, but only while
 * `doc.visibilityState === 'visible'`. `start()` attaches a
 * `visibilitychange` listener and, if already visible, starts the interval
 * immediately; the interval itself is started/stopped on every visibility
 * transition rather than left running and gated per-tick, so a hidden tab
 * has no timer at all. `stop()` tears everything down (idempotent) — the
 * same shape as `runtime/syncScheduler.ts`'s `SyncScheduler`.
 */
export class HeartbeatCapture {
  private readonly intervalMs: number;
  private readonly doc: DocumentLike | undefined;
  private readonly emit: (input: EmitEventInput) => void;
  private readonly sessionId: () => string;
  private readonly setIntervalImpl: (callback: () => void, intervalMs: number) => IntervalHandle;
  private readonly clearIntervalImpl: (handle: IntervalHandle) => void;

  private intervalHandle: IntervalHandle | undefined;
  private started = false;

  private readonly handleVisibilityChange = (): void => {
    if (this.isVisible()) {
      this.startInterval();
    } else {
      this.stopInterval();
    }
  };

  constructor(options: HeartbeatCaptureOptions = {}) {
    this.intervalMs = options.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.doc = options.doc ?? resolveDefaultDocument();
    this.emit = options.emit ?? defaultEmit;
    const sessionId = options.sessionId ?? generateSessionId();
    this.sessionId = typeof sessionId === 'function' ? sessionId : () => sessionId;
    this.setIntervalImpl = options.setIntervalImpl ?? defaultSetInterval;
    this.clearIntervalImpl = options.clearIntervalImpl ?? defaultClearInterval;
  }

  /** Attaches the `visibilitychange` listener and, if currently visible, starts the interval. Idempotent. Never throws (`safely()`-guarded). */
  readonly start = safely(
    (): void => {
      if (this.started) return;
      this.started = true;

      this.doc?.addEventListener('visibilitychange', this.handleVisibilityChange);
      if (this.isVisible()) this.startInterval();
    },
    { context: 'heartbeat.start' },
  );

  /** Detaches the listener and clears any running interval. Idempotent; safe even if `start()` was never called. */
  readonly stop = safely(
    (): void => {
      if (!this.started) return;
      this.started = false;

      this.doc?.removeEventListener('visibilitychange', this.handleVisibilityChange);
      this.stopInterval();
    },
    { context: 'heartbeat.stop' },
  );

  /** `true` only when there's a `Document` and it reports `'visible'` — no `document` at all (SSR) is treated as not visible. */
  private isVisible(): boolean {
    return this.doc?.visibilityState === 'visible';
  }

  private startInterval(): void {
    if (this.intervalHandle !== undefined) return;
    this.intervalHandle = this.setIntervalImpl(() => this.emitHeartbeat(), this.intervalMs);
  }

  private stopInterval(): void {
    if (this.intervalHandle === undefined) return;
    this.clearIntervalImpl(this.intervalHandle);
    this.intervalHandle = undefined;
  }

  /** Builds and emits one heartbeat. Guarded again at the call site (not just `isVisible`'s callers) so a stray fired timer can never emit while hidden. */
  private emitHeartbeat(): void {
    if (!this.isVisible()) return;
    const payload: EventPayload = { session_id: this.sessionId(), visible: true };
    this.emit({ type: 'heartbeat', severity: 'low', payload });
  }
}
