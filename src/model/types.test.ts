import { describe, expect, it } from 'vitest';
import type { CodeskopEvent, HeartbeatPayload } from './types.js';

describe('wire contract types', () => {
  it('shapes a valid CodeskopEvent (compile-time + smoke check)', () => {
    const payload: HeartbeatPayload = { session_id: 'sess_1', visible: true };
    const event: CodeskopEvent = {
      event_id: '018f6f3e-0000-7000-8000-000000000000',
      type: 'heartbeat',
      occurred_at: new Date(0).toISOString(),
      severity: 'low',
      payload,
    };

    expect(event.type).toBe('heartbeat');
    expect(event.payload).toEqual(payload);
  });
});
