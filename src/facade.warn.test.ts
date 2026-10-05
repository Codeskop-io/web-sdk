import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('init with an unusable key', () => {
  it('warns once, with a signup link, for a missing or placeholder key', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { init } = await import('./facade.js');
    init({ apiKey: 'cs_live_pk_…' });
    init({ apiKey: '' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('https://dashboard.codeskop.com/signup?utm_source=sdk');
  });

  it('explains a secret key', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { init } = await import('./facade.js');
    init({ apiKey: 'cs_live_sk_abcdefghijklmnop' });
    expect(String(warn.mock.calls[0]?.[0])).toContain('secret key');
  });

  it('stays silent for a valid public key', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { init, setEnabled } = await import('./facade.js');
    init({ apiKey: 'cs_test_pk_validkey123' });
    setEnabled(false);
    expect(warn).not.toHaveBeenCalled();
  });
});
