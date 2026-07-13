/**
 * Auto-init support (`docs/06-integration-guide.md` §6.5, `web-sdk-workflow.md`
 * Phase 4): reads `data-codeskop-*` attributes off the SDK's own `<script>`
 * tag so a no-bundler CDN/`<script>` embed can configure the SDK without
 * writing any JS. `document.currentScript` identifies the tag while a
 * classic script is executing; module-script embeds (where the spec leaves
 * `currentScript` `null`) fall back to the first
 * `script[data-codeskop-key]` found in the document — there is normally only
 * one.
 */
import type { CodeskopConfig } from '../model/types.js';

const KEY_ATTR = 'data-codeskop-key';

interface ScriptAttributes {
  getAttribute(name: string): string | null;
}

function findScriptElement(): ScriptAttributes | undefined {
  if (typeof document === 'undefined') return undefined;
  try {
    const current = document.currentScript;
    if (current && current.hasAttribute(KEY_ATTR)) return current;
    return document.querySelector(`script[${KEY_ATTR}]`) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Builds a partial config from the SDK's own script tag's `data-codeskop-*`
 * attributes, or `undefined` if no such tag/attribute is present (the normal
 * case for a bundled/npm integration, where the host calls `init` itself).
 * `apiKey` is the only attribute required to attempt auto-init; the rest are
 * optional overrides of their `CodeskopConfig` default.
 */
export function readScriptConfig(): Partial<CodeskopConfig> | undefined {
  const script = findScriptElement();
  if (!script) return undefined;

  const apiKey = script.getAttribute(KEY_ATTR);
  if (!apiKey) return undefined;

  const config: Partial<CodeskopConfig> = { apiKey };

  const endpoint = script.getAttribute('data-codeskop-endpoint');
  if (endpoint) config.endpoint = endpoint;

  const release = script.getAttribute('data-codeskop-release');
  if (release) config.release = release;

  const environment = script.getAttribute('data-codeskop-environment');
  if (environment) config.environment = environment;

  return config;
}
