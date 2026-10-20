/**
 * Sessions on the web (events v2, `backend/docs/11` §11.4): one session spans
 * page loads and navigations in a tab, and ends after 30 minutes without
 * activity. Every event carries the session id and a per-session `seq`
 * counter, so events in the same millisecond keep their order.
 *
 * Stored in `sessionStorage` (per tab, cleared when the tab closes). Without
 * storage (privacy mode, SSR), the session lives in memory for the page load.
 */
export const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const STORAGE_KEY = 'codeskop:session:v1';

/** One session's state, as kept in `sessionStorage`. */
export interface SessionState {
  id: string;
  /** When the session started (ms). */
  start: number;
  /** Last activity (ms). */
  last: number;
  /** The next event's `seq`. */
  seq: number;
  /** Screen views so far. */
  screens: number;
  /** The last screen viewed, for `previous_screen`. */
  screen?: string;
  /** Set once `$session_ended` was sent for this session (the tab closed). */
  closed?: number;
}

/** What `touch()` found: a session that timed out, and whether a new one started. */
export interface SessionRoll {
  ended?: SessionState;
  started: boolean;
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
  const cryptoImpl = (
    globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }
  ).crypto;
  if (cryptoImpl?.getRandomValues) cryptoImpl.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return `sess_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export class SessionManager {
  /** The current session; `undefined` until the first event of this page load. */
  state: SessionState | undefined;
  /** `true` when this tab already had a session before this page load (a `warm` launch). */
  readonly existed: boolean;

  constructor(
    private readonly storage: StorageLike | undefined = defaultStorage(),
    private readonly now: () => number = Date.now,
  ) {
    try {
      // 1.4 stored only `id` and `last`: fill in the rest.
      const parsed = JSON.parse(
        this.storage?.getItem(STORAGE_KEY) ?? 'null',
      ) as Partial<SessionState> | null;
      if (typeof parsed?.id === 'string' && typeof parsed.last === 'number') {
        this.state = { start: parsed.last, seq: 0, screens: 0, ...parsed } as SessionState;
      }
    } catch {
      // unreadable: start fresh
    }
    this.existed = !!this.state;
  }

  /**
   * Records activity at `at` (default now). Starts a new session when there is
   * none, the last one was closed, or it has been idle for 30 minutes; a
   * session that timed out is returned as `ended` so the caller can send its
   * `$session_ended`.
   */
  touch(at: number = this.now()): SessionRoll {
    const current = this.state;
    if (current && !current.closed && at - current.last <= SESSION_TIMEOUT_MS) {
      current.last = Math.max(current.last, at);
      return { started: false };
    }
    this.state = { id: newSessionId(), start: at, last: at, seq: 0, screens: 0 };
    return { ended: current && !current.closed ? current : undefined, started: true };
  }

  /** Persists the current session (call after changing it). */
  save(): void {
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      // storage full or blocked: memory still has it
    }
  }
}
