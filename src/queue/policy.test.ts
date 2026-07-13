import { describe, expect, it } from 'vitest';
import type { CodeskopEvent, Severity } from '../model/types.js';
import { clampReserveRatio, DEFAULT_CRITICAL_RESERVE_RATIO, isCriticalEvent } from './policy.js';

function eventWith(severity: Severity, type: CodeskopEvent['type']): CodeskopEvent {
  return {
    event_id: 'evt-1',
    type,
    occurred_at: '2026-07-13T00:00:00.000Z',
    severity,
    payload: { session_id: 's', visible: true },
  };
}

describe('isCriticalEvent', () => {
  it('treats high severity as critical', () => {
    expect(isCriticalEvent(eventWith('high', 'api_timing'))).toBe(true);
  });

  it('treats exception type as critical regardless of severity', () => {
    expect(isCriticalEvent(eventWith('low', 'exception'))).toBe(true);
  });

  it('does not treat "critical" severity as critical (narrower, literal policy)', () => {
    expect(isCriticalEvent(eventWith('critical', 'api_timing'))).toBe(false);
  });

  it('treats low/medium severity, non-exception events as non-critical', () => {
    expect(isCriticalEvent(eventWith('low', 'api_timing'))).toBe(false);
    expect(isCriticalEvent(eventWith('medium', 'heartbeat'))).toBe(false);
  });
});

describe('clampReserveRatio', () => {
  it('passes through values already in [0, 1]', () => {
    expect(clampReserveRatio(0.5)).toBe(0.5);
    expect(clampReserveRatio(0)).toBe(0);
    expect(clampReserveRatio(1)).toBe(1);
  });

  it('clamps out-of-range values', () => {
    expect(clampReserveRatio(-1)).toBe(0);
    expect(clampReserveRatio(2)).toBe(1);
  });

  it('falls back to the default on NaN', () => {
    expect(clampReserveRatio(Number.NaN)).toBe(DEFAULT_CRITICAL_RESERVE_RATIO);
  });
});
