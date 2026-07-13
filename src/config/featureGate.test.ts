import { describe, expect, it } from 'vitest';
import { FeatureGate } from './featureGate.js';
import { DEFAULT_REMOTE_CONFIG } from './defaults.js';
import type { RemoteConfig } from '../model/types.js';

const ENABLED_CONFIG: RemoteConfig = {
  enabled: true,
  sample_rates: { api_timing: 0.2 },
  features: { anr: true, network: false },
  max_queue_mb: 10,
};

describe('FeatureGate', () => {
  it('defaults to DEFAULT_REMOTE_CONFIG when constructed with no config', () => {
    const gate = new FeatureGate();
    expect(gate.current).toEqual(DEFAULT_REMOTE_CONFIG);
    expect(gate.isKillSwitched()).toBe(false);
  });

  it('reports isKillSwitched() true only when enabled:false', () => {
    expect(new FeatureGate(ENABLED_CONFIG).isKillSwitched()).toBe(false);
    expect(new FeatureGate({ ...ENABLED_CONFIG, enabled: false }).isKillSwitched()).toBe(true);
  });

  it('isFeatureEnabled reflects an explicit true/false in features', () => {
    const gate = new FeatureGate(ENABLED_CONFIG);
    expect(gate.isFeatureEnabled('anr')).toBe(true);
    expect(gate.isFeatureEnabled('network')).toBe(false);
  });

  it('isFeatureEnabled falls back to the given default for an unlisted feature', () => {
    const gate = new FeatureGate(ENABLED_CONFIG);
    expect(gate.isFeatureEnabled('unknown-feature')).toBe(true);
    expect(gate.isFeatureEnabled('unknown-feature', false)).toBe(false);
  });

  it('isFeatureEnabled is unconditionally false once kill-switched, even for an explicitly-true feature', () => {
    const gate = new FeatureGate({ ...ENABLED_CONFIG, enabled: false });
    expect(gate.isFeatureEnabled('anr')).toBe(false);
  });

  it('sampleRate returns the configured rate, or the fallback when unset', () => {
    const gate = new FeatureGate(ENABLED_CONFIG);
    expect(gate.sampleRate('api_timing')).toBe(0.2);
    expect(gate.sampleRate('exception')).toBe(1);
    expect(gate.sampleRate('exception', 0.5)).toBe(0.5);
  });

  it('maxQueueMb returns the configured cap', () => {
    expect(new FeatureGate(ENABLED_CONFIG).maxQueueMb()).toBe(10);
  });

  it('update() swaps in a newly-fetched config', () => {
    const gate = new FeatureGate();
    gate.update(ENABLED_CONFIG);
    expect(gate.current).toEqual(ENABLED_CONFIG);
    expect(gate.maxQueueMb()).toBe(10);
  });
});
