import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REDACT_HEADER_NAMES,
  DEFAULT_REDACT_QUERY_KEYS,
  HEADER_ALLOWLIST,
  REDACTED_MESSAGE_PLACEHOLDER,
  redactErrorMessage,
  redactHeaders,
  redactUrl,
} from './redaction.js';

describe('redactHeaders', () => {
  it('keeps only allowlisted headers', () => {
    const result = redactHeaders({
      'Content-Type': 'application/json',
      'X-Custom-Header': 'whatever',
    });
    expect(result).toEqual({ 'content-type': 'application/json' });
  });

  it('always drops Authorization and Cookie even if present alongside allowlisted headers', () => {
    const result = redactHeaders({
      Authorization: 'Bearer secret',
      Cookie: 'session=abc',
      Accept: 'application/json',
    });
    expect(result).toEqual({ accept: 'application/json' });
    expect(result['authorization']).toBeUndefined();
    expect(result['cookie']).toBeUndefined();
  });

  it('honours a custom redact list as an additional backstop', () => {
    const result = redactHeaders(
      { 'Cache-Control': 'no-store', 'X-Api-Key': 'shh' },
      ['x-api-key'],
    );
    expect(result).toEqual({ 'cache-control': 'no-store' });
  });

  it('returns an empty object for null/undefined input', () => {
    expect(redactHeaders(undefined)).toEqual({});
    expect(redactHeaders(null)).toEqual({});
  });

  it('exposes the frozen allowlist and default names', () => {
    expect(HEADER_ALLOWLIST).toContain('content-type');
    expect(DEFAULT_REDACT_HEADER_NAMES).toEqual(['authorization', 'cookie']);
    expect(DEFAULT_REDACT_QUERY_KEYS).toContain('token');
  });
});

describe('redactUrl', () => {
  it('drops the query string from an absolute URL, keeping host + path', () => {
    expect(redactUrl('https://api.customer.com/checkout?token=abc123')).toEqual({
      host: 'api.customer.com',
      path: '/checkout',
    });
  });

  it('drops the query string from a bare path', () => {
    expect(redactUrl('/users/42?password=hunter2')).toEqual({ host: '', path: '/users/42' });
  });

  it('drops a fragment too', () => {
    expect(redactUrl('/checkout#step-2')).toEqual({ host: '', path: '/checkout' });
  });

  it('defaults an empty path to "/"', () => {
    expect(redactUrl('https://api.customer.com')).toEqual({ host: 'api.customer.com', path: '/' });
    expect(redactUrl('')).toEqual({ host: '', path: '/' });
  });

  it('keeps a URL with no query unchanged in shape', () => {
    expect(redactUrl('https://api.customer.com/users/42')).toEqual({
      host: 'api.customer.com',
      path: '/users/42',
    });
  });
});

describe('redactErrorMessage', () => {
  it('redacts by default', () => {
    expect(redactErrorMessage('Cannot read property of user@example.com')).toBe(REDACTED_MESSAGE_PLACEHOLDER);
  });

  it('passes the raw message through when opted in', () => {
    expect(redactErrorMessage('boom', { raw: true })).toBe('boom');
  });
});
