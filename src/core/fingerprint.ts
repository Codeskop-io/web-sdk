/**
 * Local grouping fingerprints — parity with the backend's authoritative recipe
 * (`backend/apps/processing/fingerprint.py`, `docs/03` §3.6). The server always
 * (re)computes its own fingerprint and never trusts a client value, so this is
 * **never transmitted**; it exists purely so the SDK can group/dedupe locally
 * (diagnostics, dev console) in a way that never disagrees with the backend.
 *
 * Every function here is a pure, deterministic transform of already-redacted
 * payload data — same input, same fingerprint, forever.
 */
import type { ApiErrorPayload, ApiTimingPayload, EventPayload, EventType, ExceptionPayload, StackFrame } from '../model/types.js';

// ---------------------------------------------------------------------------
// SHA-256 (FIPS 180-4), hand-rolled so fingerprinting has zero runtime
// dependencies and works identically under Node and in the browser — no
// `node:crypto`, no async Web Crypto `subtle.digest`. Only ever fed short,
// already-redacted strings, so raw throughput is not a concern.
// ---------------------------------------------------------------------------

const SHA256_ROUND_CONSTANTS: readonly number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const SHA256_INITIAL_HASH: readonly number[] = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

function sha256Bytes(message: Uint8Array): Uint8Array {
  const bitLength = message.length * 8;
  const remainderAfterLength = (message.length + 9) % 64;
  const paddingLength = remainderAfterLength === 0 ? 0 : 64 - remainderAfterLength;
  const total = message.length + 1 + paddingLength + 8;

  const padded = new Uint8Array(total);
  padded.set(message);
  padded[message.length] = 0x80;

  const view = new DataView(padded.buffer);
  // 64-bit big-endian bit length; the high word is always 0 for any message
  // short enough to fit in memory here (well under 2^32 bits).
  view.setUint32(total - 8, Math.floor(bitLength / 2 ** 32), false);
  view.setUint32(total - 4, bitLength >>> 0, false);

  const h = SHA256_INITIAL_HASH.slice();
  const w = new Uint32Array(64);

  for (let offset = 0; offset < total; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i += 1) {
      const wi15 = w[i - 15] as number;
      const wi2 = w[i - 2] as number;
      const s0 = (rotr(wi15, 7) ^ rotr(wi15, 18) ^ (wi15 >>> 3)) >>> 0;
      const s1 = (rotr(wi2, 17) ^ rotr(wi2, 19) ^ (wi2 >>> 10)) >>> 0;
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, hh] = h as [number, number, number, number, number, number, number, number];

    for (let i = 0; i < 64; i += 1) {
      const bigS1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (hh + bigS1 + ch + (SHA256_ROUND_CONSTANTS[i] as number) + (w[i] as number)) >>> 0;
      const bigS0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (bigS0 + maj) >>> 0;

      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h[0] = ((h[0] as number) + a) >>> 0;
    h[1] = ((h[1] as number) + b) >>> 0;
    h[2] = ((h[2] as number) + c) >>> 0;
    h[3] = ((h[3] as number) + d) >>> 0;
    h[4] = ((h[4] as number) + e) >>> 0;
    h[5] = ((h[5] as number) + f) >>> 0;
    h[6] = ((h[6] as number) + g) >>> 0;
    h[7] = ((h[7] as number) + hh) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i += 1) outView.setUint32(i * 4, h[i] as number, false);
  return out;
}

/** SHA-256 of a UTF-8 string, as a lowercase hex digest — matches Python's `hashlib.sha256(s.encode()).hexdigest()`. */
export function sha256Hex(input: string): string {
  const digest = sha256Bytes(new TextEncoder().encode(input));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Grouping recipe — must stay byte-for-byte identical to `fingerprint.py`.
// ---------------------------------------------------------------------------

/** Leading stack frames that define a group; deeper frames vary with call context. */
export const TOP_FRAMES = 5;

/** Constant, deliberately non-grouping fingerprint for heartbeats (a presence signal, not an issue). */
export const HEARTBEAT_FINGERPRINT = 'heartbeat';

const UUID_RE = /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/;
const NUMERIC_RE = /^\d+$/;
const HEX_RE = /^[0-9a-fA-F]{16,}$/;

// Mirrors `fingerprint.py`'s `_NOISE_PREFIXES` exactly, byte for byte, so the
// recipe is identical even where a prefix (e.g. Android's) will simply never
// match a web stack frame's `class`.
const NOISE_PREFIXES: readonly string[] = [
  'java.',
  'javax.',
  'kotlin.',
  'kotlinx.',
  'android.',
  'androidx.',
  'com.android.',
  'dalvik.',
  'sun.',
  'com.codeskop.sdk.',
];

function isVolatileSegment(segment: string): boolean {
  if (!segment) return false;
  return NUMERIC_RE.test(segment) || UUID_RE.test(segment) || HEX_RE.test(segment);
}

/**
 * Templates volatile path segments (numeric IDs, UUIDs, long hex tokens) to
 * `{id}` so `/users/1` and `/users/2` collapse into one group, and drops the
 * query string/fragment. Pure and order-preserving — mirrors `normalize_path`.
 */
export function normalizePath(path: string): string {
  if (!path) return '/';
  const withoutQuery = (path.split('?')[0] ?? '').split('#')[0] ?? '';
  const segments = withoutQuery.split('/');
  return segments.map((segment) => (isVolatileSegment(segment) ? '{id}' : segment)).join('/');
}

/** The subset of `ApiErrorPayload`/`ApiTimingPayload` the recipe reads. */
export type ApiFingerprintInput = Pick<ApiErrorPayload | ApiTimingPayload, 'method' | 'path' | 'status'>;

/** Fingerprints an `api_error`/`api_timing`: `METHOD normalized-path|status`. Mirrors `api_fingerprint`. */
export function apiFingerprint(payload: ApiFingerprintInput): string {
  const method = (payload.method ?? '').toUpperCase();
  const path = normalizePath(payload.path ?? '');
  const status = payload.status ?? '';
  return `${method} ${path}|${status}`;
}

function frameToken(frame: StackFrame): string {
  return `${frame.class ?? ''}.${frame.method ?? ''}`;
}

function isAppFrame(frame: StackFrame): boolean {
  const cls = frame.class ?? '';
  return !NOISE_PREFIXES.some((prefix) => cls.startsWith(prefix));
}

/**
 * Hashes the top `TOP_FRAMES` package-filtered stack frames into a short,
 * stable digest. Prefers app frames; if filtering would drop every frame (an
 * all-framework trace) the unfiltered frames are used instead, so a digest is
 * always produced. Mirrors `_hash_frames`.
 */
function hashFrames(stacktrace: readonly StackFrame[]): string {
  const appFrames = stacktrace.filter(isAppFrame);
  const chosen = (appFrames.length > 0 ? appFrames : stacktrace).slice(0, TOP_FRAMES);
  const joined = chosen.map(frameToken).join('\n');
  return sha256Hex(joined).slice(0, 16);
}

/** The subset of `ExceptionPayload` the recipe reads. */
export type ExceptionFingerprintInput = Pick<ExceptionPayload, 'exception_class' | 'stacktrace'>;

/** Fingerprints an `exception`: `exception_class|frame_hash`. Mirrors `exception_fingerprint`. */
export function exceptionFingerprint(payload: ExceptionFingerprintInput): string {
  const exceptionClass = payload.exception_class ?? '';
  const frameHash = hashFrames(payload.stacktrace ?? []);
  return `${exceptionClass}|${frameHash}`;
}

/**
 * Computes the local grouping fingerprint for a `CodeskopEvent`, dispatched by
 * `type`. Total over the web SDK's four event types — mirrors
 * `compute_fingerprint`'s dispatch (minus the mobile-only `crash`/`anr` types,
 * which the web SDK never emits, `docs/03` §3.1).
 */
export function computeFingerprint(type: EventType, payload: EventPayload): string {
  switch (type) {
    case 'heartbeat':
      return HEARTBEAT_FINGERPRINT;
    case 'api_error':
    case 'api_timing':
      return apiFingerprint(payload as ApiFingerprintInput);
    case 'exception':
      return exceptionFingerprint(payload as ExceptionFingerprintInput);
    default:
      return '';
  }
}
