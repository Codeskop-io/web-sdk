/**
 * Privacy redaction (D3, `docs/03` §3.5, `docs/04` §4.4). Applied before anything
 * is queued — nothing downstream ever sees an unredacted header, query string, or
 * (by default) error message.
 */

/** Response headers ever allowed onto the wire. Everything else is dropped. */
export const HEADER_ALLOWLIST: readonly string[] = [
  'content-type',
  'content-length',
  'content-encoding',
  'accept',
  'cache-control',
];

/** Header names dropped outright, regardless of the allowlist (`CodeskopConfig.redactHeaders`). */
export const DEFAULT_REDACT_HEADER_NAMES: readonly string[] = ['authorization', 'cookie'];

/** Placeholder substituted for a redacted error message. */
export const REDACTED_MESSAGE_PLACEHOLDER = '[REDACTED]';

/**
 * Filters raw request/response headers down to the allowlist, dropping
 * `Authorization`/`Cookie` (and any other configured sensitive name) as a
 * backstop even if a caller's allowlist were ever loosened. Header names in the
 * result are lower-cased for a stable, order-independent shape.
 *
 * @param headers Raw headers, e.g. from a `Headers` object spread to a plain record.
 * @param redactHeaderNames Always-dropped names, case-insensitive. Defaults to
 *   `["authorization", "cookie"]` (`CodeskopConfig.redactHeaders`).
 */
export function redactHeaders(
  headers: Record<string, string> | null | undefined,
  redactHeaderNames: readonly string[] = DEFAULT_REDACT_HEADER_NAMES,
): Record<string, string> {
  if (!headers) return {};

  const blocked = new Set(redactHeaderNames.map((name) => name.toLowerCase()));
  const allowed = new Set(HEADER_ALLOWLIST);
  const result: Record<string, string> = {};

  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (blocked.has(lower)) continue;
    if (!allowed.has(lower)) continue;
    result[lower] = value;
  }

  return result;
}

/** The host + path split of a captured request URL, with the query dropped. */
export interface RedactedUrl {
  host: string;
  path: string;
}

/**
 * Reduces a captured request URL to `host` + `path`, dropping the query string
 * (and any fragment) entirely — never partially masked, since query strings are
 * high-entropy and routinely carry secrets (`docs/03` §3.5). This is the one
 * unconditional rule: the whole query string is always dropped, so there is no
 * key-by-key masking list that could be misconfigured or incomplete and leak a
 * secret through.
 *
 * Accepts absolute URLs (`https://host/path?query`) and bare paths
 * (`/path?query`); unparsable input degrades to an empty host rather than
 * throwing.
 */
export function redactUrl(rawUrl: string): RedactedUrl {
  try {
    // `URL#pathname` is always at least "/" per spec — no empty-string fallback needed.
    const parsed = new URL(rawUrl);
    return { host: parsed.host, path: parsed.pathname };
  } catch {
    // `String#split` always returns at least one element, so index 0 is never `undefined`.
    const withoutFragment = rawUrl.split('#')[0] as string;
    const path = withoutFragment.split('?')[0] as string;
    return { host: '', path: path || '/' };
  }
}

/** Options controlling error-message redaction. */
export interface RedactErrorMessageOptions {
  /** Send the message unredacted. Defaults to `false` — redact by default (`docs/03` §3.5). */
  raw?: boolean;
}

/**
 * Redacts an error/exception message, which routinely embeds user input or PII.
 * Redacted by default; pass `{ raw: true }` to opt in to sending it verbatim.
 */
export function redactErrorMessage(message: string, options: RedactErrorMessageOptions = {}): string {
  return options.raw ? message : REDACTED_MESSAGE_PLACEHOLDER;
}
