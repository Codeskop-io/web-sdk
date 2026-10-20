/**
 * Lifecycle and click capture (events v2, `backend/docs/11` §11.3):
 *
 * - `$app_backgrounded` / `$app_foregrounded` from `visibilitychange`.
 * - The tab closing (`pagehide`), which ends the session (`end_reason: closed`).
 *   A `pagehide` that is really a navigation inside the site (a same-origin
 *   link or a form submit just before, or a page kept in the back/forward
 *   cache) keeps the session going instead.
 * - `$click`: one capture-phase `click` listener on the document, throttled.
 *   Only buttons, links, `[role=button]` and submit/button inputs count, and
 *   anything inside `[data-codeskop-ignore]` is skipped. The label is the
 *   visible text (never an input's value), or `aria-label`.
 *
 * Also the helpers the client uses once per page load: `$app_opened`'s
 * `load_ms` and `$deep_link_opened`'s `url`/`source`.
 */
import type { Properties } from '../model/types.js';
import { safely } from '../core/safely.js';
import { collectPage } from '../core/context.js';

/** Clicks closer together than this are dropped. */
export const CLICK_THROTTLE_MS = 300;
/** A same-origin link or form submit this recent means a `pagehide` is a navigation, not the tab closing. */
const NAVIGATION_WINDOW_MS = 5000;
const CLICKABLE = 'a,button,[role=button],input[type=submit],input[type=button]';

/** Once-per-page-load flags, shared by every client a page creates (a later `init()` must not resend them). */
export const pageLoad = { opened: false, screened: false };

export interface LifecycleCaptureOptions {
  /** Sends an SDK lifecycle event (`$app_backgrounded`, …). */
  lifecycle: (name: string, properties: Properties) => void;
  /** The tab is closing: end the session. */
  close: () => void;
  /** Sends a `$click`; omitted when click capture is turned off in code. */
  click?: (properties: Properties) => void;
}

function navigationEntry(): PerformanceNavigationTiming | undefined {
  try {
    return performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  } catch {
    return undefined;
  }
}

/** How long the page took to load, from navigation timing; `undefined` until the `load` event has finished. */
export function loadMs(): number | undefined {
  const end = navigationEntry()?.loadEventEnd;
  return end && end > 0 ? Math.round(end) : undefined;
}

/** Resolves once the page has loaded (so `loadMs()` is known), the page is hidden, or after 10 s. */
export function whenLoaded(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || document.readyState === 'complete') {
      setTimeout(resolve);
      return;
    }
    // `setTimeout` so `loadEventEnd` is set (it is filled in after the load handlers run).
    window.addEventListener('load', () => setTimeout(resolve), { once: true });
    window.addEventListener('pagehide', () => resolve(), { once: true });
    setTimeout(resolve, 10_000);
  });
}

/**
 * `$deep_link_opened`'s properties when this page load came from another site
 * or carries `utm_` parameters, else `undefined`. `url` is the path plus the
 * `utm_` parameters only; `source` is `utm_source`, else the referrer's host.
 * Reloads and back/forward don't count.
 */
export function deepLink(href: string, referrer: string): Properties | undefined {
  const type = navigationEntry()?.type;
  if (type === 'reload' || type === 'back_forward') return undefined;
  const url = new URL(href);
  const kept = new URLSearchParams();
  url.searchParams.forEach((value, key) => {
    if (key.startsWith('utm_')) kept.append(key, value);
  });
  const query = kept.toString();
  let source = url.searchParams.get('utm_source') || '';
  let external = false;
  if (referrer) {
    const from = new URL(referrer);
    external = from.origin !== url.origin;
    if (external && !source) source = from.host;
  }
  if (!external && !query) return undefined;
  const properties: Properties = { url: url.pathname + (query ? `?${query}` : '') };
  if (source) properties.source = source;
  return properties;
}

/** `$click`'s properties for a clickable element. Never reads an input's value. */
export function clickProperties(el: Element): Properties {
  const text = el.tagName === 'INPUT' ? '' : (el.textContent || '').replace(/\s+/g, ' ').trim();
  const label = text || el.getAttribute('aria-label')?.trim();
  const properties: Properties = {
    element: el.tagName === 'A' ? 'link' : 'button',
    screen: collectPage(),
  };
  if (label) properties.label = label.slice(0, 64);
  if (el.id) properties.element_id = el.id;
  return properties;
}

/**
 * Attaches the visibility, `pagehide`/`pageshow` and click listeners on
 * `start()` and removes them on `stop()`. Every handler is `safely()`-guarded.
 */
export function lifecycleCapture(options: LifecycleCaptureOptions): {
  start(): void;
  stop(): void;
} {
  let hiddenAt: number | undefined;
  let unloading = false;
  let navigatedAt = 0;
  let clickedAt = 0;
  let listeners: [EventTarget, string, (event: Event) => void, boolean?][] | undefined;

  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') {
      // A closing page fires `pagehide` first: that is not "backgrounded".
      if (unloading || hiddenAt !== undefined) return;
      hiddenAt = Date.now();
      options.lifecycle('$app_backgrounded', { screen: collectPage() });
    } else if (hiddenAt !== undefined) {
      const background_s = Math.round((Date.now() - hiddenAt) / 1000);
      hiddenAt = undefined;
      options.lifecycle('$app_foregrounded', { background_s });
    }
  };

  const onPageHide = (event: Event): void => {
    unloading = true;
    if (
      !(event as PageTransitionEvent).persisted &&
      Date.now() - navigatedAt >= NAVIGATION_WINDOW_MS
    )
      options.close();
  };

  const onClick = (event: Event): void => {
    const el = (event.target as Element | null)?.closest?.(CLICKABLE);
    if (!el) return;
    const now = Date.now();
    const link = el as HTMLAnchorElement;
    const button = el as HTMLButtonElement;
    if (
      el.tagName === 'A'
        ? link.origin === location.origin && (!link.target || link.target === '_self')
        : button.form && button.type === 'submit'
    ) {
      navigatedAt = now;
    }
    const click = options.click;
    if (!click || el.closest('[data-codeskop-ignore]') || now - clickedAt < CLICK_THROTTLE_MS)
      return;
    clickedAt = now;
    click(clickProperties(el));
  };

  return {
    start: safely((): void => {
      if (listeners || typeof window === 'undefined') return;
      listeners = [
        [document, 'visibilitychange', safely(onVisibility)],
        [document, 'click', safely(onClick), true],
        [window, 'pagehide', safely(onPageHide)],
        [window, 'pageshow', () => (unloading = false)],
      ];
      for (const [target, type, listener, capture] of listeners)
        target.addEventListener(type, listener, capture);
    }),
    stop: safely((): void => {
      for (const [target, type, listener, capture] of listeners ?? [])
        target.removeEventListener(type, listener, capture);
      listeners = undefined;
    }),
  };
}
