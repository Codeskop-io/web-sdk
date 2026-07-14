/**
 * The public facade (`docs/05-api-reference.md`, Phase 10's finalization):
 * `init`, `identify`/`reset`, `recordException` (re-exported as-is from
 * `capture/errors.ts`), `setEnabled`, and `flush` — the complete public
 * surface `src/index.ts` re-exports. Every entrypoint here shares the same
 * two guarantees (`docs/05` §5.4): it is wrapped in `safely()` so it can
 * never throw into the host page, and it is a safe no-op before `init()` —
 * `getActiveClient()` is `undefined` until then, and every call below treats
 * that the same way the capture modules already do.
 *
 * This module also runs the lightweight auto-init (`docs/06` §6.5): if the
 * SDK's own `<script>` tag carries a `data-codeskop-key` attribute, `init`
 * is called automatically with the attributes found there as soon as this
 * module is evaluated. A later explicit `init()` call always wins — it
 * disposes whatever client is currently active (auto-started or not) and
 * starts a fresh one.
 */
import type { CodeskopConfig } from './model/types.js';
import { safely } from './core/safely.js';
import { validateApiKey } from './core/identity.js';
import { readScriptConfig } from './core/scriptConfig.js';
import { CodeskopClient, getActiveClient, setActiveClient } from './runtime/client.js';

/**
 * Initializes the SDK. Returns immediately — key validation is synchronous
 * and cheap, and every queue/network/config operation is deferred
 * (`docs/05` §5.4). Safe to call more than once: each call disposes the
 * previously active client (if any) and starts a fresh one. A non-public key
 * (`cs_*_sk_…` or malformed) disables the SDK fail-soft (`docs/04` §4.2)
 * rather than throwing.
 *
 * The previously active client is disposed *before* the new one is
 * constructed, never after: `CodeskopClient` now owns real `NetworkCapture`/
 * `ErrorCapture` instances that monkey-patch `window.fetch`/`XMLHttpRequest`,
 * saving a single "original" to restore on `stop()`. Constructing a new
 * client while the old one is still active would patch on top of the old
 * client's patch; disposing the old client *afterwards* would then restore
 * to what *it* remembers as original, silently unwinding the new client's
 * patch too and leaving network capture dark until the next `init()`.
 * Disposing first means every `start()` always patches a pristine global.
 */
export const init = safely((config: CodeskopConfig): void => {
  const validation = validateApiKey(config.apiKey);
  setActiveClient(undefined);
  if (!validation.valid) {
    // Fail-soft: no active client means every future capture-module call
    // into `getActiveClient()` is a safe no-op (`docs/05` §5.4).
    return;
  }
  setActiveClient(new CodeskopClient(config));
}, { context: 'init' });

/**
 * Runs once, at module evaluation time: attempts auto-init from the SDK's
 * own `<script data-codeskop-key>` tag, if present (`docs/06` §6.5). A no-op
 * in every other host — no matching attribute, or no `document` at all
 * (SSR, a bundled app that calls `init` itself).
 */
const autoInit = safely((): void => {
  const scriptConfig = readScriptConfig();
  if (!scriptConfig?.apiKey) return;
  init(scriptConfig as CodeskopConfig);
}, { context: 'auto-init' });

autoInit();

/**
 * Associates subsequent events with a stable logical user (`docs/05` §5.3).
 * A safe no-op before `init()` — there is no active client to delegate to
 * yet, so there is nothing to identify.
 */
export const identify = safely((userId: string, traits?: Record<string, unknown>): void => {
  getActiveClient()?.identify(userId, traits);
}, { context: 'identify' });

/**
 * Clears the current user (`docs/05` §5.3), e.g. on logout. The install ID
 * persists. A safe no-op before `init()`.
 */
export const reset = safely((): void => {
  getActiveClient()?.reset();
}, { context: 'reset' });

/**
 * Local pause/resume of capture (`docs/05` §5.3), independent of the remote
 * kill-switch (`config/featureGate.ts`, Phase 8): either being "off" disables
 * capture. A safe no-op before `init()` — there is no active client to pause
 * or resume yet, so the call is simply dropped (the *next* `init()` always
 * starts a fresh client back at fully enabled, not whatever `setEnabled` was
 * last called with).
 */
export const setEnabled = safely((enabled: boolean): void => {
  getActiveClient()?.setEnabled(enabled);
}, { context: 'setEnabled' });

/** The `safely()`-guarded core of `flush()`; kept separate so the exported function can normalize `undefined` (no active client, or a swallowed fault) down to `false` and keep its documented `Promise<boolean>` signature exact rather than `Promise<boolean | undefined>`. */
const guardedFlush = safely(async (): Promise<boolean> => {
  const client = getActiveClient();
  if (!client) return false;
  return client.flush();
}, { context: 'flush' });

/**
 * Best-effort expedited drain of the queue (`docs/05` §5.3). Resolves `true`
 * only if a sync attempt actually ran — `false` before `init()`, if one was
 * already in flight, or if the guard swallowed an unexpected fault. Never
 * throws and never rejects.
 */
export function flush(): Promise<boolean> {
  return guardedFlush().then((result) => result ?? false);
}
