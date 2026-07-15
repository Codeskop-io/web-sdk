import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState, type ReactElement } from 'react';
import { recordException } from '@codeskop/tracker';
import { CodeskopErrorBoundary } from './CodeskopErrorBoundary.js';

vi.mock('@codeskop/tracker', async () => {
  const actual = await vi.importActual<typeof import('@codeskop/tracker')>('@codeskop/tracker');
  return { ...actual, recordException: vi.fn() };
});

/** Throws once (while `shouldThrow` is true) so a boundary reset can be exercised without an infinite crash loop. */
function Bomb({ shouldThrow }: { shouldThrow: boolean }): ReactElement {
  if (shouldThrow) throw new Error('boom');
  return <p>rendered fine</p>;
}

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // React logs caught render errors to `console.error` even when a boundary handles
  // them — expected noise for these tests, not a signal to assert on.
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  consoleErrorSpy.mockRestore();
  vi.mocked(recordException).mockClear();
});

describe('CodeskopErrorBoundary', () => {
  it('renders children when nothing throws', () => {
    render(
      <CodeskopErrorBoundary fallback={<p>fallback</p>}>
        <Bomb shouldThrow={false} />
      </CodeskopErrorBoundary>,
    );
    expect(screen.getByText('rendered fine')).toBeInTheDocument();
    expect(recordException).not.toHaveBeenCalled();
  });

  it('reports a render error via recordException(error, attributes) and renders the fallback node', () => {
    render(
      <CodeskopErrorBoundary fallback={<p>fallback ui</p>}>
        <Bomb shouldThrow={true} />
      </CodeskopErrorBoundary>,
    );

    expect(screen.getByText('fallback ui')).toBeInTheDocument();
    expect(screen.queryByText('rendered fine')).not.toBeInTheDocument();

    expect(recordException).toHaveBeenCalledTimes(1);
    const [error, attributes] = vi.mocked(recordException).mock.calls[0]!;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('boom');
    expect(attributes).toMatchObject({ source: 'react-error-boundary' });
  });

  it('calls the onError prop alongside recordException', () => {
    const onError = vi.fn();
    render(
      <CodeskopErrorBoundary fallback={<p>fallback</p>} onError={onError}>
        <Bomb shouldThrow={true} />
      </CodeskopErrorBoundary>,
    );
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(Error);
  });

  it('supports a function fallback that can reset the boundary back to children', () => {
    function Harness(): ReactElement {
      const [broken, setBroken] = useState(true);
      return (
        <CodeskopErrorBoundary
          fallback={(error, reset) => (
            <div>
              <p>caught: {error.message}</p>
              <button
                type="button"
                onClick={() => {
                  setBroken(false);
                  reset();
                }}
              >
                try again
              </button>
            </div>
          )}
        >
          <Bomb shouldThrow={broken} />
        </CodeskopErrorBoundary>
      );
    }

    render(<Harness />);
    expect(screen.getByText('caught: boom')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'try again' }));

    expect(screen.getByText('rendered fine')).toBeInTheDocument();
  });

  it('renders nothing when no fallback is provided', () => {
    const { container } = render(
      <CodeskopErrorBoundary>
        <Bomb shouldThrow={true} />
      </CodeskopErrorBoundary>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('normalizes a non-Error thrown value into an Error before reporting it', () => {
    function ThrowsAString(): ReactElement {
      throw 'stringy boom';
    }
    render(
      <CodeskopErrorBoundary fallback={<p>fallback</p>}>
        <ThrowsAString />
      </CodeskopErrorBoundary>,
    );
    const [error] = vi.mocked(recordException).mock.calls[0]!;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('stringy boom');
  });
});
