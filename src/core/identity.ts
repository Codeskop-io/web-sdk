/**
 * Identity & key handling (D5, D7; `docs/01` §D5/D7, `docs/04-security-and-
 * licensing.md` §4.2, `docs/05-api-reference.md` §5.3).
 *
 * Two independent responsibilities live here:
 *
 *  - `IdentityManager` tracks the current logical user for event attribution.
 *    `identify()`/`reset()` mirror the backend's rule — repeating the same
 *    `userId` updates, never creates, a new user — without re-deriving it:
 *    this class simply always hands back the same `id` unchanged across
 *    calls, and lets the backend own what "same id" means. Every event also
 *    carries the anonymous id supplied by the caller (events v2).
 *
 *  - `validateApiKey` is the fail-soft key gate at `init`: it accepts
 *    `cs_*_pk_…`, rejects a secret key (`cs_*_sk_…`) or anything malformed,
 *    and never throws — the caller uses the returned result to disable the
 *    SDK and record an internal diagnostic (`docs/04` §4.2). The SDK sends
 *    only this validated key on the wire; there is no client-declared
 *    "scopes" concept anywhere in this module — scopes are enforced
 *    server-side from `APIKey.scopes` (D7).
 */
import type { UserRef } from '../model/types.js';

/** Traits accompanying `identify()`. Redacted (`docs/04` §4.4): kept only for local/diagnostic use and never placed on the wire — `UserRef` has no traits field. */
export type IdentityTraits = Record<string, unknown>;

/** Point-in-time view of `IdentityManager`'s state, for diagnostics/tests. */
export interface IdentitySnapshot {
  readonly userId: string | undefined;
  readonly traits: IdentityTraits | undefined;
  readonly isAnonymous: boolean;
}

/**
 * Tracks the current logical user for event attribution (`docs/05` §5.3).
 *
 * `identify()` is idempotent by design: calling it again — with the same or
 * a different `userId` — simply re-asserts the current identity outright;
 * there is no merge, and the backend (not this class) is what treats a
 * repeated `userId` as an update rather than a new user. `reset()` makes
 * events anonymous again.
 */
export class IdentityManager {
  private userId: string | undefined;
  private traits: IdentityTraits | undefined;

  /**
   * @param getAnonymousId Supplies the current anonymous id (events v2,
   *   `backend/docs/11` §11.5), sent on every event before and after
   *   `identify()`. Read lazily on every call so the id `reset()` rotates in
   *   is reflected straight away.
   */
  constructor(private readonly getAnonymousId: () => string) {}

  /**
   * Associates subsequent events with a stable logical user. Repeating the
   * same `userId` is intentional and expected (`docs/05` §5.3) — it does not
   * start a new identity, it re-asserts the existing one. A non-string or
   * empty `userId` is ignored (fail-soft, never throws) and leaves any
   * existing identity untouched.
   */
  identify(userId: string, traits?: IdentityTraits): void {
    if (typeof userId !== 'string' || userId.length === 0) return;
    this.userId = userId;
    this.traits = traits;
  }

  /**
   * Clears the current user (e.g. on logout). Subsequent events are
   * anonymous again; the caller rotates the anonymous id. The install id
   * persists (`docs/05` §5.3).
   */
  reset(): void {
    this.userId = undefined;
    this.traits = undefined;
  }

  /** `true` until the first `identify()` call, and again after any `reset()`. */
  get isAnonymous(): boolean {
    return this.userId === undefined;
  }

  /**
   * Builds the `UserRef` to attach to an outgoing event (`docs/03` §3.2):
   * always the anonymous id, plus the user id once identified. An anonymous
   * event carries no `id`, so the backend can link it to the user who later
   * logs in (`backend/docs/11` §11.5).
   */
  currentUserRef(): UserRef {
    const anonymous_id = this.getAnonymousId();
    return this.userId !== undefined
      ? { id: this.userId, anonymous_id, is_anonymous: false }
      : { anonymous_id, is_anonymous: true };
  }

  /** Snapshot for tests/diagnostics. Traits never leave this object (`docs/04` §4.4). */
  snapshot(): IdentitySnapshot {
    return { userId: this.userId, traits: this.traits, isAnonymous: this.isAnonymous };
  }
}

// ---------------------------------------------------------------------------
// Key validation (D5, D7, `docs/04` §4.2)
// ---------------------------------------------------------------------------

/** Why `validateApiKey` rejected a key. */
export type KeyRejectionReason = 'secret_key' | 'malformed';

/** Result of validating an `apiKey` at `init` time. Always returned, never thrown. */
export interface KeyValidationResult {
  valid: boolean;
  reason?: KeyRejectionReason;
}

/** Matches `cs_<env>_sk_…` — a secret key. Checked first so a secret is reported as `secret_key`, not lumped into `malformed`. */
const SECRET_KEY_PATTERN = /^cs_[a-z0-9]+_sk_/i;

/** Matches `cs_<env>_pk_<key material>` — the shape the backend's key generator produces (`accounts/services/keys.py`). */
const PUBLIC_KEY_PATTERN = /^cs_[a-z0-9]+_pk_[A-Za-z0-9_-]+$/;

/**
 * Validates a public ingest key at `init` (`docs/04` §4.2, `docs/05` §5.1).
 * Accepts `cs_*_pk_…`; rejects a secret key (`cs_*_sk_…`) or anything else
 * malformed (wrong shape, empty, or not a string at all).
 *
 * Fail-soft by construction — every branch returns rather than throws, and
 * the whole body is additionally wrapped so this function can never become
 * the caller's unguarded failure, however the input is shaped. The caller
 * (SDK init) uses the result to disable the SDK and record a diagnostic; it
 * never sees an exception here. This function only ever inspects the key
 * string — it has no notion of scopes, which are enforced server-side (D7).
 */
export function validateApiKey(apiKey: unknown): KeyValidationResult {
  try {
    if (typeof apiKey !== 'string' || apiKey.length === 0) {
      return { valid: false, reason: 'malformed' };
    }
    if (SECRET_KEY_PATTERN.test(apiKey)) {
      return { valid: false, reason: 'secret_key' };
    }
    if (!PUBLIC_KEY_PATTERN.test(apiKey)) {
      return { valid: false, reason: 'malformed' };
    }
    return { valid: true };
  } catch {
    // Defensive: a regex test against a string cannot realistically throw,
    // but the contract here is that this function never throws, full stop.
    return { valid: false, reason: 'malformed' };
  }
}
