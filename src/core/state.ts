/**
 * The client lifecycle state machine (D4, `docs/01` §1.2, §4.5). Every capture
 * hook checks this before doing any work: only `enabled` captures; every other
 * state is a silent no-op.
 *
 * - `uninitialized` — before `init()` has run.
 * - `enabled` — actively capturing.
 * - `disabled` — capture paused, recoverably: the remote kill-switch
 *   (`RemoteConfig.enabled === false`) or a manual `disable()` call. Can
 *   re-enable.
 * - `killed` — a terminal state (an unrecoverable licensing/plan-gate failure,
 *   D11, or a fatal internal fault) with no way back short of a fresh page
 *   load / new instance.
 */
export type ClientState = 'uninitialized' | 'enabled' | 'disabled' | 'killed';

const LEGAL_TRANSITIONS: Readonly<Record<ClientState, readonly ClientState[]>> = {
  uninitialized: ['enabled', 'disabled', 'killed'],
  enabled: ['disabled', 'killed'],
  disabled: ['enabled', 'killed'],
  killed: [],
};

/** `true` if moving from `from` to `to` is a legal transition. Pure; never throws. */
export function canTransition(from: ClientState, to: ClientState): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

/** Thrown by `ClientStateMachine.transition` when asked to make an illegal move. */
export class IllegalStateTransitionError extends Error {
  constructor(
    public readonly from: ClientState,
    public readonly to: ClientState,
  ) {
    super(`Illegal client state transition: ${from} -> ${to}`);
    this.name = 'IllegalStateTransitionError';
  }
}

/** A small, explicit state machine guarding the client's lifecycle. */
export class ClientStateMachine {
  private current: ClientState;

  constructor(initial: ClientState = 'uninitialized') {
    this.current = initial;
  }

  /** The current state. */
  get state(): ClientState {
    return this.current;
  }

  /** `true` while `enabled` — the only state in which capture hooks should do work. */
  isEnabled(): boolean {
    return this.current === 'enabled';
  }

  /** `true` once `killed` — terminal; no future transition will ever succeed. */
  isKilled(): boolean {
    return this.current === 'killed';
  }

  /**
   * Attempts a transition. Returns `true` and applies it if legal; returns
   * `false` and leaves the state untouched otherwise. Never throws — the
   * non-throwing sibling of `transition`, for call sites (e.g. inside
   * `safely()`) that want to treat an illegal move as a harmless no-op.
   */
  tryTransition(to: ClientState): boolean {
    if (!canTransition(this.current, to)) return false;
    this.current = to;
    return true;
  }

  /**
   * Transitions or throws `IllegalStateTransitionError` — for call sites that
   * treat an illegal transition as a programming bug worth surfacing (in
   * development, or wrapped by `safely()` in production).
   */
  transition(to: ClientState): void {
    if (!this.tryTransition(to)) {
      throw new IllegalStateTransitionError(this.current, to);
    }
  }
}
