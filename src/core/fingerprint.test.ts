import { describe, expect, it } from 'vitest';
import type { ApiErrorPayload, ExceptionPayload, StackFrame } from '../model/types.js';
import {
  HEARTBEAT_FINGERPRINT,
  apiFingerprint,
  computeFingerprint,
  exceptionFingerprint,
  normalizePath,
  sha256Hex,
} from './fingerprint.js';

describe('sha256Hex', () => {
  // Known FIPS 180-4 test vectors — independent of any implementation detail.
  it('matches the known digest of the empty string', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('matches the known digest of "abc"', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('matches the known digest of a 56-byte string (crosses the single-block padding boundary)', () => {
    const input = 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq';
    expect(sha256Hex(input)).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  it('is deterministic', () => {
    expect(sha256Hex('same input')).toBe(sha256Hex('same input'));
  });
});

describe('normalizePath', () => {
  it('templates numeric segments', () => {
    expect(normalizePath('/users/42')).toBe('/users/{id}');
  });

  it('templates UUID segments', () => {
    expect(normalizePath('/orders/550e8400-e29b-41d4-a716-446655440000')).toBe('/orders/{id}');
  });

  it('templates long hex-token segments', () => {
    expect(normalizePath('/sessions/deadbeefdeadbeef1234')).toBe('/sessions/{id}');
  });

  it('drops the query string and fragment', () => {
    expect(normalizePath('/checkout?token=abc#step')).toBe('/checkout');
  });

  it('leaves route names untouched', () => {
    expect(normalizePath('/users/42/orders')).toBe('/users/{id}/orders');
  });

  it('defaults an empty path to "/"', () => {
    expect(normalizePath('')).toBe('/');
  });
});

describe('apiFingerprint', () => {
  it('groups by uppercased method + normalized path + status', () => {
    expect(apiFingerprint({ method: 'get', path: '/users/1', status: 503 })).toBe(
      apiFingerprint({ method: 'GET', path: '/users/2', status: 503 }),
    );
  });

  it('splits groups on a different status', () => {
    const a = apiFingerprint({ method: 'GET', path: '/users/1', status: 503 });
    const b = apiFingerprint({ method: 'GET', path: '/users/1', status: 500 });
    expect(a).not.toBe(b);
  });

  it('degrades gracefully for a missing status', () => {
    expect(() => apiFingerprint({ method: 'GET', path: '/users/1' } as ApiErrorPayload)).not.toThrow();
  });
});

describe('exceptionFingerprint', () => {
  const frame = (cls: string, method: string): StackFrame => ({
    class: cls,
    method,
    file: 'app.js',
    line: 1,
    column: 1,
  });

  it('groups identical class + top frames together', () => {
    const a = exceptionFingerprint({
      exception_class: 'TypeError',
      stacktrace: [frame('App', 'render'), frame('App', 'mount')],
    });
    const b = exceptionFingerprint({
      exception_class: 'TypeError',
      stacktrace: [frame('App', 'render'), frame('App', 'mount')],
    });
    expect(a).toBe(b);
  });

  it('splits groups when the top frame differs', () => {
    const a = exceptionFingerprint({
      exception_class: 'TypeError',
      stacktrace: [frame('App', 'render')],
    });
    const b = exceptionFingerprint({
      exception_class: 'TypeError',
      stacktrace: [frame('App', 'submit')],
    });
    expect(a).not.toBe(b);
  });

  it('filters SDK-noise frames when at least one app frame is present', () => {
    const withNoise = exceptionFingerprint({
      exception_class: 'TypeError',
      stacktrace: [frame('com.codeskop.sdk.Capture', 'hook'), frame('App', 'render')],
    });
    const appOnly = exceptionFingerprint({
      exception_class: 'TypeError',
      stacktrace: [frame('App', 'render')],
    });
    expect(withNoise).toBe(appOnly);
  });

  it('falls back to unfiltered frames when every frame is noise', () => {
    const allNoise: ExceptionPayload['stacktrace'] = [frame('com.codeskop.sdk.Capture', 'hook')];
    expect(() => exceptionFingerprint({ exception_class: 'TypeError', stacktrace: allNoise })).not.toThrow();
  });

  it('only hashes the top TOP_FRAMES frames (deeper frames do not affect the group)', () => {
    const shallow = [frame('App', 'a'), frame('App', 'b'), frame('App', 'c'), frame('App', 'd'), frame('App', 'e')];
    const deep = [...shallow, frame('App', 'deep-noise')];
    const a = exceptionFingerprint({ exception_class: 'TypeError', stacktrace: shallow });
    const b = exceptionFingerprint({ exception_class: 'TypeError', stacktrace: deep });
    expect(a).toBe(b);
  });

  it('handles an empty stacktrace without throwing', () => {
    expect(() => exceptionFingerprint({ exception_class: 'TypeError', stacktrace: [] })).not.toThrow();
  });
});

describe('computeFingerprint', () => {
  it('gives heartbeats the constant non-grouping fingerprint', () => {
    expect(computeFingerprint('heartbeat', { session_id: 's1', visible: true })).toBe(HEARTBEAT_FINGERPRINT);
  });

  it('dispatches api_error and api_timing to the same recipe', () => {
    const errorPayload: ApiErrorPayload = {
      method: 'GET',
      host: 'api.customer.com',
      path: '/users/1',
      status: 500,
      duration_ms: 10,
      error_kind: 'http_5xx',
    };
    const timingPayload = { ...errorPayload, error_kind: undefined } as unknown as ApiErrorPayload;
    delete (timingPayload as { error_kind?: string }).error_kind;

    expect(computeFingerprint('api_error', errorPayload)).toBe(computeFingerprint('api_timing', timingPayload));
  });

  it('dispatches exception payloads to the exception recipe', () => {
    const payload: ExceptionPayload = {
      exception_class: 'TypeError',
      message: 'redacted-by-default',
      stacktrace: [],
      handled: false,
      page: '/checkout',
    };
    expect(computeFingerprint('exception', payload)).toBe(exceptionFingerprint(payload));
  });

  it('degrades to an empty string for a type outside the web SDK taxonomy (e.g. a mobile-only type)', () => {
    const mobileOnlyType = 'crash' as unknown as Parameters<typeof computeFingerprint>[0];
    expect(computeFingerprint(mobileOnlyType, { session_id: 's1', visible: true })).toBe('');
  });
});
