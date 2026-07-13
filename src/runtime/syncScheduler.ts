/**
 * Sync triggers (`docs/02` §2.4, `web-sdk-workflow.md` Phase 4): the four
 * events that cause the durable queue to drain — batch-size reached, a time
 * window, the browser coming back `online`, and the tab going hidden (the
 * unload-safe beacon path, `docs/02` §2.4). Each trigger only *schedules*
 * work (`runWhenIdle`); the actual drain logic lives in the caller
 * (`runtime/client.ts`), so this module knows nothing about the
 * queue/transport — only when to ask.
 */
import { runWhenIdle, type CancelIdle } from './idle.js';

type WindowLike = Pick<Window, 'addEventListener' | 'removeEventListener'>;
type DocumentLike = Pick<Document, 'addEventListener' | 'removeEventListener'> & { readonly visibilityState: string };

/** An opaque interval handle — deliberately not `typeof setInterval`'s own (overloaded, DOM-vs-Node) return type. */
type IntervalHandle = ReturnType<typeof setInterval>;

export interface SyncSchedulerOptions {
  /** Queue depth that immediately schedules a steady-state drain. */
  batchSizeThreshold: number;
  /** How often the time-window trigger fires, in ms. */
  intervalMs: number;
  /** Reads the current queue depth; consulted only by the batch-size trigger. */
  getQueueSize: () => Promise<number>;
  /** Steady-state drain: batch-size, time-window, and `online` triggers. */
  onSteadyStateSync: () => void;
  /** Unload-safe drain: `visibilitychange` → hidden (`docs/02` §2.4). */
  onUnloadSync: () => void;
  /** Injectable globals for tests; default to the real browser ones (`undefined` outside a browser). */
  win?: WindowLike;
  doc?: DocumentLike;
  /** Narrowed to exactly the shape this module calls — see the note above `defaultSetInterval`. */
  setIntervalImpl?: (callback: () => void, intervalMs: number) => IntervalHandle;
  clearIntervalImpl?: (handle: IntervalHandle) => void;
}

function resolveDefaultWindow(): WindowLike | undefined {
  return typeof window !== 'undefined' ? window : undefined;
}

function resolveDefaultDocument(): DocumentLike | undefined {
  return typeof document !== 'undefined' ? document : undefined;
}

// `setInterval`/`clearInterval` are WebIDL platform methods: real browsers
// (unlike jsdom) throw `TypeError: Illegal invocation` if the bare function
// reference is extracted and later called detached from its `window`
// receiver — exactly what storing `setInterval` itself in a field and
// calling `this.setIntervalImpl(...)` would do. Calling through an
// unqualified identifier inside a plain wrapper function avoids that: it
// resolves via the global object at call time instead of a detached
// reference, so it works in every host, the same reason `idle.ts` calls
// `idleGlobal.requestIdleCallback(...)` as a qualified method rather than
// hoisting it out. The signature is also deliberately narrowed to just what
// this module calls, rather than `typeof setInterval`'s own overloaded
// (DOM `TimerHandler` vs Node `Timeout`) type.
function defaultSetInterval(callback: () => void, intervalMs: number): IntervalHandle {
  return setInterval(callback, intervalMs);
}

function defaultClearInterval(handle: IntervalHandle): void {
  clearInterval(handle);
}

/**
 * Wires the four sync triggers to the two drain callbacks the caller
 * supplies. `start()` attaches listeners/timers; `stop()` tears them all
 * down (idempotent) — the teardown a future `setEnabled(false)` and every
 * test need.
 */
export class SyncScheduler {
  private readonly options: SyncSchedulerOptions;
  private readonly win: WindowLike | undefined;
  private readonly doc: DocumentLike | undefined;
  private readonly setIntervalImpl: (callback: () => void, intervalMs: number) => IntervalHandle;
  private readonly clearIntervalImpl: (handle: IntervalHandle) => void;

  private intervalHandle: IntervalHandle | undefined;
  private cancelIdleBatchCheck: CancelIdle | undefined;
  private started = false;

  private readonly handleOnline = (): void => this.scheduleSteadyStateSync();
  private readonly handleVisibilityChange = (): void => {
    if (this.doc?.visibilityState === 'hidden') this.options.onUnloadSync();
  };

  constructor(options: SyncSchedulerOptions) {
    this.options = options;
    this.win = options.win ?? resolveDefaultWindow();
    this.doc = options.doc ?? resolveDefaultDocument();
    this.setIntervalImpl = options.setIntervalImpl ?? defaultSetInterval;
    this.clearIntervalImpl = options.clearIntervalImpl ?? defaultClearInterval;
  }

  /** Attaches the `online`/`visibilitychange` listeners and starts the time-window timer. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;

    this.win?.addEventListener('online', this.handleOnline);
    this.doc?.addEventListener('visibilitychange', this.handleVisibilityChange);
    this.intervalHandle = this.setIntervalImpl(() => this.scheduleSteadyStateSync(), this.options.intervalMs);
  }

  /** Detaches every listener/timer this scheduler owns. Idempotent; safe even if `start()` was never called. */
  stop(): void {
    if (!this.started) return;
    this.started = false;

    this.win?.removeEventListener('online', this.handleOnline);
    this.doc?.removeEventListener('visibilitychange', this.handleVisibilityChange);
    if (this.intervalHandle !== undefined) this.clearIntervalImpl(this.intervalHandle);
    this.cancelIdleBatchCheck?.();
    this.cancelIdleBatchCheck = undefined;
  }

  /** Call after every enqueue; schedules a steady-state drain once the queue reaches `batchSizeThreshold`. */
  notifyEnqueued(): void {
    this.cancelIdleBatchCheck?.();
    this.cancelIdleBatchCheck = runWhenIdle(() => {
      void this.checkBatchSize();
    });
  }

  private async checkBatchSize(): Promise<void> {
    const size = await this.options.getQueueSize();
    if (size >= this.options.batchSizeThreshold) this.scheduleSteadyStateSync();
  }

  private scheduleSteadyStateSync(): void {
    runWhenIdle(() => this.options.onSteadyStateSync());
  }
}
