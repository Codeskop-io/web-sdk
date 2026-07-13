/**
 * Uncaught-error & unhandled-rejection capture (D6, `docs/01` §1's decision
 * table, `docs/03` §3.1/§3.4, `web-sdk-workflow.md` Phase 7).
 *
 * `ErrorCapture` attaches exactly two `window` listeners:
 *  - `'error'`, in the **capturing** phase, so resource-load failures (an
 *    `<img>`/`<script>` that 404s) are seen too — those events don't bubble,
 *    so a bubbling-phase listener at `window` would never observe them.
 *  - `'unhandledrejection'`, for promises that reject with no `.catch`.
 *
 * Both are added via `addEventListener`, never by overwriting
 * `window.onerror` / `window.onunhandledrejection` — so whatever handler the
 * host page already installed (either form) keeps firing untouched. This
 * module never calls `preventDefault()`/`stopPropagation()` either, so it
 * never suppresses the browser's own default reporting (e.g. the console
 * warning for an unhandled rejection). That combination is the "chained,
 * never swallow" half of D6.
 *
 * Every listener body — and `recordException`, the handled-error entrypoint
 * — is wrapped in `safely()` (D4): a bug in *our* normalization logic must
 * become a dropped diagnostic, never a *second* uncaught error thrown back
 * into the page from inside a global error handler.
 */
import type { ExceptionPayload, StackFrame } from '../model/types.js';
import { safely } from '../core/safely.js';
import { redactErrorMessage, type RedactErrorMessageOptions } from '../core/redaction.js';
import { getActiveClient } from '../runtime/client.js';

/** The narrow slice of `Window` this module needs — trivial to fake in tests (mirrors `runtime/syncScheduler.ts`). */
type WindowLike = Pick<Window, 'addEventListener' | 'removeEventListener'>;

/** All `exception` events share this severity, handled or not (`docs/03` §3.1). */
const EXCEPTION_SEVERITY = 'high';

function resolveDefaultWindow(): WindowLike | undefined {
  return typeof window !== 'undefined' ? window : undefined;
}

/** Path only, guarded the same way as `core/context.ts`'s `collectPage` (never throws, never re-reads more than it must). */
function currentPage(): string {
  try {
    if (typeof window === 'undefined' || !window.location) return '';
    return window.location.pathname || '/';
  } catch {
    return '';
  }
}

/**
 * A V8-style frame: `"    at fn (file:line:col)"`, `"    at Class.method (file:line:col)"`,
 * `"    at new Class (file:line:col)"`, or bare `"    at file:line:col"`.
 */
const V8_FRAME = /^\s*at\s+(?:(.+?)\s+\()?(.*?):(\d+):(\d+)\)?\s*$/;

/** A Firefox/Safari-style frame: `"fn@file:line:col"` or bare `"@file:line:col"`. */
const GECKO_FRAME = /^(.*?)@(.*?):(\d+):(\d+)$/;

/** Splits a `"Class.method"`/`"new Class"`-style V8 call-site descriptor into `{ class, method }`. */
function splitCallSite(descriptor: string | undefined): { class?: string; method?: string } {
  if (!descriptor) return {};
  const withoutNew = descriptor.startsWith('new ') ? descriptor.slice(4) : descriptor;
  const lastDot = withoutNew.lastIndexOf('.');
  if (lastDot === -1) return { method: withoutNew };
  return { class: withoutNew.slice(0, lastDot), method: withoutNew.slice(lastDot + 1) };
}

/**
 * Normalizes an `Error#stack` string into `StackFrame[]` (`docs/03` §3.4).
 * Tolerant by design: a line that matches neither known format is skipped
 * rather than failing the whole parse, and a missing/empty stack yields `[]`.
 */
export function parseStack(stack: string | undefined): StackFrame[] {
  if (!stack) return [];

  const frames: StackFrame[] = [];
  for (const rawLine of stack.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    // A leading message line (e.g. "TypeError: boom", present in V8's `stack`) matches neither format
    // below and is skipped as a side effect, with no special-case needed.
    const v8Match = V8_FRAME.exec(line);
    if (v8Match) {
      const [, descriptor, file, lineNo, columnNo] = v8Match;
      frames.push({ ...splitCallSite(descriptor), file: file ?? '', line: Number(lineNo), column: Number(columnNo) });
      continue;
    }

    const geckoMatch = GECKO_FRAME.exec(line);
    if (geckoMatch) {
      const [, descriptor, file, lineNo, columnNo] = geckoMatch;
      frames.push({ ...splitCallSite(descriptor), file: file ?? '', line: Number(lineNo), column: Number(columnNo) });
    }
  }
  return frames;
}

/** Best-effort string for a rejection reason / thrown value that isn't an `Error` (a string, object, `undefined`, …). */
function describeNonError(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Normalizes any thrown/rejected value into the wire `ExceptionPayload` shape (`docs/03` §3.4). */
function toExceptionPayload(
  value: unknown,
  handled: boolean,
  redactOptions?: RedactErrorMessageOptions,
): ExceptionPayload {
  if (value instanceof Error) {
    return {
      exception_class: value.name || value.constructor?.name || 'Error',
      message: redactErrorMessage(value.message, redactOptions),
      stacktrace: parseStack(value.stack),
      handled,
      page: currentPage(),
    };
  }
  return {
    exception_class: 'NonErrorThrown',
    message: redactErrorMessage(describeNonError(value), redactOptions),
    stacktrace: [],
    handled,
    page: currentPage(),
  };
}

/** Payload for a resource-load failure (`<img>`/`<script>`/`<link>` `error` event with no `ErrorEvent.error`). */
function resourceErrorPayload(event: Event): ExceptionPayload {
  const target = event.target;
  const isElement = typeof Element !== 'undefined' && target instanceof Element;
  const tag = isElement ? target.tagName.toLowerCase() : 'resource';
  const src = isElement ? (target.getAttribute('src') ?? target.getAttribute('href') ?? undefined) : undefined;

  return {
    exception_class: 'ResourceError',
    message: redactErrorMessage(src ? `Failed to load ${tag}: ${src}` : `Failed to load ${tag}`),
    stacktrace: [],
    handled: false,
    page: currentPage(),
  };
}

/** Payload for a `window` `'error'` event that *is* a script error (`ErrorEvent`, not a resource-load failure). */
function scriptErrorPayload(event: ErrorEvent): ExceptionPayload {
  if (event.error !== undefined && event.error !== null) {
    return toExceptionPayload(event.error, false);
  }
  // No `Error` object attached — e.g. a cross-origin script's sanitized "Script error." — fall back to the
  // `ErrorEvent`'s own fields, which are still useful for locating the failure.
  const frame: StackFrame | undefined = event.filename
    ? { file: event.filename, line: event.lineno || 0, column: event.colno || 0 }
    : undefined;
  return {
    exception_class: 'Error',
    message: redactErrorMessage(event.message || 'Unknown error'),
    stacktrace: frame ? [frame] : [],
    handled: false,
    page: currentPage(),
  };
}

/** `true` for a genuine script error; `false` for a resource-load failure (both share the `'error'` event type). */
function isScriptErrorEvent(event: Event): event is ErrorEvent {
  return typeof ErrorEvent !== 'undefined' && event instanceof ErrorEvent;
}

/** Enqueues one `exception` event through the active client (`runtime/client.ts`'s seam); a safe no-op before `init()`. */
function emitExceptionEvent(payload: ExceptionPayload): void {
  getActiveClient()?.emitEvent({ type: 'exception', severity: EXCEPTION_SEVERITY, payload });
}

export interface ErrorCaptureOptions {
  /** Injectable `window`-like global for tests; defaults to the real `window` (`undefined` outside a browser). */
  win?: WindowLike;
}

/**
 * Installs/removes the `error` + `unhandledrejection` listeners. Mirrors the
 * `start()`/`stop()` shape of `runtime/syncScheduler.ts`'s `SyncScheduler` so
 * a later integration phase can own one instance alongside it; both methods
 * are idempotent and safe to call outside a browser (`win` is then
 * `undefined` and every call is a no-op).
 */
export class ErrorCapture {
  private readonly win: WindowLike | undefined;
  private started = false;

  private readonly handleError = safely(
    (event: Event): void => {
      const payload = isScriptErrorEvent(event) ? scriptErrorPayload(event) : resourceErrorPayload(event);
      emitExceptionEvent(payload);
    },
    { context: 'capture.errors.error' },
  );

  private readonly handleRejection = safely(
    (event: PromiseRejectionEvent): void => {
      emitExceptionEvent(toExceptionPayload(event.reason, false));
    },
    { context: 'capture.errors.unhandledrejection' },
  );

  constructor(options: ErrorCaptureOptions = {}) {
    this.win = options.win ?? resolveDefaultWindow();
  }

  /** Attaches both listeners. Idempotent — a second call is a no-op until `stop()`. */
  start(): void {
    if (this.started) return;
    this.started = true;
    // `capture: true` is required to see resource-load failures, which don't bubble (see the header comment).
    this.win?.addEventListener('error', this.handleError, true);
    this.win?.addEventListener('unhandledrejection', this.handleRejection);
  }

  /** Detaches both listeners. Idempotent; safe even if `start()` was never called. */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.win?.removeEventListener('error', this.handleError, true);
    this.win?.removeEventListener('unhandledrejection', this.handleRejection);
  }
}

/**
 * The handled-error path (`docs/05` §5.3's `recordException`): reports an
 * error the host app caught itself. Produces exactly one `exception` event
 * with `handled: true`. `attributes` is accepted for forward API-compat with
 * the documented public signature; the current wire `ExceptionPayload`
 * (`docs/03` §3.4) has no field for it yet, so it isn't placed on the wire
 * by this phase — a future contract change (not this file) would thread it
 * through. Never throws; wrapped in `safely()` per D4, same as every other
 * capture entrypoint in this module. A later integration phase re-exports
 * this from `facade.ts`'s public API.
 */
export const recordException = safely(
  (error: unknown, _attributes?: Record<string, unknown>): void => {
    emitExceptionEvent(toExceptionPayload(error, true));
  },
  { context: 'capture.errors.recordException' },
);
