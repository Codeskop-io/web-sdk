/**
 * The `<script>`-tag build (`dist/codeskop.min.js`, served by jsDelivr/unpkg
 * from the npm package) for sites without a bundler: server-rendered apps
 * (Django, Rails, Laravel, ASP.NET), WordPress, Webflow, Shopify, jQuery.
 *
 *   <script src="https://cdn.jsdelivr.net/npm/@codeskop/tracker@1/dist/codeskop.min.js"
 *           data-codeskop-key="cs_live_pk_…"></script>
 *
 * Importing the facade runs the script-tag auto-init (`facade.ts`). This
 * entry then publishes the API as `window.Codeskop` and replays any calls the
 * page queued on the loader stub before the script arrived (`Codeskop.q`, see
 * the async snippet in the docs), so inline scripts can call
 * `Codeskop.identify(…)` without waiting for the SDK.
 */
import { flush, identify, init, recordException, reset, screen, setEnabled, track } from './index.js';
import { SDK_VERSION } from './core/version.js';
import { safely } from './core/safely.js';

type QueuedCall = [string, unknown[]];

export interface CodeskopGlobal {
  init: typeof init;
  identify: typeof identify;
  track: typeof track;
  screen: typeof screen;
  recordException: typeof recordException;
  reset: typeof reset;
  setEnabled: typeof setEnabled;
  flush: typeof flush;
  version: string;
}

const api: CodeskopGlobal = { init, identify, track, screen, recordException, reset, setEnabled, flush, version: SDK_VERSION };

export const installGlobal = safely((): void => {
  if (typeof window === 'undefined') return;
  const host = window as unknown as { Codeskop?: CodeskopGlobal | { q?: unknown } };
  const queued = (host.Codeskop as { q?: unknown } | undefined)?.q;
  host.Codeskop = api;
  if (!Array.isArray(queued)) return;
  for (const call of queued as QueuedCall[]) {
    if (!Array.isArray(call)) continue;
    const [method, args] = call;
    const fn = (api as unknown as Record<string, unknown>)[method];
    if (typeof fn === 'function' && method !== 'version') (fn as (...a: unknown[]) => unknown)(...(Array.isArray(args) ? args : []));
  }
}, { context: 'install-global' });

installGlobal();
