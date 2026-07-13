import { describe, expect, it } from 'vitest';
import { computeBackoffMs } from './backoff.js';

describe('computeBackoffMs', () => {
  it('scales exponentially with attempt, before jitter', () => {
    // random() => 1 (the top of the [0,1) range in spirit) isolates the
    // pre-jitter exponential envelope: baseMs * 2^(attempt-1).
    const random = () => 1;
    expect(computeBackoffMs(1, { baseMs: 100, maxMs: 100_000, random })).toBe(100);
    expect(computeBackoffMs(2, { baseMs: 100, maxMs: 100_000, random })).toBe(200);
    expect(computeBackoffMs(3, { baseMs: 100, maxMs: 100_000, random })).toBe(400);
    expect(computeBackoffMs(4, { baseMs: 100, maxMs: 100_000, random })).toBe(800);
  });

  it('caps the exponential envelope at maxMs', () => {
    const random = () => 1;
    expect(computeBackoffMs(10, { baseMs: 100, maxMs: 500, random })).toBe(500);
  });

  it('applies full jitter: random() = 0 always yields 0 delay', () => {
    expect(computeBackoffMs(5, { baseMs: 100, random: () => 0 })).toBe(0);
  });

  it('treats attempt < 1 the same as attempt 1 (never a negative exponent)', () => {
    const random = () => 1;
    expect(computeBackoffMs(0, { baseMs: 100, maxMs: 100_000, random })).toBe(100);
    expect(computeBackoffMs(-3, { baseMs: 100, maxMs: 100_000, random })).toBe(100);
  });

  it('defaults to Math.random and sane base/max when no options are given', () => {
    const delay = computeBackoffMs(1);
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThan(500); // default baseMs
  });
});
