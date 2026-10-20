import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clickProperties,
  CLICK_THROTTLE_MS,
  deepLink,
  lifecycleCapture,
  loadMs,
  whenLoaded,
} from './lifecycle.js';

function stubNavigation(entry: Partial<PerformanceNavigationTiming> | undefined): void {
  vi.spyOn(performance, 'getEntriesByType').mockReturnValue(
    entry ? [entry as PerformanceEntry] : [],
  );
}

function html(markup: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = markup;
  document.body.appendChild(host);
  return host;
}

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

function pageHide(persisted = false): void {
  const event = new Event('pagehide') as Event & { persisted: boolean };
  Object.defineProperty(event, 'persisted', { value: persisted });
  window.dispatchEvent(event);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = '';
  Reflect.deleteProperty(document, 'visibilityState');
});

describe('deepLink', () => {
  beforeEach(() => stubNavigation({ type: 'navigate' }));

  it('keeps only the path and utm_ parameters, with utm_source as the source', () => {
    expect(
      deepLink('https://shop.example/promo?utm_source=news&token=secret&utm_campaign=oct#frag', ''),
    ).toEqual({ url: '/promo?utm_source=news&utm_campaign=oct', source: 'news' });
  });

  it('uses the referrer host as the source for an external referrer without utm params', () => {
    expect(
      deepLink('https://shop.example/p/42?ref=abc', 'https://www.google.com/search?q=shoes'),
    ).toEqual({
      url: '/p/42',
      source: 'www.google.com',
    });
  });

  it('prefers utm_source over the referrer host', () => {
    expect(deepLink('https://shop.example/?utm_source=x', 'https://t.co/abc')).toEqual({
      url: '/?utm_source=x',
      source: 'x',
    });
  });

  it('is undefined for a same-origin referrer and no utm params, or no referrer at all', () => {
    expect(
      deepLink('https://shop.example/cart?step=2', 'https://shop.example/p/42'),
    ).toBeUndefined();
    expect(deepLink('https://shop.example/cart', '')).toBeUndefined();
  });

  it('keeps utm params without a source when there is no utm_source or referrer', () => {
    expect(deepLink('https://shop.example/?utm_campaign=oct', '')).toEqual({
      url: '/?utm_campaign=oct',
    });
  });

  it('ignores reloads and back/forward navigations', () => {
    stubNavigation({ type: 'reload' });
    expect(deepLink('https://shop.example/?utm_source=x', '')).toBeUndefined();
    stubNavigation({ type: 'back_forward' });
    expect(deepLink('https://shop.example/', 'https://t.co/')).toBeUndefined();
  });
});

describe('loadMs / whenLoaded', () => {
  it('reads loadEventEnd from navigation timing, once the load has finished', () => {
    stubNavigation({ loadEventEnd: 812.6 });
    expect(loadMs()).toBe(813);
    stubNavigation({ loadEventEnd: 0 });
    expect(loadMs()).toBeUndefined();
    stubNavigation(undefined);
    expect(loadMs()).toBeUndefined();
  });

  it('is undefined when performance throws', () => {
    vi.spyOn(performance, 'getEntriesByType').mockImplementation(() => {
      throw new Error('nope');
    });
    expect(loadMs()).toBeUndefined();
  });

  it('resolves straight away when the document is already complete', async () => {
    await expect(whenLoaded()).resolves.toBeUndefined();
  });

  it('waits for the load event, or resolves on pagehide or after 10 s', async () => {
    vi.useFakeTimers();
    const readyState = vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading');
    let done = false;
    void whenLoaded().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(100);
    expect(done).toBe(false);
    window.dispatchEvent(new Event('load'));
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);

    let hidden = false;
    void whenLoaded().then(() => (hidden = true));
    pageHide();
    await vi.advanceTimersByTimeAsync(0);
    expect(hidden).toBe(true);

    let timedOut = false;
    void whenLoaded().then(() => (timedOut = true));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(timedOut).toBe(true);
    readyState.mockRestore();
  });
});

describe('clickProperties', () => {
  it('uses the trimmed, collapsed visible text, cut to 64 characters', () => {
    const host = html(`<button id="pay">  Pay   now\n ${'x'.repeat(80)} </button>`);
    const props = clickProperties(host.querySelector('button')!);
    expect(props.element).toBe('button');
    expect(props.element_id).toBe('pay');
    expect(props.screen).toBe(location.pathname);
    expect(String(props.label)).toHaveLength(64);
    expect(String(props.label).startsWith('Pay now x')).toBe(true);
  });

  it('never reads an input value, falling back to aria-label', () => {
    const host = html(
      '<input type="submit" value="Pay KES 4,200"><input type="button" value="secret" aria-label="Open menu">',
    );
    const [submit, button] = Array.from(host.querySelectorAll('input'));
    expect(clickProperties(submit!)).toEqual({ element: 'button', screen: location.pathname });
    expect(clickProperties(button!)).toEqual({
      element: 'button',
      screen: location.pathname,
      label: 'Open menu',
    });
  });

  it('describes links, and uses aria-label for an icon-only element', () => {
    const host = html('<a href="/help">Help</a><a href="/x" aria-label=" Close "><svg></svg></a>');
    const [help, close] = Array.from(host.querySelectorAll('a'));
    expect(clickProperties(help!)).toMatchObject({ element: 'link', label: 'Help' });
    expect(clickProperties(close!)).toMatchObject({ element: 'link', label: 'Close' });
    expect(clickProperties(close!)).not.toHaveProperty('element_id');
  });
});

describe('lifecycleCapture', () => {
  function capture(click: ((p: Record<string, unknown>) => void) | undefined = vi.fn()) {
    const lifecycle = vi.fn();
    const close = vi.fn();
    const handle = lifecycleCapture({ lifecycle, close, click });
    handle.start();
    return { lifecycle, close, click, handle };
  }

  it('captures buttons, links, role=button and submit/button inputs, from a nested target', () => {
    vi.useFakeTimers();
    const { click, handle } = capture();
    const host = html(
      '<button><span id="inner">Save</span></button><a href="#">Link</a><div role="button">Role</div>' +
        '<input type="submit" value="Go"><input type="button" value="B"><input type="text" value="no"><div id="plain">Plain</div>',
    );
    const targets = [
      '#inner',
      'a',
      '[role=button]',
      'input[type=submit]',
      'input[type=button]',
      'input[type=text]',
      '#plain',
    ];
    for (const selector of targets) {
      host.querySelector<HTMLElement>(selector)!.click();
      vi.advanceTimersByTime(CLICK_THROTTLE_MS);
    }
    expect(click).toHaveBeenCalledTimes(5);
    expect(vi.mocked(click!).mock.calls.map(([p]) => p.label)).toEqual([
      'Save',
      'Link',
      'Role',
      undefined,
      undefined,
    ]);
    handle.stop();
  });

  it('skips elements inside [data-codeskop-ignore], on the element or an ancestor', () => {
    const { click, handle } = capture();
    const host = html(
      '<button data-codeskop-ignore>Self</button><section data-codeskop-ignore><a href="#">Inside</a></section>',
    );
    host.querySelector('button')!.click();
    host.querySelector('a')!.click();
    expect(click).not.toHaveBeenCalled();
    handle.stop();
  });

  it('throttles rapid clicks', () => {
    vi.useFakeTimers();
    const { click, handle } = capture();
    const button = html('<button>Tap</button>').querySelector('button')!;
    button.click();
    button.click();
    vi.advanceTimersByTime(CLICK_THROTTLE_MS);
    button.click();
    expect(click).toHaveBeenCalledTimes(2);
    handle.stop();
  });

  it('sends no clicks when click capture is off, and stops listening on stop()', () => {
    const { lifecycle, handle } = capture(undefined);
    const button = html('<button>Tap</button>').querySelector('button')!;
    expect(() => button.click()).not.toThrow();
    handle.stop();
    setVisibility('hidden');
    expect(lifecycle).not.toHaveBeenCalled();
  });

  it('reports backgrounded and foregrounded, with the time away', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { lifecycle, handle } = capture();
    setVisibility('hidden');
    setVisibility('hidden'); // a repeat is ignored
    vi.setSystemTime(Date.now() + 42_400);
    setVisibility('visible');
    setVisibility('visible');
    expect(lifecycle.mock.calls).toEqual([
      ['$app_backgrounded', { screen: location.pathname }],
      ['$app_foregrounded', { background_s: 42 }],
    ]);
    handle.stop();
  });

  it('closes on pagehide, but not from the back/forward cache or right after an in-site navigation', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { lifecycle, close, handle } = capture();
    pageHide(true);
    expect(close).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('pageshow'));

    html('<a href="/next">Next</a>').querySelector('a')!.click();
    pageHide();
    expect(close).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('pageshow'));

    vi.setSystemTime(Date.now() + 6000);
    pageHide();
    expect(close).toHaveBeenCalledTimes(1);
    // A closing page then going hidden is not "backgrounded".
    setVisibility('hidden');
    expect(lifecycle).not.toHaveBeenCalled();
    handle.stop();
  });

  it('treats a form submit as a navigation, but not an external or new-tab link', () => {
    const { close, handle } = capture();
    const host = html(
      '<a href="https://elsewhere.example/">Out</a><a href="/x" target="_blank">New tab</a>' +
        '<form><button type="button">Plain</button></form>',
    );
    host
      .querySelectorAll('a')
      .forEach((a) => a.addEventListener('click', (e) => e.preventDefault()));
    for (const el of Array.from(host.querySelectorAll<HTMLElement>('a, button'))) el.click();
    pageHide();
    expect(close).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('pageshow'));

    const form = html('<form><button>Send</button></form>').querySelector('form')!;
    form.addEventListener('submit', (e) => e.preventDefault());
    form.querySelector('button')!.click();
    pageHide();
    expect(close).toHaveBeenCalledTimes(1);
    handle.stop();
  });

  it('never throws out of a failing callback', () => {
    const handle = lifecycleCapture({
      lifecycle: () => {
        throw new Error('boom');
      },
      close: () => {
        throw new Error('boom');
      },
    });
    handle.start();
    handle.start(); // idempotent
    expect(() => setVisibility('hidden')).not.toThrow();
    expect(() => pageHide()).not.toThrow();
    handle.stop();
  });
});
