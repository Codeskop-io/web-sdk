# `@codeskop/tracker-react` example

A minimal Vite + React app exercising `CodeskopProvider`, `CodeskopErrorBoundary`,
and `useCodeskop()` end-to-end (`web-sdk-workflow.md` Phase 12).

## Against the mock ingest server (default)

```bash
# Terminal 1 — from the repo root's sibling `backend` checkout:
python3 ../../../backend/mock-ingest-server/server.py   # listens on :8080

# Terminal 2 — from webpack/react/example:
npm run dev --workspace=react/example                    # (or: cd react/example && npm run dev)
```

Open the printed `http://localhost:5173` URL. The dev server proxies `/v1/*` and
`/__debug/*` to `http://localhost:8080` (`vite.config.ts`) so the page's own
`fetch`/`sendBeacon` calls stay same-origin — the mock sends no CORS headers, the
same reason `e2e/fixtures/env.ts` proxies rather than calling it cross-origin
directly. The app itself configures `endpoint: window.location.origin`, so from
the SDK's point of view it is just talking to its own page's origin.

Click through the buttons, then **Refresh mock debug state** to confirm each
event actually landed server-side (reads the mock's `/__debug/received`, the
same introspection Phase 10's e2e suite uses).

## Against a real backend (staging or production)

Edit `src/App.tsx`'s `apiKey`/`endpoint` to a real `cs_test_pk_…`
(`https://staging.api.codeskop.com`) or `cs_live_pk_…`
(`https://api.codeskop.com`) key — see `web-sdk-workflow.md` Phase 11 for
currently-minted smoke-test keys — and remove the dev-server proxy dependency
(real endpoints send proper CORS headers, per Phase 11's verification). The
"refresh mock debug state" panel only works against the mock's debug endpoint;
against a real backend, confirm delivery via the dashboard instead.
