import { describe, expect, it } from 'vitest';
import { NETWORK_ERROR_RESULT, parseRejected, resultForStatus } from './responseHandling.js';

describe('parseRejected', () => {
  it('returns undefined for an empty body', () => {
    expect(parseRejected('')).toBeUndefined();
  });

  it('extracts the rejected array from a well-formed body', () => {
    expect(parseRejected('{"rejected":["evt_1","evt_2"]}')).toEqual(['evt_1', 'evt_2']);
  });

  it('returns undefined when there is no rejected key', () => {
    expect(parseRejected('{}')).toBeUndefined();
  });

  it('returns undefined (never throws) for malformed JSON', () => {
    expect(parseRejected('not json')).toBeUndefined();
  });

  it('returns undefined when rejected is present but not a string array', () => {
    expect(parseRejected('{"rejected":[1,2,3]}')).toBeUndefined();
    expect(parseRejected('{"rejected":"evt_1"}')).toBeUndefined();
  });
});

describe('resultForStatus', () => {
  it('treats any 2xx as ok and non-retryable, with no rejects by default', () => {
    expect(resultForStatus(200, '')).toEqual({
      ok: true,
      status: 200,
      rejected: undefined,
      retryable: false,
    });
    expect(resultForStatus(201, '{}')).toEqual({
      ok: true,
      status: 201,
      rejected: undefined,
      retryable: false,
    });
  });

  it('carries a partial-reject list through on 2xx', () => {
    expect(resultForStatus(200, '{"rejected":["evt_1"]}')).toEqual({
      ok: true,
      status: 200,
      rejected: ['evt_1'],
      retryable: false,
    });
  });

  it('treats 4xx as permanent (not retryable)', () => {
    expect(resultForStatus(400, '')).toEqual({ ok: false, status: 400, retryable: false });
    expect(resultForStatus(401, '')).toEqual({ ok: false, status: 401, retryable: false });
    expect(resultForStatus(403, '')).toEqual({ ok: false, status: 403, retryable: false });
    expect(resultForStatus(413, '')).toEqual({ ok: false, status: 413, retryable: false });
  });

  it('treats 5xx as transient (retryable)', () => {
    expect(resultForStatus(500, '')).toEqual({ ok: false, status: 500, retryable: true });
    expect(resultForStatus(503, '')).toEqual({ ok: false, status: 503, retryable: true });
  });
});

describe('NETWORK_ERROR_RESULT', () => {
  it('is not ok and is retryable, with no status', () => {
    expect(NETWORK_ERROR_RESULT).toEqual({ ok: false, retryable: true });
  });
});
