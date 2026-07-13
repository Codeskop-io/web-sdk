/**
 * Resolves `context.app.origin` for the envelope (D10, `docs/01` §1.5, `docs/03`
 * §3.3) — the web analog of Android's app-identity binding. This is a field in
 * the *wire envelope*, not a request header: browsers forbid a script from
 * setting the `Origin` header itself, so the actual `Origin` the backend
 * matches against the key's allowlist is whatever the browser sends
 * automatically. `context.app.origin` mirrors that value for the backend's
 * convenience/diagnostics.
 */

/**
 * Reads `window.location.origin` when a browser `window` is present; `undefined`
 * in any other host (SSR, Node, a test that has stubbed `window` away) rather
 * than guessing or throwing.
 */
export function resolveBrowserOrigin(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const location = window.location;
  if (!location || typeof location.origin !== 'string' || location.origin.length === 0) {
    return undefined;
  }
  return location.origin;
}
