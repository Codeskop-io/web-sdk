import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import * as tracker from '@codeskop-io/tracker';
import { CodeskopContext, defaultCodeskopContextValue } from './context.js';
import { useCodeskop } from './useCodeskop.js';

afterEach(cleanup);

function Consumer(): ReactElement {
  const { recordException, identify } = useCodeskop();
  return (
    <p>
      {typeof recordException === 'function' ? 'has-recordException' : 'missing'}-
      {typeof identify === 'function' ? 'has-identify' : 'missing'}
    </p>
  );
}

describe('useCodeskop', () => {
  it('exposes the real facade functions with no provider above it (safe no-op before init, per docs/05 §5.4)', () => {
    render(<Consumer />);
    expect(screen.getByText('has-recordException-has-identify')).toBeInTheDocument();
  });

  it('returns the exact same function references the vanilla core exports by default', () => {
    let captured: ReturnType<typeof useCodeskop> | undefined;
    function Capture(): null {
      captured = useCodeskop();
      return null;
    }
    render(<Capture />);
    expect(captured?.recordException).toBe(tracker.recordException);
    expect(captured?.identify).toBe(tracker.identify);
    expect(captured).toBe(defaultCodeskopContextValue);
  });

  it('reads whatever value a CodeskopContext.Provider supplies (e.g. a test double)', () => {
    const fakeValue = {
      ...defaultCodeskopContextValue,
      identify: () => {
        /* fake, for assertion identity only */
      },
    };

    function Consumer2(): ReactElement {
      const { identify } = useCodeskop();
      return <p>{identify === fakeValue.identify ? 'overridden' : 'default'}</p>;
    }

    render(
      <CodeskopContext.Provider value={fakeValue}>
        <Consumer2 />
      </CodeskopContext.Provider>,
    );
    expect(screen.getByText('overridden')).toBeInTheDocument();
  });
});
