/**
 * The <script>-tag build (`dist/codeskop.min.js`) on a plain HTML page with no
 * bundler: async load with the loader stub, auto-init from data attributes,
 * the server-rendered user ID, replay of calls made before the script
 * arrived, and an uncaught error, all delivered to the real mock ingest.
 * Requires `npm run build` first (CI builds before the e2e suite).
 */
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { fetchMockReceivedEvents, proxyToMock, startMockIngestServer, type MockIngestServer } from './fixtures/env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = readFileSync(path.resolve(__dirname, '../dist/codeskop.min.js'), 'utf8');

const page = (origin: string) => `<!doctype html>
<html><head>
<script>
  window.Codeskop = window.Codeskop || { q: [] };
  ['identify', 'track', 'screen', 'recordException'].forEach(function (m) {
    Codeskop[m] = Codeskop[m] || function () { Codeskop.q.push([m, [].slice.call(arguments)]); };
  });
  Codeskop.recordException(new Error('queued before load'));
</script>
<script async src="/codeskop.min.js" data-codeskop-key="cs_test_pk_e2e_script_tag" data-codeskop-endpoint="${origin}"
        data-codeskop-user-id="srv-user-42" data-codeskop-release="9.9.9"></script>
</head><body><h1>Server-rendered page</h1></body></html>`;

let mock: MockIngestServer;
let server: http.Server;
let origin = '';

test.beforeAll(async () => {
  mock = await startMockIngestServer();
  server = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(page(origin));
    } else if (req.url === '/codeskop.min.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end(BUNDLE);
    } else if (req.url?.startsWith('/v1/')) {
      proxyToMock(req, res, mock.url);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

test.afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await mock.close();
});

test('script tag: auto-init, server-rendered user, queued calls and uncaught errors', async ({ page: p }) => {
  const pageErrors: string[] = [];
  p.on('pageerror', (e) => pageErrors.push(e.message));
  await p.goto(origin);
  await p.waitForFunction(() => typeof (window as unknown as { Codeskop?: { version?: string } }).Codeskop?.version === 'string');
  await p.evaluate(() => setTimeout(() => { throw new TypeError('uncaught on plain page'); }, 0));
  await p.waitForTimeout(200);
  await p.evaluate(() => (window as unknown as { Codeskop: { flush(): Promise<boolean> } }).Codeskop.flush());

  let exceptions: Array<Record<string, unknown>> = [];
  await expect
    .poll(async () => {
      exceptions = (await fetchMockReceivedEvents(mock.url)).filter((e) => e.type === 'exception');
      return exceptions.map((e) => (e.payload as { exception_class?: string }).exception_class).sort();
    }, { timeout: 15_000 })
    .toEqual(['Error', 'TypeError']); // messages are redacted by default
  for (const e of exceptions) expect((e.user as { id?: string }).id).toBe('srv-user-42');
  expect(pageErrors).toEqual(['uncaught on plain page']); // the SDK never adds errors of its own
});
