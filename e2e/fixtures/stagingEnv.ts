/**
 * Test-only server plumbing for the Phase 11 staging smoke test
 * (`web-sdk-workflow.md`): serves the same `e2e/fixtures/entry.ts` harness
 * bundle used against the mock (Phase 4/10), but from a bare static server
 * with **no proxy** in front of it — unlike `env.ts`'s `startAppServer`,
 * which same-origins `/v1/events`/`/v1/config` to the mock. Here the page's
 * own `fetch`/`sendBeacon` calls go directly, cross-origin, to whatever real
 * `endpoint` the test's `init()` call configures (staging or production),
 * so CORS/origin-binding (D10) is exercised for real rather than sidestepped.
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE_HTML = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>codeskop staging smoke fixture</title></head>
  <body><script src="/bundle.js"></script></body>
</html>`;

export interface StagingAppServer {
  url: string;
  close(): Promise<void>;
}

/** Bundles `entry.ts` (in memory) and serves it + a bare HTML shell from one local origin, with no proxying of ingest calls. */
export async function startStagingAppServer(): Promise<StagingAppServer> {
  const built = await esbuild.build({
    entryPoints: [path.resolve(__dirname, 'entry.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    target: 'es2022',
    platform: 'browser',
  });
  const bundleJs = built.outputFiles[0]?.text ?? '';

  const server = http.createServer((req, res) => {
    const requestUrl = req.url ?? '/';
    if (requestUrl === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(FIXTURE_HTML);
      return;
    }
    if (requestUrl === '/bundle.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end(bundleJs);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') resolve(address.port);
      else reject(new Error('could not allocate a free port for the staging fixture app server'));
    });
  });

  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
