import { useState, type ReactElement } from 'react';
import { CodeskopErrorBoundary, CodeskopProvider, useCodeskop } from '@codeskop-io/tracker-react';

/**
 * Same-origin by design (`vite.config.ts`'s proxy) — see this folder's
 * README for how to point this at a real staging/production key instead.
 */
const CODESKOP_CONFIG = {
  apiKey: 'cs_test_pk_react_example',
  endpoint: window.location.origin,
};

/** Throws during render on demand — exercises `CodeskopErrorBoundary`. */
function Crasher({ armed }: { armed: boolean }): ReactElement {
  if (armed) throw new Error('example: deliberate render crash');
  return <p>Nothing has crashed. Click the button above to throw.</p>;
}

function Fallback({ error, onReset }: { error: Error; onReset: () => void }): ReactElement {
  return (
    <div className="panel panel--error">
      <p>
        Caught by <code>CodeskopErrorBoundary</code>: {error.message}
      </p>
      <p>This was reported via <code>recordException</code> — check the debug panel below.</p>
      <button type="button" onClick={onReset}>
        Reset
      </button>
    </div>
  );
}

function Demo(): ReactElement {
  const { recordException, identify, flush } = useCodeskop();
  const [armed, setArmed] = useState(false);
  const [debugState, setDebugState] = useState<string>('(not fetched yet)');
  const [flushResult, setFlushResult] = useState<string>('(not flushed yet)');

  return (
    <main>
      <h1>@codeskop-io/tracker-react example</h1>

      <section className="panel">
        <h2>Handled exception</h2>
        <button
          type="button"
          onClick={() => recordException(new Error('example: handled error'), { source: 'demo-button' })}
        >
          recordException()
        </button>
      </section>

      <section className="panel">
        <h2>Network capture</h2>
        <button
          type="button"
          onClick={() => {
            // Deliberately a *different* host than `CODESKOP_CONFIG.endpoint`
            // (this page's own origin): `capture/network.ts`'s self-ingest
            // exclusion is host-based (never instrument calls to the
            // configured ingest endpoint's host, to avoid a feedback loop),
            // and this page's endpoint happens to *be* its own origin (the
            // dev-proxy trick — see this folder's README). A same-origin
            // `fetch('/does-not-exist')` would silently be excluded for that
            // reason, not instrumented — this targets a connection-refused
            // port on a different host instead, so the network failure is
            // observed as an `api_error` (`error_kind: "network_error"`).
            void fetch('http://127.0.0.1:1/does-not-exist').catch(() => {
              /* the SDK observes this regardless of how the app itself handles it */
            });
          }}
        >
          Trigger a failing fetch()
        </button>
      </section>

      <section className="panel">
        <h2>Identity</h2>
        <button type="button" onClick={() => identify('demo-user-42', { plan: 'trial' })}>
          identify('demo-user-42')
        </button>
      </section>

      <section className="panel">
        <h2>Render crash → CodeskopErrorBoundary</h2>
        <button type="button" onClick={() => setArmed(true)}>
          Crash the boundary below
        </button>
        <CodeskopErrorBoundary fallback={(error, reset) => <Fallback error={error} onReset={() => { setArmed(false); reset(); }} />}>
          <Crasher armed={armed} />
        </CodeskopErrorBoundary>
      </section>

      <section className="panel">
        <h2>Flush</h2>
        <button
          type="button"
          onClick={() => {
            void flush().then((ran) => setFlushResult(ran ? 'flush() ran a sync' : 'flush() was a no-op'));
          }}
        >
          flush()
        </button>
        <p>{flushResult}</p>
      </section>

      <section className="panel">
        <h2>Mock debug state</h2>
        <button
          type="button"
          onClick={() => {
            void fetch('/__debug/received')
              .then((r) => r.json())
              .then((body) => setDebugState(JSON.stringify(body, null, 2)))
              .catch((error: unknown) => setDebugState(`fetch failed: ${String(error)}`));
          }}
        >
          Refresh mock debug state
        </button>
        <pre>{debugState}</pre>
      </section>
    </main>
  );
}

export function App(): ReactElement {
  return (
    <CodeskopProvider config={CODESKOP_CONFIG}>
      <Demo />
    </CodeskopProvider>
  );
}
