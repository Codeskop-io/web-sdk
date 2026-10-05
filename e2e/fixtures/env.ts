/**
 * Test-only server plumbing for the Phase 4 e2e suite (`web-sdk-workflow.md`):
 * spawns the vendored `test/mock-ingest-server/server.py` process, and serves
 * a same-origin static+proxy server in front of it. The proxy exists solely
 * because the mock server sends no CORS headers (it is a development aid,
 * not a spec-complete backend) — same-origin keeps the SDK's real `fetch`/
 * `sendBeacon` calls from ever hitting a browser CORS block, while every byte
 * still round-trips through the actual mock process over a real socket.
 *
 * This is now a **separate repo** from `backend` (Phase 16/release-engineering),
 * so it can no longer reach across to `../backend` in CI — `server.py` (stdlib
 * Python only) is vendored into this repo at `test/mock-ingest-server/`. It may
 * drift from backend's own copy over time; re-sync manually if the ingest
 * contract's mock behavior changes there.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MOCK_SERVER_SCRIPT = path.resolve(REPO_ROOT, 'test/mock-ingest-server/server.py');

/** Asks the OS for a free TCP port by binding to port 0 and reading back what it picked. */
async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address !== 'object') {
        probe.close(() => reject(new Error('could not allocate a free port')));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

async function waitUntilReachable(url: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not up yet — keep polling
    }
    if (Date.now() > deadline) throw new Error(`${url} never became reachable within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export interface MockIngestServer {
  url: string;
  close(): Promise<void>;
}

/** Spawns the real Python mock ingest server (`test/mock-ingest-server/server.py`, vendored from `backend`) on a free local port. */
export async function startMockIngestServer(): Promise<MockIngestServer> {
  const port = await getFreePort();
  const url = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawn('python3', [MOCK_SERVER_SCRIPT], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
    stdio: 'ignore',
  });

  await waitUntilReachable(`${url}/v1/config`);

  return {
    url,
    close: () =>
      new Promise((resolve) => {
        child.once('exit', () => resolve());
        child.kill();
      }),
  };
}

/** One accepted `POST /v1/events` envelope, as recorded by `server.py`'s `RECEIVED` and served back via `/__debug/received` (Phase 10's introspection seam — read from the file rather than guessed). */
export interface MockReceivedBatch {
  received_at: string;
  context: { device?: Record<string, unknown>; app?: Record<string, unknown> } | null;
  batch: Array<Record<string, unknown>>;
  rejected: string[];
  package: string | null;
  cert_sha256: string | null;
}

/** Fetches every envelope the mock has accepted so far, oldest first — talks directly to the mock (not through the app server's same-origin proxy), since this is Node-side test introspection, not a page request. */
export async function fetchMockReceivedBatches(mockUrl: string): Promise<MockReceivedBatch[]> {
  const response = await fetch(`${mockUrl}/__debug/received`);
  const body = (await response.json()) as { batches: MockReceivedBatch[] };
  return body.batches;
}

/** Flattens every accepted batch's events into one array — for assertions that don't care about batch boundaries. */
export async function fetchMockReceivedEvents(mockUrl: string): Promise<Array<Record<string, unknown>>> {
  const batches = await fetchMockReceivedBatches(mockUrl);
  return batches.flatMap((entry) => entry.batch);
}

/** Clears the mock's `/__debug/received` state so tests sharing one long-lived server process can isolate themselves. */
export async function resetMockReceivedBatches(mockUrl: string): Promise<void> {
  await fetch(`${mockUrl}/__debug/reset`, { method: 'POST' });
}

export function proxyToMock(req: http.IncomingMessage, res: http.ServerResponse, mockUrl: string): void {
  const target = new URL(req.url ?? '/', mockUrl);
  const upstream = http.request(
    {
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: req.method,
      headers: req.headers,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstream.on('error', () => {
    res.writeHead(502);
    res.end();
  });
  req.pipe(upstream);
}

export interface FailingApiServer {
  url: string;
  close(): Promise<void>;
}

/**
 * A tiny standalone, always-500 endpoint, deliberately on its **own** origin
 * (`web-sdk-workflow.md` Phase 10's "a fetch call that 4xx/5xxs"). It cannot
 * share a host with the app server: `capture/network.ts`'s self-ingest
 * exclusion is host-based (never instrument calls to the configured ingest
 * endpoint's host), and the app server's host *is* the configured endpoint
 * (its `/v1/events`/`/v1/config` proxy) in every fixture that points the SDK
 * at `app.url` — a same-host "boom" route would be silently excluded too.
 * CORS is wide open so the page's real `fetch` reads the actual `500`
 * rather than an opaque cross-origin network error.
 */
export async function startFailingApiServer(): Promise<FailingApiServer> {
  const server = http.createServer((_req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'boom' }));
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') resolve(address.port);
      else reject(new Error('could not allocate a free port for the failing API server'));
    });
  });

  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export interface AppServer {
  url: string;
  close(): Promise<void>;
}

const FIXTURE_HTML = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>codeskop e2e fixture</title></head>
  <body><script src="/bundle.js"></script></body>
</html>`;

/**
 * Bundles `entry.ts` with esbuild (in memory — nothing written to disk) and
 * serves it, plus a bare HTML shell, from one origin; proxies `/v1/events`
 * and `/v1/config` to `mockUrl` so the page's own requests stay same-origin.
 */
export async function startAppServer(mockUrl: string): Promise<AppServer> {
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
    if (requestUrl.startsWith('/v1/events') || requestUrl.startsWith('/v1/config')) {
      proxyToMock(req, res, mockUrl);
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
      else reject(new Error('could not allocate a free port for the app server'));
    });
  });

  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
