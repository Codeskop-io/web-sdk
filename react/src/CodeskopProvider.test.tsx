import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { useState, type ReactElement } from 'react';
import type { CodeskopConfig } from '@codeskop/tracker';
import { init } from '@codeskop/tracker';
import { CodeskopProvider } from './CodeskopProvider.js';

vi.mock('@codeskop/tracker', async () => {
  const actual = await vi.importActual<typeof import('@codeskop/tracker')>('@codeskop/tracker');
  return { ...actual, init: vi.fn() };
});

afterEach(() => {
  cleanup();
  vi.mocked(init).mockClear();
});

describe('CodeskopProvider', () => {
  it('renders its children', () => {
    render(
      <CodeskopProvider config={{ apiKey: 'cs_test_pk_provider' }}>
        <p>hello from inside the provider</p>
      </CodeskopProvider>,
    );
    expect(screen.getByText('hello from inside the provider')).toBeInTheDocument();
  });

  it('calls init(config) exactly once, on mount', () => {
    const config: CodeskopConfig = { apiKey: 'cs_test_pk_provider', endpoint: 'http://127.0.0.1:1' };
    render(
      <CodeskopProvider config={config}>
        <p>child</p>
      </CodeskopProvider>,
    );
    expect(init).toHaveBeenCalledTimes(1);
    expect(init).toHaveBeenCalledWith(config);
  });

  it('does not re-run init() when a re-render passes a new config object of the same shape', () => {
    // The common case: a caller writes `<CodeskopProvider config={{ apiKey }}>`, so
    // `config` is a fresh object identity on every parent re-render. `init()` should
    // still only ever run once, from the first mount (see CodeskopProvider.tsx's header).
    function Harness(): ReactElement {
      const [, setTick] = useState(0);
      return (
        <CodeskopProvider config={{ apiKey: 'cs_test_pk_provider' }}>
          <button type="button" onClick={() => setTick((t) => t + 1)}>
            rerender
          </button>
        </CodeskopProvider>
      );
    }

    render(<Harness />);
    expect(init).toHaveBeenCalledTimes(1);

    screen.getByRole('button').click();
    expect(init).toHaveBeenCalledTimes(1);
  });
});
