import { describe, expect, it } from 'vitest';
import { isRemoteConfig, parseRemoteConfig } from './validate.js';

const VALID = {
  enabled: true,
  sample_rates: { api_timing: 0.2 },
  features: { anr: true, network: false },
  max_queue_mb: 10,
};

describe('isRemoteConfig', () => {
  it('accepts a well-formed config', () => {
    expect(isRemoteConfig(VALID)).toBe(true);
  });

  it('accepts empty sample_rates/features maps', () => {
    expect(
      isRemoteConfig({ enabled: false, sample_rates: {}, features: {}, max_queue_mb: 1 }),
    ).toBe(true);
  });

  it('accepts an optional string etag', () => {
    expect(isRemoteConfig({ ...VALID, etag: 'W/"abc"' })).toBe(true);
  });

  it.each([
    ['null', null],
    ['a string', 'not-a-config'],
    ['an array', []],
    ['missing enabled', { sample_rates: {}, features: {}, max_queue_mb: 1 }],
    ['non-boolean enabled', { ...VALID, enabled: 'true' }],
    ['non-numeric sample_rates value', { ...VALID, sample_rates: { x: 'nope' } }],
    ['non-boolean features value', { ...VALID, features: { x: 1 } }],
    ['array sample_rates', { ...VALID, sample_rates: [] }],
    ['missing max_queue_mb', { enabled: true, sample_rates: {}, features: {} }],
    ['non-numeric max_queue_mb', { ...VALID, max_queue_mb: '10' }],
    ['non-string etag', { ...VALID, etag: 123 }],
    ['NaN sample rate', { ...VALID, sample_rates: { x: NaN } }],
  ])('rejects %s', (_label, value) => {
    expect(isRemoteConfig(value)).toBe(false);
  });
});

describe('parseRemoteConfig', () => {
  it('returns the parsed config unchanged when there is no etag', () => {
    expect(parseRemoteConfig(VALID)).toEqual(VALID);
  });

  it('stamps the given etag onto the result', () => {
    expect(parseRemoteConfig(VALID, 'abc123')).toEqual({ ...VALID, etag: 'abc123' });
  });

  it('returns undefined for a malformed body instead of throwing', () => {
    expect(parseRemoteConfig({ nope: true })).toBeUndefined();
    expect(parseRemoteConfig(null)).toBeUndefined();
    expect(parseRemoteConfig('garbage')).toBeUndefined();
  });
});
