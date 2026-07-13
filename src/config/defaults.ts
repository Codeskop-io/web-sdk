/**
 * The hardcoded safe default used only when a `GET /v1/config` fetch fails
 * *and* there is no cached last-known-good config yet (a brand-new install,
 * offline on first load). Chosen to match `CodeskopConfig`'s own defaults
 * (`docs/05` §5.2) so a config-less SDK behaves like an unconfigured one:
 * capture stays on, no sampling is forced, and the queue cap matches
 * `CodeskopConfig.maxQueueMb`'s documented default of `5`.
 */
import type { RemoteConfig } from '../model/types.js';

export const DEFAULT_REMOTE_CONFIG: Readonly<RemoteConfig> = Object.freeze({
  enabled: true,
  sample_rates: {},
  features: {},
  max_queue_mb: 5,
});
