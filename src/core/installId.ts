/**
 * Install-ID generation & persistence (`docs/03` §3.3 `device.install_id`,
 * `web-sdk-workflow.md` Phase 4). A random per-browser identifier, generated
 * once and persisted so it survives reloads — anonymous event attribution
 * (`IdentityManager.currentUserRef`) reads this value, and a fresh id every
 * load would break the very continuity it exists to provide.
 *
 * `localStorage` (via `config/cache.ts`'s storage seam) is the primary
 * store; a cookie is the fallback for hosts where `localStorage` is absent
 * or throws on use (Safari private mode, some locked-down embeds). If
 * neither is writable, a generated id is still returned so the SDK keeps
 * working — it just won't survive this page load.
 */
import { resolveDefaultStorage } from '../config/cache.js';

/** Versioned so a future incompatible shape change can be ignored instead of misread. */
export const INSTALL_ID_STORAGE_KEY = 'codeskop:install_id:v1';

/**
 * The anonymous id (events v2, `backend/docs/11` §11.5), stored next to the
 * install id: sent on every event before and after `identify()`, and replaced
 * by `reset()` so the next person on a shared device starts fresh.
 */
export const ANONYMOUS_ID_STORAGE_KEY = 'codeskop:anonymous_id:v1';

/** The narrow slice of `Storage` this module actually needs — trivial to fake in tests. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The practical cap most browsers enforce on a cookie's `Max-Age`, in seconds (~400 days). */
const COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

/** Reads/writes a single cookie by name — the fallback store when `localStorage` is unavailable. */
export interface CookieJar {
  read(name: string): string | undefined;
  write(name: string, value: string, maxAgeSeconds: number): void;
}

/** The real `document.cookie`-backed jar. `undefined`/no-op wherever `document` doesn't exist (SSR, Node). */
export const documentCookieJar: CookieJar = {
  read(name) {
    if (typeof document === 'undefined' || typeof document.cookie !== 'string' || !document.cookie) {
      return undefined;
    }
    const prefix = `${name}=`;
    const match = document.cookie.split('; ').find((entry) => entry.startsWith(prefix));
    return match ? decodeURIComponent(match.slice(prefix.length)) : undefined;
  },
  write(name, value, maxAgeSeconds) {
    if (typeof document === 'undefined') return;
    document.cookie = `${name}=${encodeURIComponent(value)}; max-age=${maxAgeSeconds}; path=/; SameSite=Lax`;
  },
};

/** Fills `length` random bytes via Web Crypto where available, else `Math.random` — never throws. */
function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  const cryptoObj: Crypto | undefined = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    cryptoObj.getRandomValues(bytes);
    return bytes;
  }
  for (let i = 0; i < length; i += 1) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

/** Generates a fresh id: 128 bits of randomness, hex-encoded, with a readable prefix. */
function generateId(prefix: string): string {
  const hex = Array.from(randomBytes(16), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${prefix}${hex}`;
}

function readFromStorage(storage: StorageLike | undefined, key: string): string | undefined {
  if (!storage) return undefined;
  try {
    return storage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function readFromCookie(cookieJar: CookieJar, key: string): string | undefined {
  try {
    return cookieJar.read(key);
  } catch {
    return undefined;
  }
}

function persist(storage: StorageLike | undefined, cookieJar: CookieJar, key: string, value: string): void {
  try {
    if (storage) {
      storage.setItem(key, value);
      return;
    }
  } catch {
    // `localStorage` exists but threw on write (e.g. Safari private mode) — fall back to the cookie.
  }
  try {
    cookieJar.write(key, value, COOKIE_MAX_AGE_SECONDS);
  } catch {
    // Nothing writable: the id simply won't survive this page load.
  }
}

export interface ResolveInstallIdOptions {
  /** Injectable storage, e.g. a test double. Defaults to `resolveDefaultStorage()` (`localStorage`). */
  storage?: StorageLike;
  /** Injectable cookie jar, e.g. a test double. Defaults to the real `document.cookie`. */
  cookieJar?: CookieJar;
}

/**
 * Returns the persisted install id, generating and persisting a new one on
 * first use. Tries `localStorage` first, then the cookie fallback; never
 * throws regardless of what either store does.
 */
export function resolveInstallId(options: ResolveInstallIdOptions = {}): string {
  return resolveStoredId(INSTALL_ID_STORAGE_KEY, 'inst_', options);
}

/**
 * Returns the persisted anonymous id (`a_…`), generating one on first use.
 * With `rotate`, always generates and persists a new one (`reset()`).
 */
export function resolveAnonymousId(options: ResolveInstallIdOptions = {}, rotate = false): string {
  return resolveStoredId(ANONYMOUS_ID_STORAGE_KEY, 'a_', options, rotate);
}

function resolveStoredId(key: string, prefix: string, options: ResolveInstallIdOptions, rotate = false): string {
  const storage = options.storage ?? resolveDefaultStorage();
  const cookieJar = options.cookieJar ?? documentCookieJar;

  const existing = rotate ? undefined : (readFromStorage(storage, key) ?? readFromCookie(cookieJar, key));
  if (existing) return existing;

  const generated = generateId(prefix);
  persist(storage, cookieJar, key, generated);
  return generated;
}
