/**
 * Analytics sessions on the web: one session spans page loads and navigations
 * in a tab, and ends after 30 minutes without activity — the usual analytics
 * convention, so funnels and paths on multi-page sites stay in one session.
 *
 * Stored in `sessionStorage` (per tab, cleared when the tab closes). Without
 * storage (privacy mode, SSR), the session lives in memory for the page load.
 */
export const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const STORAGE_KEY = 'codeskop:session:v1';

interface StoredSession {
  id: string;
  last: number;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): StorageLike | undefined {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : undefined;
  } catch {
    return undefined;
  }
}

function newSessionId(): string {
  const bytes = new Uint8Array(16);
  const cryptoImpl = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (cryptoImpl?.getRandomValues) cryptoImpl.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return `sess_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export class SessionManager {
  private memory: StoredSession | undefined;

  constructor(
    private readonly storage: StorageLike | undefined = defaultStorage(),
    private readonly now: () => number = Date.now,
  ) {}

  /** The current session id, starting a new session after 30 idle minutes. Every call counts as activity. */
  current(): string {
    const now = this.now();
    let session = this.read();
    if (!session || now - session.last > SESSION_TIMEOUT_MS) {
      session = { id: newSessionId(), last: now };
    }
    session.last = now;
    this.write(session);
    return session.id;
  }

  private read(): StoredSession | undefined {
    try {
      const raw = this.storage?.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as StoredSession;
        if (typeof parsed?.id === 'string' && typeof parsed.last === 'number') return parsed;
      }
    } catch {
      // fall through to memory
    }
    return this.memory;
  }

  private write(session: StoredSession): void {
    this.memory = session;
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(session));
    } catch {
      // storage full or blocked: memory still has it
    }
  }
}
