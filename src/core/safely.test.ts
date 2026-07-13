import { describe, expect, it, vi } from 'vitest';
import { safely } from './safely.js';

describe('safely (sync)', () => {
  it('returns the wrapped function’s value on success', () => {
    const wrapped = safely((a: number, b: number) => a + b);
    expect(wrapped(2, 3)).toBe(5);
  });

  it('swallows a thrown error and returns undefined', () => {
    const wrapped = safely(() => {
      throw new Error('boom');
    });
    expect(() => wrapped()).not.toThrow();
    expect(wrapped()).toBeUndefined();
  });

  it('reports the thrown error to onError with the configured context', () => {
    const onError = vi.fn();
    const err = new Error('boom');
    const wrapped = safely(
      () => {
        throw err;
      },
      { onError, context: 'onerror-hook' },
    );
    wrapped();
    expect(onError).toHaveBeenCalledWith(err, 'onerror-hook');
  });

  it('never propagates even when the onError handler itself throws', () => {
    const wrapped = safely(
      () => {
        throw new Error('boom');
      },
      {
        onError: () => {
          throw new Error('diagnostic handler is broken');
        },
      },
    );
    expect(() => wrapped()).not.toThrow();
  });

  it('defaults to a silent no-op diagnostic handler', () => {
    const wrapped = safely(() => {
      throw new Error('boom');
    });
    expect(() => wrapped()).not.toThrow();
  });
});

describe('safely (async)', () => {
  it('resolves with the wrapped function’s value on success', async () => {
    const wrapped = safely(async (a: number, b: number) => a * b);
    await expect(wrapped(3, 4)).resolves.toBe(12);
  });

  it('swallows a rejection and resolves to undefined instead of rejecting', async () => {
    const wrapped = safely(async () => {
      throw new Error('async boom');
    });
    await expect(wrapped()).resolves.toBeUndefined();
  });

  it('reports a rejection to onError', async () => {
    const onError = vi.fn();
    const err = new Error('async boom');
    const wrapped = safely(
      async () => {
        throw err;
      },
      { onError, context: 'transport-send' },
    );
    await wrapped();
    expect(onError).toHaveBeenCalledWith(err, 'transport-send');
  });

  it('never rejects even when the onError handler itself throws', async () => {
    const wrapped = safely(
      async () => {
        throw new Error('async boom');
      },
      {
        onError: () => {
          throw new Error('diagnostic handler is broken');
        },
      },
    );
    await expect(wrapped()).resolves.toBeUndefined();
  });

  it('passes through a function returning a plain (already-resolved) Promise value', async () => {
    const wrapped = safely(() => Promise.resolve('ok'));
    await expect(wrapped()).resolves.toBe('ok');
  });
});
