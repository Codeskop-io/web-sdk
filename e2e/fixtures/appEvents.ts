/**
 * Shared by the browser harness (`entry.ts`) and the Node-side specs: tells
 * the app's own events apart from the ones the SDK sends by itself (events v2).
 */

/** An event the app caused, as opposed to an SDK `$` event or the trait-less `identify` that links the anonymous id. */
export function isAppEvent(event: { type: string; payload?: unknown }): boolean {
  const payload = (event.payload ?? {}) as { name?: unknown; traits?: Record<string, unknown> };
  if (String(payload.name ?? '').startsWith('$')) return false;
  return !(event.type === 'identify' && Object.keys(payload.traits ?? {}).length === 0);
}
