// @vitest-environment node
/**
 * SSR safety (`web-sdk-workflow.md` Phase 12, `docs/05-api-reference.md` §5.5:
 * "the provider wires `init` on the client — SSR-safe, no `window` access on
 * the server"). This file runs under Vitest's **`node`** environment (no
 * jsdom), so `window`/`document` are genuinely absent — the same situation as
 * a real Next.js/Remix server render — rather than merely simulated inside a
 * browser-shaped test DOM. `renderToString` only ever executes the render
 * phase; if the provider or the boundary touched a browser global outside an
 * effect, this would throw a `ReferenceError` rather than a jsdom no-op.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { init } from '@codeskop/tracker';
import { CodeskopProvider } from './CodeskopProvider.js';
import { CodeskopErrorBoundary } from './CodeskopErrorBoundary.js';

vi.mock('@codeskop/tracker', async () => {
  const actual = await vi.importActual<typeof import('@codeskop/tracker')>('@codeskop/tracker');
  return { ...actual, init: vi.fn() };
});

afterEach(() => {
  vi.mocked(init).mockClear();
});

describe('SSR safety', () => {
  it('confirms this suite really has no window/document (otherwise the assertions below prove nothing)', () => {
    expect(typeof window).toBe('undefined');
    expect(typeof document).toBe('undefined');
  });

  it('renders CodeskopProvider + CodeskopErrorBoundary to a string with no window/document access', () => {
    let html = '';
    expect(() => {
      html = renderToString(
        <CodeskopProvider config={{ apiKey: 'cs_test_pk_ssr' }}>
          <CodeskopErrorBoundary fallback={<p>fallback</p>}>
            <p>hello from the server</p>
          </CodeskopErrorBoundary>
        </CodeskopProvider>,
      );
    }).not.toThrow();

    expect(html).toContain('hello from the server');
  });

  it('never calls init() during the render itself — only an effect would, and effects do not run in renderToString', () => {
    renderToString(
      <CodeskopProvider config={{ apiKey: 'cs_test_pk_ssr' }}>
        <p>server-rendered</p>
      </CodeskopProvider>,
    );
    expect(init).not.toHaveBeenCalled();
  });
});
