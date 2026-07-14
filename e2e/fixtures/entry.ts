/**
 * The e2e test-harness entry point (`web-sdk-workflow.md` Phase 4): bundled
 * with esbuild (`e2e/fixtures/env.ts`) into a single browser script that
 * exposes just enough of the SDK's internals on `window.__codeskop_test__`
 * for Playwright to drive a real Chromium page against the real mock ingest
 * server. Not part of the published package — this file only exists under
 * `e2e/`.
 */
import { flush, identify, init, recordException, reset, setEnabled } from '../../src/index.js';
import { getActiveClient } from '../../src/runtime/client.js';
import type { CodeskopConfig, Severity } from '../../src/model/types.js';

export interface CodeskopTestHarness {
  init: (config: CodeskopConfig) => void;
  /** Feeds one `heartbeat` event through the exact seam future capture modules will use. */
  emit: (severity: Severity) => void;
  /** The durable queue's current depth — proves an event survived (or didn't survive) a reload. */
  queueSize: () => Promise<number>;
  /** The full public facade (`docs/05-api-reference.md`), finalized in Phase 10, for the e2e pipeline suite. */
  identify: (userId: string, traits?: Record<string, unknown>) => void;
  reset: () => void;
  recordException: (error: unknown, attributes?: Record<string, unknown>) => void;
  setEnabled: (enabled: boolean) => void;
  flush: () => Promise<boolean>;
  /** Fires a genuine resource-load failure (a broken `<img>`) whose `target.tagName` getter has been overridden to throw — the Phase 10 stability pass's "test double" fault, injected into a real `ErrorCapture` hook rather than simulated. */
  triggerFaultyResourceError: () => void;
}

const harness: CodeskopTestHarness = {
  init,
  emit: (severity) => {
    getActiveClient()?.emitEvent({
      type: 'heartbeat',
      severity,
      payload: { session_id: 'e2e-session', visible: true },
    });
  },
  queueSize: async () => {
    const client = getActiveClient();
    return client ? client.queueSize() : 0;
  },
  identify,
  reset,
  recordException,
  setEnabled,
  flush,
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
