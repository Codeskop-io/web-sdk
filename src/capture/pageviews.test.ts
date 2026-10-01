import { afterEach, describe, expect, it } from 'vitest';
import { PageViewCapture } from './pageviews.js';

let capture: PageViewCapture | undefined;

afterEach(() => {
  capture?.stop();
  capture = undefined;
  window.history.replaceState({}, '', '/');
});

describe('PageViewCapture', () => {
  it('sends the first page and each in-app navigation, path only', () => {
    window.history.replaceState({}, '', '/start?token=secret#x');
    const seen: string[] = [];
    capture = new PageViewCapture({ emit: (p) => seen.push(p) });
    capture.start();
    window.history.pushState({}, '', '/products/42?ref=email');
    window.history.replaceState({}, '', '/products/42?tab=reviews'); // same path: no new view
    window.history.pushState({}, '', '/cart');
    window.history.back();
    expect(seen.slice(0, 3)).toEqual(['/start', '/products/42', '/cart']);
  });

  it('restores history on stop', () => {
    const original = window.history.pushState;
    capture = new PageViewCapture({ emit: () => {} });
    capture.start();
    expect(window.history.pushState).not.toBe(original);
    capture.stop();
    expect(window.history.pushState).toBe(original);
  });
});
