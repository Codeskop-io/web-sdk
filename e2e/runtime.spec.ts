/**
 * Phase 4 e2e proof (`web-sdk-workflow.md`): a real Chromium page, loading a
 * tiny built bundle, against the real mock ingest server
 * (`backend/mock-ingest-server`) — not jsdom, not a stubbed `fetch`.
 *
 * Confirms:
 *  - `init` is cheap (negligible synchronous cost).
 *  - a manually-enqueued event survives a full page reload (durable,
 *    IndexedDB-backed queue) and is flushed once connectivity returns.
 *  - the browser `online` event alone triggers a flush against the mock.
 *
 * Ingest calls (`/v1/events`) are blocked/unblocked with route interception
 * rather than `context.setOffline` — `setOffline` cuts off *all* traffic,
 * including the page's own navigation to the fixture server itself, which
 * would break the reload step. Reconnection is then a real `online` DOM
 * event, dispatched the same way the browser fires it.
 */
import { expect, test } from '@playwright/test';
import { startAppServer, startMockIngestServer, type AppServer, type MockIngestServer } from './fixtures/env.js';
import type { CodeskopTestHarness } from './fixtures/entry.js';

declare global {
  interface Window {
    __codeskop_test__: CodeskopTestHarness;
  }
}

let mock: MockIngestServer;
let app: AppServer;

test.beforeAll(async () => {
  mock = await startMockIngestServer();
  app = await startAppServer(mock.url);
});

test.afterAll(async () => {
  await app.close();
  await mock.close();
});

async function blockIngest(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/v1/events**', (route) => route.abort());
}

async function unblockIngestAndGoOnline(page: import('@playwright/test').Page): Promise<void> {
  await page.unroute('**/v1/events**');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
}

test('init returns synchronously and costs a negligible amount of time', async ({ page }) => {
  await page.goto(app.url);

  const durationMs = await page.evaluate(() => {
    const start = performance.now();
    window.__codeskop_test__.init({ apiKey: 'cs_test_pk_e2e_init_cost', endpoint: window.location.origin });
    return performance.now() - start;
  });

  expect(durationMs).toBeLessThan(50);
});

test('a manually-enqueued event survives a full page reload and is later flushed', async ({ page }) => {
  await page.goto(app.url);
  await blockIngest(page);

  await page.evaluate(() => {
    window.__codeskop_test__.init({ apiKey: 'cs_test_pk_e2e_reload', endpoint: window.location.origin });
    window.__codeskop_test__.emit('high');
  });
  await expect.poll(() => page.evaluate(() => window.__codeskop_test__.queueSize())).toBe(1);

  // Fresh JS context via a full reload — the durable queue (IndexedDB) is
  // the only thing that can carry the event across it. Ingest stays blocked
  // across the reload so nothing could have flushed it away first.
  await page.reload();
  await page.evaluate(() => {
    window.__codeskop_test__.init({ apiKey: 'cs_test_pk_e2e_reload', endpoint: window.location.origin });
  });
  await expect.poll(() => page.evaluate(() => window.__codeskop_test__.queueSize())).toBe(1);

  const flush = page.waitForResponse(
    (response) => response.url().includes('/v1/events') && response.status() === 200,
  );
  await unblockIngestAndGoOnline(page);
  await flush;

  await expect.poll(() => page.evaluate(() => window.__codeskop_test__.queueSize())).toBe(0);
});

test('the browser online event triggers a flush against the mock ingest server', async ({ page }) => {
  await page.goto(app.url);
  await blockIngest(page);

  await page.evaluate(() => {
    window.__codeskop_test__.init({ apiKey: 'cs_test_pk_e2e_online', endpoint: window.location.origin });
    window.__codeskop_test__.emit('low');
  });
  await expect.poll(() => page.evaluate(() => window.__codeskop_test__.queueSize())).toBe(1);

  const flushRequest = page.waitForRequest(
    (request) => request.url().includes('/v1/events') && request.method() === 'POST',
  );
  await unblockIngestAndGoOnline(page);

  const request = await flushRequest;
  const response = await request.response();
  expect(response?.status()).toBe(200);
  await expect.poll(() => page.evaluate(() => window.__codeskop_test__.queueSize())).toBe(0);
});
