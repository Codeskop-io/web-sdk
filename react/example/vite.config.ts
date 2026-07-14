import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The mock ingest server (`backend/mock-ingest-server/server.py`) sends no CORS
// headers — a deliberate development-aid simplification, not a contract gap
// (`web-sdk-workflow.md` Phase 11 confirms the real backend does). Proxying
// `/v1/*` and `/__debug/*` here keeps the page's own requests same-origin, the
// same trick `e2e/fixtures/env.ts`'s `startAppServer` uses for the Playwright
// suites.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/v1': 'http://localhost:8080',
      '/__debug': 'http://localhost:8080',
    },
  },
});
