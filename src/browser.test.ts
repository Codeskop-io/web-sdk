import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Host = { Codeskop?: Record<string, unknown> & { q?: unknown[] } };
const host = () => window as unknown as Host;

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  delete host().Codeskop;
  document.querySelectorAll('script').forEach((script) => script.remove());
});

describe('browser entry (window.Codeskop)', () => {
  it('publishes the API with the SDK version', async () => {
    await import('./browser.js');
    const { SDK_VERSION } = await import('./core/version.js');
    const g = host().Codeskop!;
    for (const name of ['init', 'identify', 'track', 'screen', 'recordException', 'reset', 'setEnabled', 'flush']) {
      expect(typeof g[name]).toBe('function');
    }
    expect(g.version).toBe(SDK_VERSION);
  });

  it('replays calls queued on the loader stub, in order, and skips unknown ones', async () => {
    const calls: string[] = [];
    vi.doMock('./index.js', async (orig) => {
      const real = (await orig()) as Record<string, unknown>;
      const spy = (name: string) => (...args: unknown[]) => calls.push(`${name}:${JSON.stringify(args)}`);
      return { ...real, identify: spy('identify'), track: spy('track') };
    });
    host().Codeskop = { q: [['identify', ['u-1']], ['nope', []], ['version', []], 'garbage', ['track', ['signup', { plan: 'pro' }]]] };
    await import('./browser.js');
    expect(calls).toEqual(['identify:["u-1"]', 'track:["signup",{"plan":"pro"}]']);
    expect(host().Codeskop!.q).toBeUndefined();
    vi.doUnmock('./index.js');
  });

  it('auto-inits from the script tag and identifies the server-rendered user', async () => {
    const script = document.createElement('script');
    script.setAttribute('data-codeskop-key', 'cs_test_pk_browser_entry');
    script.setAttribute('data-codeskop-user-id', 'srv-7');
    document.body.appendChild(script);
    await import('./browser.js');
    const { getActiveClient } = await import('./runtime/client.js');
    const client = getActiveClient() as unknown as { identity: { currentUserRef(): { id?: string } } } | undefined;
    expect(client).toBeDefined();
    expect(client!.identity.currentUserRef().id).toBe('srv-7');
  });
});
