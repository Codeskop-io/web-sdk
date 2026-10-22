/**
 * `CodeskopClient` — wires the durable queue, transport, remote config,
 * identity, and capture modules into one guarded runtime (`docs/02`
 * §2.1/§2.3, `web-sdk-workflow.md` Phases 4/6/7/9). `emitEvent` is the single
 * seam every capture module (network, error, heartbeat) enqueues an event
 * through; the client owns constructing/`start()`ing those three modules
 * against that same seam and `stop()`ping them in `dispose`, so exactly one
 * live set of patches/listeners/timers exists per active client — mirrors
 * `setActiveClient`'s "dispose the old one first" guarantee. Nothing else
 * here is meant to be called from outside the runtime and `facade.ts`.
 */
import type {
  AnalyticsPayload,
  CodeskopConfig,
  CodeskopEvent,
  ConfigSource,
  EventPayload,
  EventType,
  Properties,
  QueueLike,
  Severity,
  TrackCategory,
  TrackOptions,
  Transport,
  UserRef,
} from '../model/types.js';
import { safely, type DiagnosticHandler } from '../core/safely.js';
import { Sampler } from '../core/sampling.js';
import { ClientStateMachine } from '../core/state.js';
import { generateEventId, systemClock } from '../core/id.js';
import { IdentityManager } from '../core/identity.js';
import { collectContext, collectPage, collectReferrer } from '../core/context.js';
import { resolveAnonymousId, resolveInstallId } from '../core/installId.js';
import { resolveDefaultStorage } from '../config/cache.js';
import { DurableQueue } from '../queue/index.js';
import { BeaconTransport, buildBatches, FetchTransport, type BuildBatchesContext } from '../transport/index.js';
import { FeatureGate, RemoteConfigClient } from '../config/index.js';
import { ErrorCapture } from '../capture/errors.js';
import { HeartbeatCapture } from '../capture/heartbeat.js';
import { PageViewCapture } from '../capture/pageviews.js';
import { SESSION_TIMEOUT_MS, SessionManager, type SessionState } from '../core/session.js';
import { deepLink, lifecycleCapture, loadMs, pageLoad, whenLoaded } from '../capture/lifecycle.js';
import { NetworkCapture } from '../capture/network.js';
import { SyncScheduler } from './syncScheduler.js';

/** The `start()`/`stop()` shape shared by every capture module — enough surface for this client to own their lifecycle and for tests to inject a fake. */
interface StartStoppable {
  start(): void;
  stop(): void;
}

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
  /** When it happened (ms since the epoch); defaults to now. */
  at?: number;
  /** Never sampled out (SDK lifecycle events). */
  always?: boolean;
  /** Queue the event only once this settles, so a field can be filled in first (`load_ms`). Its `seq` is taken now. */
  wait?: Promise<unknown>;
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
  /** Overrides the real `NetworkCapture` this client would otherwise construct (`CodeskopConfig.captureNetwork` permitting). */
  networkCapture?: StartStoppable;
  /** Overrides the real `ErrorCapture` this client would otherwise construct (`CodeskopConfig.captureErrors` permitting). */
  errorCapture?: StartStoppable;
  /** Overrides the real `HeartbeatCapture` this client would otherwise construct. */
  heartbeatCapture?: StartStoppable;
  /** Overrides the real `PageViewCapture` (`CodeskopConfig.capturePageViews` permitting). */
  pageViewCapture?: StartStoppable;
  /** Overrides the session manager (tests). */
  sessions?: SessionManager;
  /** Overrides the real `LifecycleCapture` (visibility, tab close, clicks). */
  lifecycleCapture?: StartStoppable;
}

// Moved to `core/properties.ts` so capture modules can use it without the client; re-exported for compatibility.
export { cleanProperties } from '../core/properties.js';
import { cleanProperties } from '../core/properties.js';

/** Event types the remote `features.network` flag gates. */
const NETWORK_EVENT_TYPES: ReadonlySet<string> = new Set(['api_timing', 'api_error']);

/** The categories `track` accepts (`backend/docs/11` §11.2). */
const CATEGORIES: readonly string[] = ['lifecycle', 'navigation', 'interaction', 'identity', 'conversion'];
/** The last anonymous id / user pair an `identify` event linked, so a page load doesn't relink every time. */
const LINK_KEY = 'codeskop:linked:v1';

/** A usable event name: trimmed, at most 128 characters, and not a reserved `$` name. */
function eventName(name: unknown): string {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  return trimmed[0] === '$' ? '' : trimmed.slice(0, 128);
}

/** An SDK lifecycle event (`$session_started`, …): category `lifecycle`, never sampled. */
function lifecycleInput(name: string, properties: Properties, at?: number): EmitEventInput {
  return { type: 'track', severity: 'low', always: true, at, payload: { name, properties, session_id: '', category: 'lifecycle' } };
}

/** Stamps the current page onto a payload that doesn't already carry one. */
function withPage(payload: EventPayload): EventPayload {
  if ('page' in payload && payload.page) return payload;
  const page = collectPage();
  return page ? { ...payload, page } : payload;
}

export class CodeskopClient {
  /** `CodeskopConfig.captureExceptionMessages`: read by `capture/errors.ts` when it builds a payload. */
  readonly captureExceptionMessages: boolean;
  private readonly onDiagnostic: DiagnosticHandler;
  private readonly state = new ClientStateMachine();
  private readonly featureGate = new FeatureGate();
  private readonly sessions: SessionManager;
  private readonly pageViewCapture: StartStoppable | undefined;
  /** The in-code `sampleRates`, used until the first remote config arrives. */
  private readonly localSampleRates: Record<string, number>;
  private remoteConfigLoaded = false;
  private readonly random: () => number = Math.random;
  private readonly identity: IdentityManager;
  private readonly queue: QueueLike;
  private readonly fetchTransport: Transport;
  private readonly beaconTransport: Transport;
  private readonly configSource: ConfigSource;
  private readonly scheduler: SyncScheduler;
  private readonly batchContext: BuildBatchesContext;
  private readonly networkCapture: StartStoppable | undefined;
  private readonly errorCapture: StartStoppable | undefined;
  private readonly heartbeatCapture: StartStoppable;
  private readonly lifecycleCapture: StartStoppable;
  private anonymousId: string;
  /** `$session_started`'s launch type: this page load's for the first session, `warm` after. */
  private launch: 'cold' | 'warm';
  private draining = false;
  /**
   * The `setEnabled()` local pause/resume (`docs/05` §5.3), deliberately kept
   * separate from `ClientStateMachine`'s `enabled`/`disabled` states: those
   * model the remote kill-switch and terminal `killed` faults
   * (`core/state.ts`), and re-`tryTransition('enabled')`-ing out of a
   * kill-switch trip would be a bug, not a feature. This flag is a second,
   * independent gate `emitEvent` checks alongside the state machine — either
   * being "off" disables capture, and each can be flipped without touching
   * the other.
   */
  private localEnabled = true;

  constructor(config: CodeskopConfig, options: CodeskopClientOptions = {}) {
    this.onDiagnostic = options.onDiagnostic ?? (() => {});
    this.captureExceptionMessages = config.captureExceptionMessages === true;
    this.localSampleRates = config.sampleRates ?? {};

    const installId = options.installId ?? resolveInstallId();
    this.anonymousId = resolveAnonymousId();
    this.identity = new IdentityManager(() => this.anonymousId);

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

    // `emitEvent`'s field initializer has already run by this point (base-class
    // field initializers run before the constructor body), so it's safe to hand
    // this bound seam to the capture modules constructed here.
    this.networkCapture =
      config.captureNetwork === false
        ? undefined
        : options.networkCapture ??
          new NetworkCapture({ endpoint, redactHeaderNames: config.redactHeaders, emit: this.emitEvent });
    this.errorCapture = config.captureErrors === false ? undefined : options.errorCapture ?? new ErrorCapture();
    this.sessions = options.sessions ?? new SessionManager();
    this.launch = this.sessions.existed ? 'warm' : 'cold';
    // `emitEvent` replaces the heartbeat's own session id with the current one.
    this.heartbeatCapture = options.heartbeatCapture ?? new HeartbeatCapture({ emit: this.emitEvent });
    this.lifecycleCapture =
      options.lifecycleCapture ??
      lifecycleCapture({
        lifecycle: (name, properties) => this.lifecycle(name, properties),
        close: () => this.close(),
        click:
          config.autocapture?.clicks === false
            ? undefined
            : (properties) => {
                // Only where the remote config allows it (plan with analytics, project setting on).
                if (this.featureGate.current.autocapture?.clicks === true) {
                  this.analytics('track', '$click', properties, 'interaction');
                }
              },
      });
    this.pageViewCapture =
      config.capturePageViews === false
        ? undefined
        : options.pageViewCapture ?? new PageViewCapture({ emit: (path) => this.screen(path) });

    // Freshly constructed: `uninitialized -> enabled` is always legal.
    this.state.tryTransition('enabled');
    // Before the scheduler: its hide/close listeners drain the queue, so the
    // lifecycle events those same browser events produce must be queued first.
    this.lifecycleCapture.start();
    this.appOpened();
    this.scheduler.start();
    this.networkCapture?.start();
    this.errorCapture?.start();
    this.heartbeatCapture.start();
    this.pageViewCapture?.start();
    this.refreshRemoteConfig();
  }

  /** The single seam every capture module enqueues an event through. Never throws; a no-op unless `enabled`. */
  readonly emitEvent = safely(
    (input: EmitEventInput): void => {
      if (!this.isActive()) return;
      // Plan gate: the remote config turns network capture off on plans that
      // don't include it (`features.network: false`), whatever `captureNetwork` says.
      if (NETWORK_EVENT_TYPES.has(input.type) && !this.featureGate.isFeatureEnabled('network')) return;
      // Sampling: the remote config's `sample_rates` replace the in-code
      // `sampleRates` once fetched. Errors and exceptions are always kept.
      if (!input.always && !this.shouldSample(input.type)) return;

      // Every event is activity. After 30 idle minutes the old session ends
      // (`inactive`, dated at its last activity) and a new one starts.
      const roll = this.sessions.touch(input.at);
      if (roll.ended) this.endSession(roll.ended, 'inactive');
      if (roll.started) {
        this.write(lifecycleInput('$session_started', { launch_type: this.launch }), this.sessions.state!);
        this.launch = 'warm';
      }
      this.write(input, this.sessions.state!);
    },
    { context: 'client.emitEvent' },
  );

  /** Builds and queues one event in `session`, taking its next `seq`. */
  private write(input: EmitEventInput, session: SessionState): CodeskopEvent {
    const payload = input.payload as AnalyticsPayload;
    if ('session_id' in payload) payload.session_id = session.id;
    if (input.type === 'screen') {
      if (session.screen && payload.properties.previous_screen === undefined) {
        payload.properties.previous_screen = session.screen;
      }
      session.screen = payload.name;
      session.screens += 1;
    }
    const event: CodeskopEvent = {
      event_id: generateEventId(systemClock),
      type: input.type,
      occurred_at: new Date(input.at ?? systemClock.now()).toISOString(),
      severity: input.severity,
      session_id: session.id,
      seq: session.seq++,
      user: input.user ?? this.identity.currentUserRef(),
      // A batch can span several pages, so a network call records the page it happened on.
      payload: NETWORK_EVENT_TYPES.has(input.type) ? withPage(input.payload) : input.payload,
    };
    this.sessions.save();

    const enqueue = (): void => {
      void this.queue.enqueue(event).then(
        () => this.notifyEnqueuedSafely(),
        (error: unknown) => this.report(error, 'client.emitEvent.enqueue'),
      );
    };
    if (input.wait) void input.wait.then(enqueue, enqueue);
    else enqueue();
    return event;
  }

  /** An SDK lifecycle event: sent on every plan (free), never sampled. */
  private lifecycle(name: string, properties: Properties, wait?: Promise<unknown>): void {
    this.emitEvent({ ...lifecycleInput(name, properties), wait });
  }

  private endSession(session: SessionState, end_reason: string): CodeskopEvent {
    const properties = {
      duration_s: Math.round((session.last - session.start) / 1000),
      screens: session.screens,
      end_reason,
    };
    return this.write(lifecycleInput('$session_ended', properties, session.last), session);
  }

  /** Once per page load: `$app_opened` (with `load_ms` once the page has loaded) and `$deep_link_opened`. */
  private appOpened(): void {
    if (pageLoad.opened || typeof location === 'undefined') return;
    pageLoad.opened = true;
    const properties: Properties = { launch_type: this.launch };
    this.lifecycle(
      '$app_opened',
      properties,
      whenLoaded().then(() => {
        const ms = loadMs();
        if (ms !== undefined) properties.load_ms = ms;
      }),
    );
    const link = safely(() => deepLink(location.href, document.referrer))();
    if (link) this.analytics('track', '$deep_link_opened', link, 'navigation');
  }

  /**
   * The tab is closing: ends the session (`closed`) and sends that event
   * straight away by beacon, as the queue's own unload drain may already
   * have run. It is queued too, in case the beacon fails; the server drops
   * the duplicate by `event_id`.
   */
  private close(): void {
    const session = this.sessions.state;
    if (!this.isActive() || !session || session.closed) return;
    const now = systemClock.now();
    const idle = now - session.last > SESSION_TIMEOUT_MS;
    if (!idle) session.last = now;
    const event = this.endSession(session, idle ? 'inactive' : 'closed');
    session.closed = 1;
    this.sessions.save();
    void safely(async () => {
      const { batches } = await buildBatches([event], this.batchContext);
      for (const batch of batches) {
        if ((await this.beaconTransport.send(batch)).ok) await this.queue.ack([event.event_id]);
      }
    }, { context: 'client.close' })();
  }

  /** Tears down timers/listeners — the scheduler and every started capture module. Exposed for tests and for `facade.ts` replacing this instance on a later `init()`. */
  readonly dispose = safely((): void => {
    this.scheduler.stop();
    this.networkCapture?.stop();
    this.errorCapture?.stop();
    this.heartbeatCapture.stop();
    this.pageViewCapture?.stop();
    this.lifecycleCapture.stop();
  }, { context: 'client.dispose' });

  /** Diagnostics-only: the current durable-queue depth. Not part of the public API (`docs/05`). */
  async queueSize(): Promise<number> {
    return this.queue.size();
  }

  /** Diagnostics-only: `true` while capture is active (`enabled`, not remote-kill-switched, and not locally paused). Not part of the public API. */
  isActive(): boolean {
    return this.localEnabled && this.state.isEnabled() && !this.featureGate.isKillSwitched();
  }

  /**
   * `docs/05` §5.3's `setEnabled`: a local pause/resume independent of the
   * remote kill-switch. Flipping this to `false` makes `emitEvent` a no-op
   * immediately; flipping it back to `true` resumes capture as long as the
   * state machine and feature gate both still allow it. Never touches
   * `ClientStateMachine` — a kill-switch trip stays tripped regardless of
   * this flag, and this flag survives a kill-switch trip too (it's just moot
   * until the trip clears, which it never does short of a fresh client).
   */
  setEnabled(enabled: boolean): void {
    this.localEnabled = enabled;
  }

  /**
   * `identify`: attributes later events to `userId`. With product analytics on,
   * an `identify` event links the anonymous id (what this browser did before
   * login) to the user, and carries the traits so they appear on the user's
   * profile. It is sent when there are traits, or the first time this
   * anonymous id is linked to this user. Use your own id, never emails or
   * phone numbers (Codeskop masks values that look like them).
   */
  identify(userId: string, traits?: Record<string, unknown>): void {
    if (typeof userId !== 'string' || !userId) return;
    this.identity.identify(userId, traits);
    const cleaned = cleanProperties(traits);
    const link = `${this.anonymousId}|${userId}`;
    const storage = resolveDefaultStorage();
    const linked = safely(() => storage?.getItem(LINK_KEY))();
    if ((Object.keys(cleaned).length || linked !== link) && this.analyticsEnabled()) {
      this.emitEvent({ type: 'identify', severity: 'low', payload: { traits: cleaned } });
      safely(() => storage?.setItem(LINK_KEY, link))();
    }
  }

  /**
   * Product analytics: a custom event, e.g. `track('order_completed', { value: 49.99 })`.
   * Names starting with `$` are reserved for the SDK and dropped. An unknown
   * `category` is left out (with a console warning) and the server works one out.
   */
  track(name: string, properties?: Record<string, unknown>, options?: TrackOptions): void {
    const cleanName = eventName(name);
    if (!cleanName) return;
    let category = options?.category;
    if (category !== undefined && !CATEGORIES.includes(category)) {
      if (typeof console !== 'undefined') {
        console.warn(
          `[Codeskop] Unknown track category "${String(category)}" left out. Use one of: ${CATEGORIES.join(', ')}.`,
        );
      }
      category = undefined;
    }
    this.analytics('track', cleanName, cleanProperties(properties), category);
  }

  /**
   * Product analytics: a screen or page view. Page views are captured
   * automatically unless `capturePageViews: false`. Adds `previous_screen`,
   * and on the first screen of a page load the `referrer` (origin and path)
   * and `load_ms`.
   */
  screen(name: string, properties?: Record<string, unknown>): void {
    const cleanName = eventName(name);
    if (!cleanName) return;
    const cleaned = cleanProperties(properties);
    let wait: Promise<unknown> | undefined;
    if (!pageLoad.screened) {
      pageLoad.screened = true;
      const referrer = collectReferrer();
      if (referrer && cleaned.referrer === undefined) cleaned.referrer = referrer;
      wait = whenLoaded().then(() => {
        const ms = loadMs();
        if (ms !== undefined && cleaned.load_ms === undefined) cleaned.load_ms = ms;
      });
    }
    this.analytics('screen', cleanName, cleaned, undefined, wait);
  }

  private analyticsEnabled(): boolean {
    // On unless the plan's remote config turns it off (Free and Starter).
    return this.featureGate.isFeatureEnabled('analytics');
  }

  private analytics(
    type: 'track' | 'screen',
    name: string,
    properties: Properties,
    category?: TrackCategory,
    wait?: Promise<unknown>,
  ): void {
    if (!this.analyticsEnabled()) return;
    const payload: AnalyticsPayload = { name, properties, session_id: '' };
    if (category) payload.category = category;
    this.emitEvent({ type, severity: 'low', payload, wait });
  }

  /** `docs/05` §5.3's `reset`: forgets the user and starts a new anonymous id, so the next person isn't merged into this one. */
  reset(): void {
    this.identity.reset();
    this.anonymousId = resolveAnonymousId({}, true);
  }

  /**
   * `docs/05` §5.3's `flush`: an expedited, best-effort queue drain via the
   * fetch transport (never the beacon transport — that path is reserved for
   * unload). Resolves `true` only if a drain attempt actually ran; `false`
   * when one was already in flight (`this.draining`), so a caller can tell
   * "no new attempt happened" apart from "an attempt happened but found
   * nothing to send or failed". A drain failure is reported as a diagnostic,
   * exactly like the steady-state `drain()` path, and still counts as
   * "a sync attempt actually ran" — `flush()` promises an attempt, not a
   * successful delivery.
   */
  async flush(): Promise<boolean> {
    if (this.draining) return false;
    this.draining = true;
    try {
      await this.drainOnce(this.fetchTransport);
      return true;
    } catch (error) {
      this.report(error, 'client.flush');
      return true;
    } finally {
      this.draining = false;
    }
  }

  private notifyEnqueuedSafely(): void {
    try {
      this.scheduler.notifyEnqueued();
    } catch (error) {
      this.report(error, 'client.notifyEnqueued');
    }
  }

  private shouldSample(type: EventType): boolean {
    const rate = this.remoteConfigLoaded
      ? this.featureGate.sampleRate(type, 1)
      : (this.localSampleRates[type] ?? 1);
    return new Sampler({ sampleRates: { [type]: rate }, random: this.random }).shouldSample(type);
  }

  private refreshRemoteConfig(): void {
    void safely(
      async () => {
        const remoteConfig = await this.configSource.fetchConfig();
        this.featureGate.update(remoteConfig);
        this.remoteConfigLoaded = true;
        this.queue.setMaxQueueMb?.(this.featureGate.maxQueueMb());
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
