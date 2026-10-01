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
    const first = sessions.current();
    now += SESSION_TIMEOUT_MS - 1000;
    expect(sessions.current()).toBe(first);
    now += SESSION_TIMEOUT_MS + 1;
    expect(sessions.current()).not.toBe(first);
  });

  it('survives page loads through storage', () => {
    const storage = memoryStorage();
    const id = new SessionManager(storage, () => 5).current();
    expect(new SessionManager(storage, () => 10).current()).toBe(id);
  });

  it('works without storage', () => {
    const sessions = new SessionManager(undefined, () => 1);
    expect(sessions.current()).toMatch(/^sess_[0-9a-f]{32}$/);
    expect(sessions.current()).toBe(sessions.current());
  });
});
