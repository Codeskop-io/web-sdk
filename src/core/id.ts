/**
 * `event_id` generation — UUIDv7 (RFC 9562 §5.7), hand-rolled with zero runtime
 * dependencies so the core stays dependency-free (`docs/01` §1.4).
 *
 * Layout (128 bits): a 48-bit big-endian Unix millisecond timestamp, a 4-bit
 * version nibble (`0111`), 12 bits of randomness (`rand_a`), a 2-bit variant
 * (`10`), and 62 more bits of randomness (`rand_b`). Sorting `event_id`s
 * therefore sorts by creation time, which is useful for local diagnostics even
 * though the server never trusts a client-supplied ordering.
 */
import type { Clock } from '../model/types.js';

/** The default `Clock`, backed by the real wall clock. Reused by other core modules. */
export const systemClock: Clock = {
  now: () => Date.now(),
};

/**
 * Fills `length` bytes with cryptographically-strong randomness where available
 * (Web Crypto's `getRandomValues`, present in both browsers and Node ≥ 18),
 * falling back to `Math.random` so id generation never throws in an
 * unusual host environment — uniqueness matters far more than
 * unpredictability here.
 */
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

function formatUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Generates a new UUIDv7 string, suitable as `CodeskopEvent.event_id` — the
 * client + server dedup key (`docs/03` §3.2).
 *
 * @param clock Injectable time source (`Clock`); defaults to the real clock.
 *   Tests pass a fixed clock to assert the timestamp-derived prefix.
 */
export function generateEventId(clock: Clock = systemClock): string {
  const timestampMs = clock.now();
  const rand = randomBytes(10); // 80 bits generated; 74 are used (12 + 62)

  const bytes = new Uint8Array(16);

  // 48-bit big-endian timestamp. Built via repeated division rather than
  // bitwise ops, which in JS coerce to 32 bits and would truncate values this
  // large.
  let remaining = timestampMs;
  for (let i = 5; i >= 0; i -= 1) {
    bytes[i] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }

  // Byte 6: version nibble (0111) high, top 4 bits of rand_a low.
  bytes[6] = 0x70 | ((rand[0] ?? 0) & 0x0f);
  bytes[7] = rand[1] ?? 0;

  // Byte 8: variant bits (10) high, top 6 bits of rand_b low.
  bytes[8] = 0x80 | ((rand[2] ?? 0) & 0x3f);
  bytes[9] = rand[3] ?? 0;
  bytes[10] = rand[4] ?? 0;
  bytes[11] = rand[5] ?? 0;
  bytes[12] = rand[6] ?? 0;
  bytes[13] = rand[7] ?? 0;
  bytes[14] = rand[8] ?? 0;
  bytes[15] = rand[9] ?? 0;

  return formatUuid(bytes);
}
