import { describe, expect, it } from 'vitest';
import type { CodeskopEvent } from '../model/types.js';
import { estimateEventBytes } from './byte-size.js';

function heartbeat(sessionId: string): CodeskopEvent {
  return {
    event_id: 'evt-1',
    type: 'heartbeat',
    occurred_at: '2026-07-13T00:00:00.000Z',
    severity: 'low',
    payload: { session_id: sessionId, visible: true },
  };
}

describe('estimateEventBytes', () => {
  it('matches the UTF-8 byte length of the event JSON', () => {
    const event = heartbeat('abc');
    expect(estimateEventBytes(event)).toBe(JSON.stringify(event).length);
  });

  it('grows with payload size', () => {
    const small = estimateEventBytes(heartbeat('x'));
    const large = estimateEventBytes(heartbeat('x'.repeat(1000)));
    expect(large).toBeGreaterThan(small);
    expect(large - small).toBe(999);
  });

  it('counts multi-byte characters as more than one byte', () => {
    const ascii = estimateEventBytes(heartbeat('a'));
    const multiByte = estimateEventBytes(heartbeat('\u{1F600}')); // emoji, 4 UTF-8 bytes
    expect(multiByte - ascii).toBeGreaterThan(1);
  });
});
