/**
 * The e2e test-harness entry point (`web-sdk-workflow.md` Phase 4): bundled
 * with esbuild (`e2e/fixtures/env.ts`) into a single browser script that
 * exposes just enough of the SDK's internals on `window.__codeskop_test__`
 * for Playwright to drive a real Chromium page against the real mock ingest
 * server. Not part of the published package — this file only exists under
 * `e2e/`.
 */
import { flush, identify, init, recordException, reset, screen, setEnabled, track } from '../../src/index.js';
import { getActiveClient } from '../../src/runtime/client.js';
import { isAppEvent } from './appEvents.js';
import type { CodeskopConfig, CodeskopEvent, QueueLike, Severity, TrackOptions } from '../../src/model/types.js';

export interface CodeskopTestHarness {
  init: (config: CodeskopConfig) => void;
  /** Feeds one `heartbeat` event through the exact seam future capture modules will use. */
  emit: (severity: Severity) => void;
  /**
   * How many of the app's own events are queued: proves an event survived (or
   * didn't survive) a reload. Leaves out what the SDK adds by itself (`$`
   * lifecycle events, and the trait-less `identify` that links the anonymous id).
   */
  queueSize: () => Promise<number>;
  /** Everything queued, the SDK's own events included. */
  queuedEvents: () => Promise<CodeskopEvent[]>;
  /** The full public facade (`docs/05-api-reference.md`), finalized in Phase 10, for the e2e pipeline suite. */
  identify: (userId: string, traits?: Record<string, unknown>) => void;
  reset: () => void;
  recordException: (error: unknown, attributes?: Record<string, unknown>) => void;
  setEnabled: (enabled: boolean) => void;
  flush: () => Promise<boolean>;
  track: (name: string, properties?: Record<string, unknown>, options?: TrackOptions) => void;
  screen: (name: string, properties?: Record<string, unknown>) => void;
  /** Fires a genuine resource-load failure (a broken `<img>`) whose `target.tagName` getter has been overridden to throw — the Phase 10 stability pass's "test double" fault, injected into a real `ErrorCapture` hook rather than simulated. */
  triggerFaultyResourceError: () => void;
}

async function queuedEvents(): Promise<CodeskopEvent[]> {
  const client = getActiveClient() as unknown as { queue: QueueLike } | undefined;
  return client ? client.queue.peekBatch(10_000) : [];
}

const harness: CodeskopTestHarness = {
  // Page views are off unless a suite asks for them: they'd add a `screen` event to every queue.
  init: (config) => init({ capturePageViews: false, ...config }),
  emit: (severity) => {
    getActiveClient()?.emitEvent({
      type: 'heartbeat',
      severity,
      payload: { session_id: 'e2e-session', visible: true },
    });
  },
  queueSize: async () => (await queuedEvents()).filter(isAppEvent).length,
  queuedEvents,
  identify,
  reset,
  recordException,
  setEnabled,
  flush,
  track,
  screen,
  triggerFaultyResourceError: () => {
    const img = document.createElement('img');
    // Shadows the inherited `Element.prototype.tagName` getter on this one
    // instance only — `capture/errors.ts`'s `resourceErrorPayload` reads
    // `target.tagName` while building the event, so this throws *inside*
    // that real hook the moment the `error` event fires, without touching
    // any other element on the page.
    Object.defineProperty(img, 'tagName', {
      get(): string {
        throw new Error('injected fault: tagName getter');
      },
    });
    img.src = '/no-such-image-e2e.png';
    document.body.appendChild(img);
  },
};

(window as unknown as { __codeskop_test__: CodeskopTestHarness }).__codeskop_test__ = harness;
