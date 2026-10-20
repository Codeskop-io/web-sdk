import { describe, expect, it } from 'vitest';
import { SESSION_TIMEOUT_MS, SessionManager, type StorageLike } from './session.js';

function memoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

describe('SessionManager', () => {
  it('keeps one session while active and starts a new one after 30 idle minutes', () => {
    let now = 1_000_000;
    const sessions = new SessionManager(memoryStorage(), () => now);
    expect(sessions.touch()).toEqual({ ended: undefined, started: true });
    const first = sessions.state!;
    now += SESSION_TIMEOUT_MS - 1000;
    expect(sessions.touch()).toEqual({ started: false });
    expect(sessions.state).toBe(first);
    now += SESSION_TIMEOUT_MS + 1;
    const roll = sessions.touch();
    expect(roll.started).toBe(true);
    expect(roll.ended).toBe(first);
    expect(sessions.state!.id).not.toBe(first.id);
    expect(sessions.state).toMatchObject({ start: now, last: now, seq: 0, screens: 0 });
  });

  it('survives page loads through storage, and knows the tab had a session', () => {
    const storage = memoryStorage();
    const first = new SessionManager(storage, () => 5);
    expect(first.existed).toBe(false);
    first.touch();
    first.state!.seq = 7;
    first.save();
    const second = new SessionManager(storage, () => 10);
    expect(second.existed).toBe(true);
    expect(second.touch().started).toBe(false);
    expect(second.state).toMatchObject({ id: first.state!.id, seq: 7, last: 10 });
  });

  it('reads a 1.4 session (id and last only)', () => {
    const storage = memoryStorage();
    storage.setItem('codeskop:session:v1', JSON.stringify({ id: 'sess_old', last: 100 }));
    const sessions = new SessionManager(storage, () => 200);
    expect(sessions.state).toEqual({ id: 'sess_old', last: 100, start: 100, seq: 0, screens: 0 });
  });

  it('starts a new session after a closed one, without ending it again', () => {
    const sessions = new SessionManager(memoryStorage(), () => 1);
    sessions.touch();
    sessions.state!.closed = 1;
    expect(sessions.touch()).toEqual({ ended: undefined, started: true });
  });

  it('ignores unreadable storage', () => {
    const storage = memoryStorage();
    storage.setItem('codeskop:session:v1', '{not json');
    expect(new SessionManager(storage).existed).toBe(false);
    const throwing: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error('full');
      },
    };
    const sessions = new SessionManager(throwing, () => 1);
    sessions.touch();
    expect(() => sessions.save()).not.toThrow();
  });

  it('works without storage', () => {
    const sessions = new SessionManager(undefined, () => 1);
    sessions.touch();
    expect(sessions.state!.id).toMatch(/^sess_[0-9a-f]{32}$/);
  });
});
