import { afterEach, describe, expect, it } from 'vitest';
import { readScriptConfig } from './scriptConfig.js';

function appendScript(attrs: Record<string, string>): HTMLScriptElement {
  const script = document.createElement('script');
  for (const [name, value] of Object.entries(attrs)) script.setAttribute(name, value);
  document.body.appendChild(script);
  return script;
}

afterEach(() => {
  document.querySelectorAll('script').forEach((script) => script.remove());
});

describe('readScriptConfig', () => {
  it('returns undefined when no script tag carries data-codeskop-key', () => {
    appendScript({ src: 'https://example.com/whatever.js' });
    expect(readScriptConfig()).toBeUndefined();
  });

  it('builds a config from data-codeskop-key alone', () => {
    appendScript({ 'data-codeskop-key': 'cs_live_pk_abc123' });
    expect(readScriptConfig()).toEqual({ apiKey: 'cs_live_pk_abc123' });
  });

  it('picks up the optional endpoint/release/environment overrides', () => {
    appendScript({
      'data-codeskop-key': 'cs_live_pk_abc123',
      'data-codeskop-endpoint': 'https://staging.api.codeskop.com',
      'data-codeskop-release': '3.4.1',
      'data-codeskop-environment': 'staging',
    });
    expect(readScriptConfig()).toEqual({
      apiKey: 'cs_live_pk_abc123',
      endpoint: 'https://staging.api.codeskop.com',
      release: '3.4.1',
      environment: 'staging',
    });
  });

  it('is undefined when the attribute is present but empty', () => {
    appendScript({ 'data-codeskop-key': '' });
    expect(readScriptConfig()).toBeUndefined();
  });

  it('finds the tag even when other unrelated script tags are present', () => {
    appendScript({ src: 'https://example.com/analytics.js' });
    appendScript({ 'data-codeskop-key': 'cs_live_pk_findme' });
    expect(readScriptConfig()).toEqual({ apiKey: 'cs_live_pk_findme' });
  });
});
