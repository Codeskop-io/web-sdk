import { beforeEach, describe, expect, it } from 'vitest';
import { documentCookieJar, INSTALL_ID_STORAGE_KEY, resolveInstallId, type CookieJar } from './installId.js';

function clearRealCookie(): void {
  document.cookie = `${INSTALL_ID_STORAGE_KEY}=; max-age=0; path=/`;
}

/** A `StorageLike` double that throws on every `setItem`, mimicking Safari private mode. */
function throwingStorage(): { getItem: () => null; setItem: () => never } {
  return {
    getItem: () => null,
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
  };
}

function memoryCookieJar(): CookieJar & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    read: (name) => store.get(name),
    write: (name, value) => store.set(name, value),
  };
}

beforeEach(() => {
  localStorage.clear();
  clearRealCookie();
});

describe('resolveInstallId', () => {
  it('generates a new id and persists it to localStorage', () => {
    const id = resolveInstallId();
    expect(id).toMatch(/^inst_[0-9a-f]{32}$/);
    expect(localStorage.getItem(INSTALL_ID_STORAGE_KEY)).toBe(id);
  });

  it('returns the same id on a subsequent call (persistence across "reloads")', () => {
    const first = resolveInstallId();
    const second = resolveInstallId();
    expect(second).toBe(first);
  });

  it('reads a pre-existing localStorage value rather than generating a new one', () => {
    localStorage.setItem(INSTALL_ID_STORAGE_KEY, 'inst_existing');
    expect(resolveInstallId()).toBe('inst_existing');
  });

  it('falls back to the cookie jar when localStorage throws on write', () => {
    const cookieJar = memoryCookieJar();
    const storage = throwingStorage();

    const id = resolveInstallId({ storage, cookieJar });

    expect(cookieJar.store.get(INSTALL_ID_STORAGE_KEY)).toBe(id);
  });

  it('reuses a cookie-persisted id on a later call once localStorage is unusable', () => {
    const cookieJar = memoryCookieJar();
    const storage = throwingStorage();

    const first = resolveInstallId({ storage, cookieJar });
    const second = resolveInstallId({ storage, cookieJar });

    expect(second).toBe(first);
  });

  it('still returns a usable id when neither store is writable', () => {
    const brokenCookieJar: CookieJar = {
      read: () => undefined,
      write: () => {
        throw new Error('cookies disabled');
      },
    };
    const id = resolveInstallId({ storage: throwingStorage(), cookieJar: brokenCookieJar });
    expect(id).toMatch(/^inst_[0-9a-f]{32}$/);
  });

  it('the real document.cookie jar round-trips a value written through it', () => {
    documentCookieJar.write(INSTALL_ID_STORAGE_KEY, 'inst_cookie_roundtrip', 3600);
    expect(documentCookieJar.read(INSTALL_ID_STORAGE_KEY)).toBe('inst_cookie_roundtrip');
  });

  it('falls back to the real document.cookie jar when localStorage is unusable', () => {
    const id = resolveInstallId({ storage: throwingStorage(), cookieJar: documentCookieJar });
    expect(documentCookieJar.read(INSTALL_ID_STORAGE_KEY)).toBe(id);
  });
});
