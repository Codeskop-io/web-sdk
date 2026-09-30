import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CodeskopConfig } from '../model/types.js';
import { collectContext } from './context.js';
import { SDK_VERSION } from './version.js';

const baseConfig: CodeskopConfig = { apiKey: 'cs_test_pk_context' };

describe('collectContext', () => {
  it('stamps install_id, platform, and sdk_version', () => {
    const { device, app } = collectContext(baseConfig, 'inst_abc');
    expect(device.install_id).toBe('inst_abc');
    expect(device.platform).toBe('web');
    expect(app.sdk_version).toBe(SDK_VERSION);
  });

  it('reads locale, screen, and viewport off the jsdom globals', () => {
    Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 720, configurable: true });
    Object.defineProperty(screen, 'width', { value: 1920, configurable: true });
    Object.defineProperty(screen, 'height', { value: 1080, configurable: true });

    const { device } = collectContext(baseConfig, 'inst_abc');

    expect(device.viewport).toBe('1280x720');
    expect(device.screen).toBe('1920x1080');
    expect(typeof device.locale).toBe('string');
  });

  it('threads config.release through to app.release', () => {
    const { app } = collectContext({ ...baseConfig, release: '3.4.1' }, 'inst_abc');
    expect(app.release).toBe('3.4.1');
    expect(app['version_name']).toBe('3.4.1');
  });

  it('reduces the page URL to a path only (query dropped)', () => {
    window.history.pushState({}, '', '/checkout?token=secret');
    const { app } = collectContext(baseConfig, 'inst_abc');
    expect(app.page).toBe('/checkout');
    window.history.pushState({}, '', '/');
  });

  describe('user agent — prefers UA-Client-Hints over navigator.userAgent', () => {
    afterEach(() => {
      Reflect.deleteProperty(navigator, 'userAgentData');
    });

    it('builds a compact brand/platform string when userAgentData is present', () => {
      Object.defineProperty(navigator, 'userAgentData', {
        value: { brands: [{ brand: 'Chromium', version: '128' }], platform: 'macOS', mobile: false },
        configurable: true,
      });
      const { device } = collectContext(baseConfig, 'inst_abc');
      expect(device.user_agent).toBe('Chromium 128; macOS');
    });

    it('falls back to navigator.userAgent when userAgentData is absent', () => {
      const { device } = collectContext(baseConfig, 'inst_abc');
      expect(device.user_agent).toBe(navigator.userAgent);
    });

    it('falls back to navigator.userAgent when userAgentData.brands is empty', () => {
      Object.defineProperty(navigator, 'userAgentData', {
        value: { brands: [] },
        configurable: true,
      });
      const { device } = collectContext(baseConfig, 'inst_abc');
      expect(device.user_agent).toBe(navigator.userAgent);
    });
  });

  describe('referrer redaction', () => {
    beforeEach(() => {
      Object.defineProperty(document, 'referrer', { value: '', configurable: true });
    });

    it('is undefined when there is no referrer', () => {
      const { app } = collectContext(baseConfig, 'inst_abc');
      expect(app.referrer).toBeUndefined();
    });

    it('keeps origin + pathname but drops the query string', () => {
      Object.defineProperty(document, 'referrer', {
        value: 'https://other.example.com/landing?utm_source=secret',
        configurable: true,
      });
      const { app } = collectContext(baseConfig, 'inst_abc');
      expect(app.referrer).toBe('https://other.example.com/landing');
    });

    it('degrades to undefined rather than throwing on an unparsable referrer', () => {
      Object.defineProperty(document, 'referrer', { value: 'not a url', configurable: true });
      const { app } = collectContext(baseConfig, 'inst_abc');
      expect(app.referrer).toBeUndefined();
    });
  });

  it('never throws even when window/navigator/screen access itself throws', () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(window, 'innerWidth');
    Object.defineProperty(window, 'innerWidth', {
      get() {
        throw new Error('locked down host');
      },
      configurable: true,
    });

    expect(() => collectContext(baseConfig, 'inst_abc')).not.toThrow();

    if (originalDescriptor) Object.defineProperty(window, 'innerWidth', originalDescriptor);
  });

  it('is a pure read — calling it twice never mutates shared state', () => {
    const first = collectContext(baseConfig, 'inst_abc');
    const second = collectContext(baseConfig, 'inst_abc');
    expect(first).toEqual(second);
  });
});
