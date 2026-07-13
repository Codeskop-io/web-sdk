import { describe, expect, it } from 'vitest';
import type { Clock } from '../model/types.js';
import { generateEventId, systemClock } from './id.js';

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fixedClock(ms: number): Clock {
  return { now: () => ms };
}

describe('generateEventId', () => {
  it('produces a well-formed UUIDv7 (version + variant nibbles set)', () => {
    const id = generateEventId(fixedClock(Date.UTC(2026, 0, 1)));
    expect(id).toMatch(UUID_V7_RE);
  });

  it('is unique across calls at the same millisecond', () => {
    const clock = fixedClock(1_700_000_000_000);
    const ids = new Set(Array.from({ length: 200 }, () => generateEventId(clock)));
    expect(ids.size).toBe(200);
  });

  it('sorts lexicographically with the millisecond timestamp (monotonic prefix)', () => {
    const earlier = generateEventId(fixedClock(1_700_000_000_000));
    const later = generateEventId(fixedClock(1_700_000_000_001));
    expect(earlier < later).toBe(true);
  });

  it('encodes the exact 48-bit timestamp into the first 12 hex characters', () => {
    const ts = 1_735_689_600_000; // 2025-01-01T00:00:00.000Z
    const id = generateEventId(fixedClock(ts));
    const hex = id.replace(/-/g, '').slice(0, 12);
    expect(parseInt(hex, 16)).toBe(ts);
  });

  it('defaults to the real system clock when none is supplied', () => {
    const before = Date.now();
    const id = generateEventId();
    const after = Date.now();
    const hex = id.replace(/-/g, '').slice(0, 12);
    const encoded = parseInt(hex, 16);
    expect(encoded).toBeGreaterThanOrEqual(before);
    expect(encoded).toBeLessThanOrEqual(after);
  });

  it('exposes a real-clock systemClock seam', () => {
    expect(systemClock.now()).toBeGreaterThan(0);
  });

  it('falls back to Math.random when Web Crypto is unavailable', () => {
    const originalCrypto = globalThis.crypto;
    // @ts-expect-error deliberately simulating a host with no Web Crypto API
    delete globalThis.crypto;
    try {
      const id = generateEventId(fixedClock(1_700_000_000_000));
      expect(id).toMatch(UUID_V7_RE);
    } finally {
      globalThis.crypto = originalCrypto;
    }
  });
});
