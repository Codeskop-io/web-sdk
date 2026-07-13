import { describe, expect, it } from 'vitest';
import { ALWAYS_SAMPLED_TYPES, Sampler } from './sampling.js';

describe('Sampler.rateFor', () => {
  it('always reports 1 for exception and api_error, regardless of configured rate', () => {
    const sampler = new Sampler({ sampleRates: { exception: 0, api_error: 0.01 } });
    expect(sampler.rateFor('exception')).toBe(1);
    expect(sampler.rateFor('api_error')).toBe(1);
  });

  it('uses the configured rate for api_timing', () => {
    const sampler = new Sampler({ sampleRates: { api_timing: 0.25 } });
    expect(sampler.rateFor('api_timing')).toBe(0.25);
  });

  it('defaults to 1 when a type has no configured rate', () => {
    const sampler = new Sampler({});
    expect(sampler.rateFor('api_timing')).toBe(1);
    expect(sampler.rateFor('heartbeat')).toBe(1);
  });

  it('clamps out-of-range configured rates into [0, 1]', () => {
    const sampler = new Sampler({ sampleRates: { api_timing: 5 } });
    expect(sampler.rateFor('api_timing')).toBe(1);
    const negative = new Sampler({ sampleRates: { api_timing: -2 } });
    expect(negative.rateFor('api_timing')).toBe(0);
  });

  it('treats a NaN configured rate as fully sampled rather than propagating NaN', () => {
    const sampler = new Sampler({ sampleRates: { api_timing: NaN } });
    expect(sampler.rateFor('api_timing')).toBe(1);
  });

  it('lists exception and api_error as the always-sampled types', () => {
    expect(ALWAYS_SAMPLED_TYPES).toEqual(['api_error', 'exception']);
  });
});

describe('Sampler.shouldSample', () => {
  it('always keeps exception and api_error', () => {
    const sampler = new Sampler({ random: () => 0.999 });
    expect(sampler.shouldSample('exception')).toBe(true);
    expect(sampler.shouldSample('api_error')).toBe(true);
  });

  it('keeps api_timing when the random draw is below the rate', () => {
    const sampler = new Sampler({ sampleRates: { api_timing: 0.5 }, random: () => 0.1 });
    expect(sampler.shouldSample('api_timing')).toBe(true);
  });

  it('drops api_timing when the random draw is at or above the rate', () => {
    const sampler = new Sampler({ sampleRates: { api_timing: 0.5 }, random: () => 0.9 });
    expect(sampler.shouldSample('api_timing')).toBe(false);
  });

  it('short-circuits without consuming randomness at rate 0 or 1', () => {
    let calls = 0;
    const random = () => {
      calls += 1;
      return 0.5;
    };
    const zero = new Sampler({ sampleRates: { api_timing: 0 }, random });
    const one = new Sampler({ sampleRates: { api_timing: 1 }, random });
    expect(zero.shouldSample('api_timing')).toBe(false);
    expect(one.shouldSample('api_timing')).toBe(true);
    expect(calls).toBe(0);
  });

  it('defaults its random source to Math.random', () => {
    const sampler = new Sampler({ sampleRates: { api_timing: 1 } });
    expect(sampler.shouldSample('api_timing')).toBe(true);
  });
});
