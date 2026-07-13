/**
 * The remote-config module's public surface (`docs/02` §2.6): the
 * `ConfigSource` implementation, the applied-config lookup other capture
 * modules will use, the last-known-good cache, and the safe default.
 */
export { RemoteConfigClient } from './remoteConfigClient.js';
export type { RemoteConfigClientOptions, FetchLike } from './remoteConfigClient.js';

export { FeatureGate } from './featureGate.js';

export { DEFAULT_REMOTE_CONFIG } from './defaults.js';

export {
  readCachedConfig,
  writeCachedConfig,
  resolveDefaultStorage,
  CONFIG_CACHE_KEY,
} from './cache.js';
export type { StorageLike } from './cache.js';

export { isRemoteConfig, parseRemoteConfig } from './validate.js';
