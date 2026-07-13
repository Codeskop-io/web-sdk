/**
 * Test-only server plumbing for the Phase 4 e2e suite (`web-sdk-workflow.md`):
 * spawns the real `backend/mock-ingest-server/server.py` process, and serves
 * a same-origin static+proxy server in front of it. The proxy exists solely
 * because the mock server sends no CORS headers (it is a development aid,
 * not a spec-complete backend) — same-origin keeps the SDK's real `fetch`/
 * `sendBeacon` calls from ever hitting a browser CORS block, while every byte
 * still round-trips through the actual mock process over a real socket.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const MOCK_SERVER_SCRIPT = path.resolve(REPO_ROOT, '../backend/mock-ingest-server/server.py');

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

/** Spawns the real Python mock ingest server (`backend/mock-ingest-server/server.py`) on a free local port. */
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

function proxyToMock(req: http.IncomingMessage, res: http.ServerResponse, mockUrl: string): void {
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
