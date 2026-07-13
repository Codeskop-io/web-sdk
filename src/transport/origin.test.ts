import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveBrowserOrigin } from './origin.js';

describe('resolveBrowserOrigin', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns window.location.origin when a browser window is present (jsdom)', () => {
    expect(resolveBrowserOrigin()).toBe(window.location.origin);
    expect(resolveBrowserOrigin()).toBe('http://localhost:3000');
  });

  it('returns undefined when there is no window (SSR/Node)', () => {
    vi.stubGlobal('window', undefined);
    expect(resolveBrowserOrigin()).toBeUndefined();
  });

  it('returns undefined when window.location is missing', () => {
    vi.stubGlobal('window', {});
    expect(resolveBrowserOrigin()).toBeUndefined();
  });

  it('returns undefined when window.location.origin is not a usable string', () => {
    vi.stubGlobal('window', { location: { origin: '' } });
    expect(resolveBrowserOrigin()).toBeUndefined();

    vi.stubGlobal('window', { location: { origin: 42 } });
    expect(resolveBrowserOrigin()).toBeUndefined();
  });
});
