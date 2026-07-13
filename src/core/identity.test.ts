import { describe, expect, it, vi } from 'vitest';
import { IdentityManager, validateApiKey } from './identity.js';

describe('IdentityManager', () => {
  it('attributes to the anonymous install id before identify() is ever called', () => {
    const manager = new IdentityManager(() => 'install-abc');
    expect(manager.isAnonymous).toBe(true);
    expect(manager.currentUserRef()).toEqual({ id: 'install-abc', is_anonymous: true });
  });

  it('identify() switches attribution to the identified user', () => {
    const manager = new IdentityManager(() => 'install-abc');
    manager.identify('user-1');
    expect(manager.isAnonymous).toBe(false);
    expect(manager.currentUserRef()).toEqual({ id: 'user-1', is_anonymous: false });
  });

  it('repeating identify() with the same userId re-asserts, not duplicates, the identity', () => {
    const manager = new IdentityManager(() => 'install-abc');
    manager.identify('user-1', { plan: 'free' });
    manager.identify('user-1', { plan: 'pro' });
    expect(manager.snapshot()).toEqual({
      userId: 'user-1',
      traits: { plan: 'pro' },
      isAnonymous: false,
    });
    expect(manager.currentUserRef()).toEqual({ id: 'user-1', is_anonymous: false });
  });

  it('identify() with a different userId replaces the current identity outright', () => {
    const manager = new IdentityManager(() => 'install-abc');
    manager.identify('user-1');
    manager.identify('user-2');
    expect(manager.currentUserRef()).toEqual({ id: 'user-2', is_anonymous: false });
  });

  it('reset() clears the identified user and reverts attribution to the install id', () => {
    const manager = new IdentityManager(() => 'install-abc');
    manager.identify('user-1', { plan: 'pro' });
    manager.reset();
    expect(manager.isAnonymous).toBe(true);
    expect(manager.currentUserRef()).toEqual({ id: 'install-abc', is_anonymous: true });
    expect(manager.snapshot()).toEqual({ userId: undefined, traits: undefined, isAnonymous: true });
  });

  it('reset() does not touch the install id — a later anonymous ref uses the same id', () => {
    const getInstallId = vi.fn(() => 'install-stable');
    const manager = new IdentityManager(getInstallId);
    manager.identify('user-1');
    manager.reset();
    expect(manager.currentUserRef()).toEqual({ id: 'install-stable', is_anonymous: true });
  });

  it('currentUserRef re-reads the install id supplier lazily (not cached at construction)', () => {
    let installId = 'install-1';
    const manager = new IdentityManager(() => installId);
    expect(manager.currentUserRef().id).toBe('install-1');
    installId = 'install-2';
    expect(manager.currentUserRef().id).toBe('install-2');
  });

  it('traits are never exposed on the wire-facing UserRef, identified or anonymous', () => {
    const manager = new IdentityManager(() => 'install-abc');
    manager.identify('user-1', { email: 'a@b.com', plan: 'pro' });
    const ref = manager.currentUserRef();
    expect(ref).toEqual({ id: 'user-1', is_anonymous: false });
    expect(Object.keys(ref)).not.toContain('traits');
  });

  it('identify() with an empty-string userId is ignored (fail-soft, no throw) and leaves identity untouched', () => {
    const manager = new IdentityManager(() => 'install-abc');
    expect(() => manager.identify('')).not.toThrow();
    expect(manager.isAnonymous).toBe(true);
  });

  it('identify() with a non-string userId is ignored (fail-soft, no throw)', () => {
    const manager = new IdentityManager(() => 'install-abc');
    // @ts-expect-error — exercising a caller that ignores the type system.
    expect(() => manager.identify(12345)).not.toThrow();
    expect(manager.isAnonymous).toBe(true);
  });

  it('identify() called without traits clears any previously-set traits', () => {
    const manager = new IdentityManager(() => 'install-abc');
    manager.identify('user-1', { plan: 'pro' });
    manager.identify('user-1');
    expect(manager.snapshot().traits).toBeUndefined();
  });

  it('reset() before any identify() is a harmless no-op', () => {
    const manager = new IdentityManager(() => 'install-abc');
    expect(() => manager.reset()).not.toThrow();
    expect(manager.currentUserRef()).toEqual({ id: 'install-abc', is_anonymous: true });
  });
});

describe('validateApiKey', () => {
  it('accepts a well-formed public key', () => {
    expect(validateApiKey('cs_live_pk_abc123XYZ')).toEqual({ valid: true });
    expect(validateApiKey('cs_test_pk_R4nd0mKeyMaterial-_1')).toEqual({ valid: true });
  });

  it('rejects a secret key with reason "secret_key"', () => {
    expect(validateApiKey('cs_live_sk_abc123XYZ')).toEqual({ valid: false, reason: 'secret_key' });
    expect(validateApiKey('cs_test_sk_')).toEqual({ valid: false, reason: 'secret_key' });
  });

  it('rejects a malformed key with reason "malformed"', () => {
    expect(validateApiKey('not-a-key')).toEqual({ valid: false, reason: 'malformed' });
    expect(validateApiKey('cs_live_pk_')).toEqual({ valid: false, reason: 'malformed' });
    expect(validateApiKey('cs_pk_abc123')).toEqual({ valid: false, reason: 'malformed' });
    expect(validateApiKey('')).toEqual({ valid: false, reason: 'malformed' });
  });

  it('rejects non-string input with reason "malformed" and never throws', () => {
    expect(validateApiKey(undefined)).toEqual({ valid: false, reason: 'malformed' });
    expect(validateApiKey(null)).toEqual({ valid: false, reason: 'malformed' });
    expect(validateApiKey(12345)).toEqual({ valid: false, reason: 'malformed' });
    expect(validateApiKey({})).toEqual({ valid: false, reason: 'malformed' });
    expect(validateApiKey(['cs_live_pk_abc'])).toEqual({ valid: false, reason: 'malformed' });
  });

  it('never throws regardless of input', () => {
    const inputs: unknown[] = [undefined, null, 12345, {}, [], () => {}, Symbol('k'), NaN];
    for (const input of inputs) {
      expect(() => validateApiKey(input)).not.toThrow();
    }
  });

  it('is case-insensitive on the secret marker but still requires the cs_..._pk_ shape for acceptance', () => {
    expect(validateApiKey('cs_live_SK_abc123')).toEqual({ valid: false, reason: 'secret_key' });
  });
});
