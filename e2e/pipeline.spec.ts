/**
 * Phase 10 e2e proof (`web-sdk-workflow.md`): the whole pipeline — network
 * (fetch failure), uncaught-error, unhandled-rejection, and heartbeat
 * capture — proven end-to-end in a real Chromium page against the real
 * mock ingest server (`test/mock-ingest-server/server.py`, vendored from `backend`), all the way
 * through to that server's `/__debug/received` state: not just "the mock
 * returned 200", but *which* event landed with *which* user and batch
 * context (`docs/03-capture-and-event-model.md` §3.2/§3.3).
 *
 * Also covers the offline-durability scenario (buffer while unreachable,
 * restore, confirm exactly-once delivery) and a stability/fault-injection
 * pass (a real capture hook throws via a test double; the page and the rest
 * of the SDK keep working, and only that one event is dropped).
 *
 * Same harness/fixture conventions as `runtime.spec.ts` (Phase 4): a real
 * built bundle, a same-origin proxy in front of the real mock process, and
 * route interception (never `context.setOffline`) to simulate unreachability
 * without also blocking the page's own navigation/reload traffic.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  fetchMockReceivedBatches,
  fetchMockReceivedEvents,
  resetMockReceivedBatches,
  startAppServer,
  startFailingApiServer,
  startMockIngestServer,
  type AppServer,
  type FailingApiServer,
  type MockIngestServer,
} from './fixtures/env.js';
import type { CodeskopTestHarness } from './fixtures/entry.js';

declare global {
  interface Window {
    __codeskop_test__: CodeskopTestHarness;
  }
}

/** The wire shape of `CodeskopEvent.user` (`model/types.ts`), narrowed from the mock's untyped JSON. */
interface WireUser {
  id?: string;
  is_anonymous?: boolean;
}

/** The slice of `CodeskopEvent` these assertions read, narrowed from the mock's untyped JSON. */
interface WireEvent {
  event_id: string;
  type: string;
  user?: WireUser;
  payload?: Record<string, unknown>;
}

let mock: MockIngestServer;
let app: AppServer;
let failingApi: FailingApiServer;

test.beforeAll(async () => {
  mock = await startMockIngestServer();
  app = await startAppServer(mock.url);
  failingApi = await startFailingApiServer();
});

test.afterAll(async () => {
  await app.close();
  await mock.close();
  await failingApi.close();
});

test.beforeEach(async () => {
  // Each test asserts against `/__debug/received` in isolation, even though
  // the mock process (and its in-memory `RECEIVED` list) is shared across
  // every test in this file.
  await resetMockReceivedBatches(mock.url);
});

async function blockIngest(page: Page): Promise<void> {
  await page.route('**/v1/events**', (route) => route.abort());
}

async function unblockIngestAndGoOnline(page: Page): Promise<void> {
  await page.unroute('**/v1/events**');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
}

async function receivedEvents(): Promise<WireEvent[]> {
  return (await fetchMockReceivedEvents(mock.url)) as unknown as WireEvent[];
}

test('a failing fetch call is captured as api_error + api_timing, synced, and received with the identified user', async ({
  page,
}) => {
  await page.goto(app.url);
  await page.evaluate((endpoint) => {
    window.__codeskop_test__.init({ apiKey: 'cs_test_pk_e2e_network', endpoint });
    window.__codeskop_test__.identify('user-network');
  }, app.url);

  await page.evaluate(async (boomUrl) => {
    try {
      await fetch(boomUrl);
    } catch {
      // The instrumented call always resolves (a 500 is a normal HTTP response,
      // not a rejection) — this catch only guards against a genuinely broken fixture.
    }
  }, `${failingApi.url}/boom`);

  await expect.poll(() => page.evaluate(() => window.__codeskop_test__.queueSize())).toBe(2);
  await page.evaluate(() => window.__codeskop_test__.flush());

  await expect.poll(async () => (await receivedEvents()).length).toBe(2);

  const events = await receivedEvents();
  const apiError = events.find((e) => e.type === 'api_error');
  const apiTiming = events.find((e) => e.type === 'api_timing');

  expect(apiError?.user).toEqual({ id: 'user-network', is_anonymous: false });
  expect(apiError?.payload?.path).toBe('/boom');
  expect(apiError?.payload?.status).toBe(500);
  expect(apiError?.payload?.error_kind).toBe('http_5xx');
  expect(apiTiming?.payload?.status).toBe(500);
});

test('a thrown (uncaught) error is captured, synced, and received with the identified user', async ({ page }) => {
  await page.goto(app.url);
  await page.evaluate((endpoint) => {
    window.__codeskop_test__.init({ apiKey: 'cs_test_pk_e2e_error', endpoint });
    window.__codeskop_test__.identify('user-error');
  }, app.url);

  await page.evaluate(() => {
    setTimeout(() => {
      throw new Error('e2e uncaught error');
    }, 0);
  });

  await expect.poll(() => page.evaluate(() => window.__codeskop_test__.queueSize())).toBe(1);
  await page.evaluate(() => window.__codeskop_test__.flush());

  await expect.poll(async () => (await receivedEvents()).length).toBe(1);

  const [event] = await receivedEvents();
  expect(event?.type).toBe('exception');
  expect(event?.user).toEqual({ id: 'user-error', is_anonymous: false });
  expect(event?.payload?.handled).toBe(false);
  // Messages are redacted by default (`docs/03` §3.5) — the placeholder, not the raw text, is what's on the wire.
  expect(event?.payload?.message).toBe('[REDACTED]');
});

test('an unhandled promise rejection is captured, synced, and received with the identified user', async ({ page }) => {
  await page.goto(app.url);
  await page.evaluate((endpoint) => {
    window.__codeskop_test__.init({ apiKey: 'cs_test_pk_e2e_rejection', endpoint });
    window.__codeskop_test__.identify('user-rejection');
  }, app.url);

  await page.evaluate(() => {
    Promise.reject(new Error('e2e unhandled rejection'));
  });

  await expect.poll(() => page.evaluate(() => window.__codeskop_test__.queueSize())).toBe(1);
  await page.evaluate(() => window.__codeskop_test__.flush());

  await expect.poll(async () => (await receivedEvents()).length).toBe(1);

  const [event] = await receivedEvents();
  expect(event?.type).toBe('exception');
  expect(event?.user).toEqual({ id: 'user-rejection', is_anonymous: false });
  expect(event?.payload?.handled).toBe(false);
});

test('a heartbeat tick is captured, synced, and received with correct user + batch context', async ({ page }) => {
  await page.goto(app.url);
  await page.evaluate((endpoint) => {
    window.__codeskop_test__.init({ apiKey: 'cs_test_pk_e2e_heartbeat', endpoint });
    window.__codeskop_test__.identify('user-heartbeat');
  }, app.url);

  await page.evaluate(() => window.__codeskop_test__.emit('low'));

  await expect.poll(() => page.evaluate(() => window.__codeskop_test__.queueSize())).toBe(1);
  await page.evaluate(() => window.__codeskop_test__.flush());

  await expect.poll(async () => (await receivedEvents()).length).toBe(1);

  const [event] = await receivedEvents();
  expect(event?.type).toBe('heartbeat');
  expect(event?.user).toEqual({ id: 'user-heartbeat', is_anonymous: false });

  const [batch] = await fetchMockReceivedBatches(mock.url);
  expect(batch?.context?.device?.platform).toBe('web');
  expect(batch?.context?.app?.origin).toBe(app.url);
});

test('offline: several buffered events of different types all arrive exactly once after reconnecting', async ({
  page,
}) => {
  await page.goto(app.url);
  await blockIngest(page);

  await page.evaluate((endpoint) => {
    window.__codeskop_test__.init({ apiKey: 'cs_test_pk_e2e_offline', endpoint });
    window.__codeskop_test__.identify('user-offline');
  }, app.url);

  await page.evaluate(() => {
    window.__codeskop_test__.emit('low');
    window.__codeskop_test__.emit('medium');
    window.__codeskop_test__.emit('high');
    window.__codeskop_test__.recordException(new Error('e2e offline exception'));
  });
  await expect.poll(() => page.evaluate(() => window.__codeskop_test__.queueSize())).toBe(4);

  // Still unreachable: confirm nothing has leaked through yet.
  expect(await receivedEvents()).toHaveLength(0);

  await unblockIngestAndGoOnline(page);

  await expect.poll(() => page.evaluate(() => window.__codeskop_test__.queueSize())).toBe(0);
  await expect.poll(async () => (await receivedEvents()).length).toBe(4);

  const events = await receivedEvents();
  const ourEvents = events.filter((e) => e.user?.id === 'user-offline');
  expect(ourEvents).toHaveLength(4);

  // Exactly-once delivery: distinct `event_id`s, no repeats across however
  // many batches/sync attempts the reconnect triggered.
  const ids = ourEvents.map((e) => e.event_id);
  expect(new Set(ids).size).toBe(ids.length);
});

test('a fault injected into one capture hook drops only that event; the page and the SDK keep working', async ({
  page,
}) => {
  await page.goto(app.url);
  await page.evaluate((endpoint) => {
    window.__codeskop_test__.init({ apiKey: 'cs_test_pk_e2e_fault', endpoint });
    window.__codeskop_test__.identify('user-fault');
  }, app.url);

  // A real `ErrorCapture` hook (`resourceErrorPayload`) throws mid-flight
  // because the event's `target.tagName` getter has been overridden to
  // throw (`entry.ts`'s test double) — proving `safely()` swallows a fault
  // from *inside* the hook body, not just from a pre-broken input.
  await page.evaluate(() => window.__codeskop_test__.triggerFaultyResourceError());

  // Give the guarded, swallowed listener a moment to run and confirm it
  // produced no event at all — "the SDK just drops that one event".
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.__codeskop_test__.queueSize())).toBe(0);

  // The page itself is still fully alive — no uncaught exception broke the
  // JS runtime or left the DOM in a broken state.
  expect(await page.evaluate(() => document.title)).toBe('codeskop e2e fixture');
  expect(
    await page.evaluate(() => {
      document.body.dataset.stillAlive = 'yes';
      return document.body.dataset.stillAlive;
    }),
  ).toBe('yes');

  // And the SDK itself keeps working: the very next real capture succeeds.
  await page.evaluate(() => window.__codeskop_test__.recordException(new Error('after the injected fault')));
  await expect.poll(() => page.evaluate(() => window.__codeskop_test__.queueSize())).toBe(1);
  await page.evaluate(() => window.__codeskop_test__.flush());

  await expect.poll(async () => (await receivedEvents()).filter((e) => e.user?.id === 'user-fault').length).toBe(1);
});

test('product analytics: a page view, identify traits and a custom event arrive in one session', async ({ page }) => {
  await page.goto(app.url);
  await page.evaluate((endpoint) => {
    window.__codeskop_test__.init({ apiKey: 'cs_test_pk_e2e_analytics', endpoint, capturePageViews: true });
    window.__codeskop_test__.identify('user-analytics', { plan: 'pro' });
    window.__codeskop_test__.track('order_completed', { value: 49.99, currency: 'KES' });
  }, app.url);

  await expect.poll(() => page.evaluate(() => window.__codeskop_test__.queueSize())).toBe(3);
  await page.evaluate(() => window.__codeskop_test__.flush());
  await expect.poll(async () => (await receivedEvents()).length).toBe(3);

  const events = await receivedEvents();
  const byType = Object.fromEntries(events.map((e) => [e.type, e]));
  expect(Object.keys(byType).sort()).toEqual(['identify', 'screen', 'track']);
  expect(byType.identify?.payload).toEqual({ traits: { plan: 'pro' } });
  expect(byType.track?.user).toEqual({ id: 'user-analytics', is_anonymous: false });
  expect(byType.track?.payload?.properties).toEqual({ value: 49.99, currency: 'KES' });
  expect(byType.screen?.payload?.session_id).toBe(byType.track?.payload?.session_id);
});
