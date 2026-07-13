/**
 * The public facade (`docs/05-api-reference.md` §5.1): `init` is the only
 * method this phase exposes. `identify`/`reset`/`recordException`/
 * `setEnabled`/`flush` land once the capture modules that need them exist
 * (`web-sdk-workflow.md` Phase 5+).
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
import { CodeskopClient, setActiveClient } from './runtime/client.js';

/**
 * Initializes the SDK. Returns immediately — key validation is synchronous
 * and cheap, and every queue/network/config operation is deferred
 * (`docs/05` §5.4). Safe to call more than once: each call disposes the
 * previously active client (if any) and starts a fresh one. A non-public key
 * (`cs_*_sk_…` or malformed) disables the SDK fail-soft (`docs/04` §4.2)
 * rather than throwing.
 */
export const init = safely((config: CodeskopConfig): void => {
  const validation = validateApiKey(config.apiKey);
  if (!validation.valid) {
    // Fail-soft: no active client means every future capture-module call
    // into `getActiveClient()` is a safe no-op (`docs/05` §5.4).
    setActiveClient(undefined);
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
