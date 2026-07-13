import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REDACTED_MESSAGE_PLACEHOLDER } from '../core/redaction.js';
import type { EmitEventInput } from '../runtime/client.js';
import type { ExceptionPayload } from '../model/types.js';

const emitEvent = vi.fn();
const getActiveClient = vi.fn<() => { emitEvent: typeof emitEvent } | undefined>(() => ({ emitEvent }));

vi.mock('../runtime/client.js', () => ({
  getActiveClient: () => getActiveClient(),
}));

const { ErrorCapture, parseStack, recordException } = await import('./errors.js');

function exceptionPayloadOf(call: unknown[]): ExceptionPayload {
  const input = call[0] as EmitEventInput;
  return input.payload as ExceptionPayload;
}

describe('capture/errors', () => {
  let capture: InstanceType<typeof ErrorCapture>;

  beforeEach(() => {
    emitEvent.mockClear();
    getActiveClient.mockReset();
    getActiveClient.mockImplementation(() => ({ emitEvent }));
    capture = new ErrorCapture();
    capture.start();
  });

  afterEach(() => {
    capture.stop();
    window.onerror = null;
    window.onunhandledrejection = null;
  });

  describe('window error event', () => {
    it('produces exactly one exception event for a thrown Error, with the message redacted by default', () => {
      const error = new Error('sensitive detail');
      window.dispatchEvent(
        new ErrorEvent('error', { message: error.message, error, filename: 'app.js', lineno: 10, colno: 4 }),
      );

      expect(emitEvent).toHaveBeenCalledTimes(1);
      const input = emitEvent.mock.calls[0]?.[0] as EmitEventInput;
      expect(input.type).toBe('exception');
      expect(input.severity).toBe('high');

      const payload = exceptionPayloadOf(emitEvent.mock.calls[0] ?? []);
      expect(payload.exception_class).toBe('Error');
      expect(payload.message).toBe(REDACTED_MESSAGE_PLACEHOLDER);
      expect(payload.handled).toBe(false);
      expect(typeof payload.page).toBe('string');
    });

    it('falls back to the ErrorEvent fields when there is no attached Error (cross-origin "Script error.")', () => {
      window.dispatchEvent(new ErrorEvent('error', { message: 'Script error.', filename: 'https://cdn.example/a.js', lineno: 3, colno: 1 }));

      expect(emitEvent).toHaveBeenCalledTimes(1);
      const payload = exceptionPayloadOf(emitEvent.mock.calls[0] ?? []);
      expect(payload.exception_class).toBe('Error');
      expect(payload.handled).toBe(false);
      expect(payload.stacktrace).toEqual([{ file: 'https://cdn.example/a.js', line: 3, column: 1 }]);
    });

    it('falls back to an empty stacktrace when the ErrorEvent has neither an Error nor a filename', () => {
      window.dispatchEvent(new ErrorEvent('error', { message: '' }));

      expect(emitEvent).toHaveBeenCalledTimes(1);
      const payload = exceptionPayloadOf(emitEvent.mock.calls[0] ?? []);
      expect(payload.stacktrace).toEqual([]);
      expect(payload.message).toBe(REDACTED_MESSAGE_PLACEHOLDER); // falls back to "Unknown error" before redaction
    });

    it('captures a resource-load failure (no ErrorEvent, target is the failing element), message redacted by default', () => {
      const img = document.createElement('img');
      img.setAttribute('src', 'https://example.com/missing.png');
      document.body.appendChild(img);

      img.dispatchEvent(new Event('error'));

      expect(emitEvent).toHaveBeenCalledTimes(1);
      const payload = exceptionPayloadOf(emitEvent.mock.calls[0] ?? []);
      expect(payload.exception_class).toBe('ResourceError');
      expect(payload.message).toBe(REDACTED_MESSAGE_PLACEHOLDER);
      expect(payload.handled).toBe(false);

      document.body.removeChild(img);
    });

    it('captures a resource-load failure with no src/href attribute to report', () => {
      const el = document.createElement('script');
      document.body.appendChild(el);

      el.dispatchEvent(new Event('error'));

      expect(emitEvent).toHaveBeenCalledTimes(1);
      const payload = exceptionPayloadOf(emitEvent.mock.calls[0] ?? []);
      expect(payload.exception_class).toBe('ResourceError');

      document.body.removeChild(el);
    });

    it('falls back to a generic "resource" label when the error event target is not an Element', () => {
      // A plain (non-`ErrorEvent`) `'error'` event dispatched directly on `window` has `target === window`.
      window.dispatchEvent(new Event('error'));

      expect(emitEvent).toHaveBeenCalledTimes(1);
      const payload = exceptionPayloadOf(emitEvent.mock.calls[0] ?? []);
      expect(payload.exception_class).toBe('ResourceError');
    });

    it('never assigns window.onerror — only addEventListener — so a pre-existing property handler is left untouched', () => {
      const hostOnError = vi.fn();
      window.onerror = hostOnError;

      // `start()` already ran in `beforeEach`; re-asserting here documents the guarantee this test is about.
      expect(window.onerror).toBe(hostOnError);
      capture.stop();
      capture.start();
      expect(window.onerror).toBe(hostOnError);

      window.onerror = null;
    });

    it('chains: a pre-existing addEventListener error listener still fires alongside our capture', () => {
      const hostListener = vi.fn();
      window.addEventListener('error', hostListener);

      window.dispatchEvent(new ErrorEvent('error', { message: 'boom', error: new Error('boom') }));

      expect(hostListener).toHaveBeenCalledTimes(1);
      expect(emitEvent).toHaveBeenCalledTimes(1);

      window.removeEventListener('error', hostListener);
    });

    it('never lets a bug inside its own handler propagate into the page', () => {
      getActiveClient.mockImplementation(() => {
        throw new Error('internal bug');
      });

      expect(() =>
        window.dispatchEvent(new ErrorEvent('error', { message: 'boom', error: new Error('boom') })),
      ).not.toThrow();
      expect(emitEvent).not.toHaveBeenCalled();
    });
  });

  describe('unhandledrejection', () => {
    it('produces exactly one exception event for a rejected Error', () => {
      const reason = new Error('rejected');
      const promise = Promise.reject(reason);
      promise.catch(() => {});
      window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection', { promise, reason }));

      expect(emitEvent).toHaveBeenCalledTimes(1);
      const payload = exceptionPayloadOf(emitEvent.mock.calls[0] ?? []);
      expect(payload.exception_class).toBe('Error');
      expect(payload.handled).toBe(false);
    });

    it('normalizes a non-Error rejection reason (e.g. a rejected string)', () => {
      const promise = Promise.reject('plain string reason');
      promise.catch(() => {});
      window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection', { promise, reason: 'plain string reason' }));

      expect(emitEvent).toHaveBeenCalledTimes(1);
      const payload = exceptionPayloadOf(emitEvent.mock.calls[0] ?? []);
      expect(payload.exception_class).toBe('NonErrorThrown');
      expect(payload.message).toBe(REDACTED_MESSAGE_PLACEHOLDER);
    });

    it('never assigns window.onunhandledrejection — only addEventListener — so a pre-existing property handler is left untouched', () => {
      const hostHandler = vi.fn();
      window.onunhandledrejection = hostHandler;

      expect(window.onunhandledrejection).toBe(hostHandler);
      capture.stop();
      capture.start();
      expect(window.onunhandledrejection).toBe(hostHandler);

      window.onunhandledrejection = null;
    });

    it('chains: a pre-existing addEventListener unhandledrejection listener still fires alongside our capture', () => {
      const hostListener = vi.fn();
      window.addEventListener('unhandledrejection', hostListener);

      const promise = Promise.reject(new Error('boom'));
      promise.catch(() => {});
      window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection', { promise, reason: new Error('boom') }));

      expect(hostListener).toHaveBeenCalledTimes(1);
      expect(emitEvent).toHaveBeenCalledTimes(1);

      window.removeEventListener('unhandledrejection', hostListener);
    });

    it('never lets a bug inside its own handler propagate into the page', () => {
      getActiveClient.mockImplementation(() => {
        throw new Error('internal bug');
      });

      const promise = Promise.reject(new Error('boom'));
      promise.catch(() => {});
      expect(() =>
        window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection', { promise, reason: new Error('boom') })),
      ).not.toThrow();
      expect(emitEvent).not.toHaveBeenCalled();
    });

    it.each([
      ['undefined', undefined],
      ['null', null],
    ])('normalizes a %s rejection reason without throwing', (_label, reason) => {
      const promise = Promise.reject(reason);
      promise.catch(() => {});
      window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection', { promise, reason }));

      expect(emitEvent).toHaveBeenCalledTimes(1);
      const payload = exceptionPayloadOf(emitEvent.mock.calls[0] ?? []);
      expect(payload.exception_class).toBe('NonErrorThrown');
      expect(payload.message).toBe(REDACTED_MESSAGE_PLACEHOLDER);
    });

    it('normalizes a rejection reason that cannot be JSON.stringified (circular object) without throwing', () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      const promise = Promise.reject(circular);
      promise.catch(() => {});

      expect(() =>
        window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection', { promise, reason: circular })),
      ).not.toThrow();
      expect(emitEvent).toHaveBeenCalledTimes(1);
      const payload = exceptionPayloadOf(emitEvent.mock.calls[0] ?? []);
      expect(payload.exception_class).toBe('NonErrorThrown');
    });
  });

  describe('start/stop', () => {
    it('is idempotent and safe with no window (e.g. SSR)', () => {
      const ssrCapture = new ErrorCapture({ win: undefined });
      expect(() => {
        ssrCapture.start();
        ssrCapture.start();
        ssrCapture.stop();
        ssrCapture.stop();
      }).not.toThrow();
    });

    it('stop() detaches listeners so a later event produces no event', () => {
      // A harmless bystander listener, unrelated to `capture` — keeps this environment's default
      // "nothing handled this" reporting from kicking in so the assertion below is what's under test.
      const bystander = vi.fn();
      window.addEventListener('error', bystander);

      capture.stop();
      window.dispatchEvent(new ErrorEvent('error', { message: 'boom', error: new Error('boom') }));
      expect(emitEvent).not.toHaveBeenCalled();

      window.removeEventListener('error', bystander);
    });
  });

  describe('recordException', () => {
    it('produces exactly one handled exception event', () => {
      recordException(new Error('caught it'), { userAction: 'checkout' });

      expect(emitEvent).toHaveBeenCalledTimes(1);
      const input = emitEvent.mock.calls[0]?.[0] as EmitEventInput;
      expect(input.type).toBe('exception');
      const payload = exceptionPayloadOf(emitEvent.mock.calls[0] ?? []);
      expect(payload.handled).toBe(true);
      expect(payload.exception_class).toBe('Error');
    });

    it('is a safe no-op before init (no active client)', () => {
      getActiveClient.mockImplementation(() => undefined);
      expect(() => recordException(new Error('caught it'))).not.toThrow();
      expect(emitEvent).not.toHaveBeenCalled();
    });

    it('never throws even if the active client is broken', () => {
      getActiveClient.mockImplementation(() => {
        throw new Error('internal bug');
      });
      expect(() => recordException(new Error('caught it'))).not.toThrow();
    });
  });

  describe('parseStack', () => {
    it('returns [] for undefined/empty input', () => {
      expect(parseStack(undefined)).toEqual([]);
      expect(parseStack('')).toEqual([]);
    });

    it('parses V8-style frames (named, class.method, and bare)', () => {
      const stack = [
        'Error: boom',
        '    at foo (http://localhost/app.js:10:15)',
        '    at HTMLButtonElement.onclick (http://localhost/app.js:20:5)',
        '    at http://localhost/app.js:30:3',
      ].join('\n');

      expect(parseStack(stack)).toEqual([
        { method: 'foo', file: 'http://localhost/app.js', line: 10, column: 15 },
        { class: 'HTMLButtonElement', method: 'onclick', file: 'http://localhost/app.js', line: 20, column: 5 },
        { file: 'http://localhost/app.js', line: 30, column: 3 },
      ]);
    });

    it('parses Gecko/WebKit-style frames (named and anonymous)', () => {
      const stack = ['foo@http://localhost/app.js:10:15', '@http://localhost/app.js:20:5'].join('\n');

      expect(parseStack(stack)).toEqual([
        { method: 'foo', file: 'http://localhost/app.js', line: 10, column: 15 },
        { file: 'http://localhost/app.js', line: 20, column: 5 },
      ]);
    });

    it('skips lines that match neither known format instead of failing the whole parse', () => {
      const stack = ['Error: boom', '    at foo (http://localhost/app.js:10:15)', 'garbage line'].join('\n');

      expect(parseStack(stack)).toEqual([{ method: 'foo', file: 'http://localhost/app.js', line: 10, column: 15 }]);
    });

    it('strips a "new " constructor-call prefix from a V8 call-site descriptor', () => {
      const stack = '    at new Widget (http://localhost/app.js:5:6)';
      expect(parseStack(stack)).toEqual([{ method: 'Widget', file: 'http://localhost/app.js', line: 5, column: 6 }]);
    });
  });
});
