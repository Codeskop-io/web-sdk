/**
 * The e2e test-harness entry point (`web-sdk-workflow.md` Phase 4): bundled
 * with esbuild (`e2e/fixtures/env.ts`) into a single browser script that
 * exposes just enough of the SDK's internals on `window.__codeskop_test__`
 * for Playwright to drive a real Chromium page against the real mock ingest
 * server. Not part of the published package — this file only exists under
 * `e2e/`.
 */
import { init } from '../../src/index.js';
import { getActiveClient } from '../../src/runtime/client.js';
import type { CodeskopConfig, Severity } from '../../src/model/types.js';

export interface CodeskopTestHarness {
  init: (config: CodeskopConfig) => void;
  /** Feeds one `heartbeat` event through the exact seam future capture modules will use. */
  emit: (severity: Severity) => void;
  /** The durable queue's current depth — proves an event survived (or didn't survive) a reload. */
  queueSize: () => Promise<number>;
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
};

(window as unknown as { __codeskop_test__: CodeskopTestHarness }).__codeskop_test__ = harness;
