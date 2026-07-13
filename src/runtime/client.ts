/**
 * `CodeskopClient` — wires the durable queue, transport, remote config, and
 * identity modules into one guarded runtime (`docs/02` §2.1/§2.3,
 * `web-sdk-workflow.md` Phase 4). `emitEvent` is the single seam every future
 * capture module (network, error, heartbeat — Phases 6/7/9) enqueues an
 * event through; nothing else here is meant to be called from outside the
 * runtime and `facade.ts`.
 */
import type {
  CodeskopConfig,
  CodeskopEvent,
  ConfigSource,
  EventPayload,
  EventType,
  QueueLike,
  Severity,
  Transport,
  UserRef,
} from '../model/types.js';
import { safely, type DiagnosticHandler } from '../core/safely.js';
import { ClientStateMachine } from '../core/state.js';
import { generateEventId, systemClock } from '../core/id.js';
import { IdentityManager } from '../core/identity.js';
import { collectContext } from '../core/context.js';
import { resolveInstallId } from '../core/installId.js';
import { DurableQueue } from '../queue/index.js';
import { BeaconTransport, buildBatches, FetchTransport, type BuildBatchesContext } from '../transport/index.js';
import { FeatureGate, RemoteConfigClient } from '../config/index.js';
import { SyncScheduler } from './syncScheduler.js';

const DEFAULT_ENDPOINT = 'https://api.codeskop.com';

/** Queue depth that immediately schedules a steady-state drain (`web-sdk-workflow.md` Phase 4). */
export const BATCH_SIZE_TRIGGER = 20;
/** How often the time-window sync trigger fires. */
const SYNC_INTERVAL_MS = 30_000;
/** Upper bound on events pulled off the queue per drain; mirrors the wire contract's per-batch cap (`docs/03` §3.2). */
const DRAIN_MAX_EVENTS = 100;

/**
 * Input to `CodeskopClient.emitEvent` — the one seam capture modules build
 * an event through. The client fills in `event_id`, `occurred_at`, and
 * (unless overridden) the current user attribution; callers only ever
 * supply what's specific to the signal they captured.
 */
export interface EmitEventInput {
  type: EventType;
  severity: Severity;
  payload: EventPayload;
  /** Overrides the current identity for this one event; defaults to `IdentityManager.currentUserRef()`. */
  user?: UserRef;
}

/** Test/DI seams — every collaborator `CodeskopClient` would otherwise construct itself. */
export interface CodeskopClientOptions {
  onDiagnostic?: DiagnosticHandler;
  queue?: QueueLike;
  fetchTransport?: Transport;
  beaconTransport?: Transport;
  configSource?: ConfigSource;
  scheduler?: SyncScheduler;
  installId?: string;
}

export class CodeskopClient {
  private readonly onDiagnostic: DiagnosticHandler;
  private readonly state = new ClientStateMachine();
  private readonly featureGate = new FeatureGate();
  private readonly identity: IdentityManager;
  private readonly queue: QueueLike;
  private readonly fetchTransport: Transport;
  private readonly beaconTransport: Transport;
  private readonly configSource: ConfigSource;
  private readonly scheduler: SyncScheduler;
  private readonly batchContext: BuildBatchesContext;
  private draining = false;

  constructor(config: CodeskopConfig, options: CodeskopClientOptions = {}) {
    this.onDiagnostic = options.onDiagnostic ?? (() => {});

    const installId = options.installId ?? resolveInstallId();
    this.identity = new IdentityManager(() => installId);

    const endpoint = config.endpoint ?? DEFAULT_ENDPOINT;
    this.queue =
      options.queue ??
      new DurableQueue({
        maxQueueMb: config.maxQueueMb,
        onError: (error, context) => this.report(error, context),
      });
    this.fetchTransport = options.fetchTransport ?? new FetchTransport({ endpoint, apiKey: config.apiKey });
    this.beaconTransport = options.beaconTransport ?? new BeaconTransport({ endpoint, apiKey: config.apiKey });
    this.configSource =
      options.configSource ??
      new RemoteConfigClient({
        endpoint,
        apiKey: config.apiKey,
        onError: (error, context) => this.report(error, context),
      });

    const collected = collectContext(config, installId);
    this.batchContext = { device: collected.device, app: collected.app };

    this.scheduler =
      options.scheduler ??
      new SyncScheduler({
        batchSizeThreshold: BATCH_SIZE_TRIGGER,
        intervalMs: SYNC_INTERVAL_MS,
        getQueueSize: () => this.queue.size(),
        onSteadyStateSync: () => {
          void this.drain(this.fetchTransport);
        },
        onUnloadSync: () => {
          void this.drain(this.beaconTransport);
        },
      });

    // Freshly constructed: `uninitialized -> enabled` is always legal.
    this.state.tryTransition('enabled');
    this.scheduler.start();
    this.refreshRemoteConfig();
  }

  /** The single seam every capture module enqueues an event through. Never throws; a no-op unless `enabled`. */
  readonly emitEvent = safely(
    (input: EmitEventInput): void => {
      if (!this.state.isEnabled() || this.featureGate.isKillSwitched()) return;

      const event: CodeskopEvent = {
        event_id: generateEventId(systemClock),
        type: input.type,
        occurred_at: new Date(systemClock.now()).toISOString(),
        severity: input.severity,
        user: input.user ?? this.identity.currentUserRef(),
        payload: input.payload,
      };

      void this.queue.enqueue(event).then(
        () => this.notifyEnqueuedSafely(),
        (error: unknown) => this.report(error, 'client.emitEvent.enqueue'),
      );
    },
    { context: 'client.emitEvent' },
  );

  /** Tears down timers/listeners. Exposed for tests and for `facade.ts` replacing this instance on a later `init()`. */
  readonly dispose = safely((): void => {
    this.scheduler.stop();
  }, { context: 'client.dispose' });

  /** Diagnostics-only: the current durable-queue depth. Not part of the public API (`docs/05`). */
  async queueSize(): Promise<number> {
    return this.queue.size();
  }

  /** Diagnostics-only: `true` while capture is active (`enabled` and not remote-kill-switched). Not part of the public API. */
  isActive(): boolean {
    return this.state.isEnabled() && !this.featureGate.isKillSwitched();
  }

  private notifyEnqueuedSafely(): void {
    try {
      this.scheduler.notifyEnqueued();
    } catch (error) {
      this.report(error, 'client.notifyEnqueued');
    }
  }

  private refreshRemoteConfig(): void {
    void safely(
      async () => {
        const remoteConfig = await this.configSource.fetchConfig();
        this.featureGate.update(remoteConfig);
        if (this.featureGate.isKillSwitched()) {
          this.state.tryTransition('disabled');
        }
      },
      { context: 'client.refreshRemoteConfig' },
    )();
  }

  private async drain(transport: Transport): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      await this.drainOnce(transport);
    } catch (error) {
      this.report(error, 'client.drain');
    } finally {
      this.draining = false;
    }
  }

  private async drainOnce(transport: Transport): Promise<void> {
    const pending = await this.queue.peekBatch(DRAIN_MAX_EVENTS);
    if (pending.length === 0) return;

    const { batches, droppedOversized } = await buildBatches(pending, this.batchContext);
    if (droppedOversized.length > 0) await this.queue.ack(droppedOversized);

    for (const batch of batches) {
      const result = await transport.send(batch);
      // `2xx` (deliver) and a permanent `4xx` (can never succeed) both drop
      // the batch; only a retryable `5xx`/network failure leaves it queued.
      if (!result.retryable) {
        await this.queue.ack(batch.batch.map((event) => event.event_id));
      }
    }
  }

  private report(error: unknown, context?: string): void {
    try {
      this.onDiagnostic(error, context);
    } catch {
      // A broken diagnostic handler must never itself throw into the runtime.
    }
  }
}

let activeClient: CodeskopClient | undefined;

/**
 * Swaps in the currently-active client (called by `facade.ts`'s `init`).
 * Disposes whatever client was previously active first, so a second `init()`
 * call — explicit or auto — always leaves exactly one live set of
 * listeners/timers.
 */
export function setActiveClient(client: CodeskopClient | undefined): void {
  activeClient?.dispose();
  activeClient = client;
}

/**
 * The read side of the same seam: every future capture module (network,
 * error, heartbeat) resolves the active client through this and calls
 * `emitEvent` on it. `undefined` before `init()` — callers must treat that
 * as a safe no-op (`docs/05` §5.4), never throw.
 */
export function getActiveClient(): CodeskopClient | undefined {
  return activeClient;
}
