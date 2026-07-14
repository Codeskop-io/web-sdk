/**
 * Phase 11 (`web-sdk-workflow.md`): a one-time, manually-run smoke test
 * against the **real** ingest backend — staging (`https://staging.api.codeskop.com`)
 * and, once staging is green, production (`https://api.codeskop.com`) — as
 * opposed to every other e2e spec in this directory, which runs against
 * `backend/mock-ingest-server/server.py`. This is deliberately opt-in (skips
 * a target unless its key env var is set) so routine `npm run test:e2e` / CI
 * runs never make live network calls against a shared environment.
 *
 * Unlike `env.ts`'s `startAppServer`, `stagingEnv.ts`'s `startStagingAppServer`
 * does **not** proxy `/v1/events`/`/v1/config` — the page's own `fetch` goes
 * directly, cross-origin, to whichever real endpoint the test configures, so
 * CORS/origin-binding (D10) is exercised for real rather than sidestepped by
 * a same-origin proxy.
 *
 * Run with:
 *   STAGING_TEST_KEY=cs_test_pk_...    npx playwright test e2e/staging-smoke.spec.ts   # staging only
 *   PRODUCTION_TEST_KEY=cs_live_pk_... npx playwright test e2e/staging-smoke.spec.ts   # production only
 *   STAGING_TEST_KEY=... PRODUCTION_TEST_KEY=... npx playwright test e2e/staging-smoke.spec.ts  # both
 *
 * Production is intentionally a **low-volume** smoke: the same handful of
 * requests as staging (one config fetch, two event flushes, one byte-
 * identical replay) — this is not a load test.
 */
import { expect, test } from '@playwright/test';
import { startStagingAppServer, type StagingAppServer } from './fixtures/stagingEnv.js';
import type { CodeskopTestHarness } from './fixtures/entry.js';

declare global {
  interface Window {
    __codeskop_test__: CodeskopTestHarness;
  }
}

interface SmokeTarget {
  label: string;
  endpoint: string;
  apiKey: string | undefined;
}

const TARGETS: SmokeTarget[] = [
  { label: 'staging', endpoint: 'https://staging.api.codeskop.com', apiKey: process.env.STAGING_TEST_KEY },
  { label: 'production', endpoint: 'https://api.codeskop.com', apiKey: process.env.PRODUCTION_TEST_KEY },
];

for (const target of TARGETS) {
  test.describe(`real ${target.label} ingest`, () => {
    test.skip(!target.apiKey, `${target.label} key env var not set — skipping live ${target.label} smoke test`);

    // Narrows the type for the rest of this block: `test.skip` above makes
    // the test body a no-op at runtime when the key is undefined, so TS
    // doesn't need `!`/optional-chaining on every use of a value that's
    // guaranteed defined by the time the test body actually runs.
    const apiKey: string = target.apiKey ?? '';
    const endpoint = target.endpoint;

    let app: StagingAppServer;

    test.beforeAll(async () => {
      app = await startStagingAppServer();
    });

    test.afterAll(async () => {
      await app.close();
    });

    test(`real ${target.label}: config, event round-trip, kill-switch, dedup, CORS/origin-binding`, async ({
      page,
    }) => {
      const configResponses: Array<{ status: number; body: unknown }> = [];
      const eventsResponses: Array<{ status: number; body: unknown }> = [];
      const consoleErrors: string[] = [];
      const requestFailures: string[] = [];

      page.on('console', (message) => {
        console.log(`[${target.label}][console:${message.type()}]`, message.text());
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      page.on('requestfailed', (request) => {
        console.log(`[${target.label}][requestfailed]`, request.method(), request.url(), request.failure()?.errorText);
        requestFailures.push(`${request.method()} ${request.url()} — ${request.failure()?.errorText}`);
      });
      page.on('response', async (response) => {
        const url = response.url();
        if (url.includes('/v1/config')) {
          configResponses.push({ status: response.status(), body: await response.json().catch(() => null) });
        } else if (url.includes('/v1/events')) {
          eventsResponses.push({ status: response.status(), body: await response.text().catch(() => null) });
        }
      });

      // Capture the exact bytes of the first accepted `/v1/events` POST so we
      // can manually replay it (same `event_id`) from Node afterwards — real
      // staging/production has no `/__debug/received` introspection endpoint
      // (that's mock-only), so a byte-identical replay returning 2xx is the
      // external signal available for "duplicate event_id is deduped, not
      // rejected".
      let capturedEventsRequest: { url: string; headers: Record<string, string>; postData: Buffer | null } | null =
        null;
      await page.route('**/v1/events', async (route) => {
        const request = route.request();
        if (!capturedEventsRequest) {
          capturedEventsRequest = {
            url: request.url(),
            headers: await request.allHeaders(),
            postData: request.postDataBuffer(),
          };
        }
        await route.continue();
      });

      await page.goto(app.url);

      // --- 1. init against the real target ---
      await page.evaluate(
        ({ apiKey, endpoint }) => {
          window.__codeskop_test__.init({ apiKey, endpoint });
          window.__codeskop_test__.identify(`${window.location.href}-smoke-user`);
        },
        { apiKey, endpoint },
      );

      // Config is fetched on launch — give it a moment, then assert it landed.
      await expect.poll(() => configResponses.length, { timeout: 10_000 }).toBeGreaterThan(0);
      const firstConfigResponse = configResponses[0];
      if (!firstConfigResponse) throw new Error('unreachable: length just asserted > 0');
      expect(firstConfigResponse.status).toBe(200);
      expect(firstConfigResponse.body).toMatchObject({
        enabled: expect.any(Boolean),
        sample_rates: expect.any(Object),
        features: expect.any(Object),
        max_queue_mb: expect.any(Number),
      });

      // --- 2. a manually-triggered captured event round-trips through POST /v1/events ---
      await page.evaluate(
        ({ label }) => {
          window.__codeskop_test__.recordException(new Error(`phase11 ${label} smoke test exception`), {
            smoke_test: true,
          });
        },
        { label: target.label },
      );
      const firstFlushOk = await page.evaluate(() => window.__codeskop_test__.flush());
      expect(firstFlushOk).toBe(true);

      await expect.poll(() => eventsResponses.length, { timeout: 10_000 }).toBeGreaterThan(0);
      const firstEventsResponse = eventsResponses[0];
      if (!firstEventsResponse) throw new Error('unreachable: length just asserted > 0');
      expect(firstEventsResponse.status).toBeGreaterThanOrEqual(200);
      expect(firstEventsResponse.status).toBeLessThan(300);

      const queueSizeAfterAccept = await page.evaluate(() => window.__codeskop_test__.queueSize());
      expect(queueSizeAfterAccept).toBe(0);

      // --- 3. setEnabled(false) / kill-switch: locally paused capture drops new events ---
      await page.evaluate(() => window.__codeskop_test__.setEnabled(false));
      await page.evaluate(() => {
        window.__codeskop_test__.recordException(new Error('should NOT be captured — setEnabled(false)'));
      });
      const queueSizeWhilePaused = await page.evaluate(() => window.__codeskop_test__.queueSize());
      expect(queueSizeWhilePaused).toBe(0); // emitEvent is a no-op while locally paused — never enqueued

      await page.evaluate(() => window.__codeskop_test__.setEnabled(true));
      await page.evaluate(
        ({ label }) => {
          window.__codeskop_test__.recordException(
            new Error(`phase11 ${label} smoke test — resumed after setEnabled(true)`),
          );
        },
        { label: target.label },
      );
      const resumedFlushOk = await page.evaluate(() => window.__codeskop_test__.flush());
      expect(resumedFlushOk).toBe(true);
      await expect.poll(() => eventsResponses.length, { timeout: 10_000 }).toBeGreaterThan(1);

      // --- 4. duplicate event_id dedup: replay the exact captured request bytes ---
      expect(capturedEventsRequest).not.toBeNull();
      const replay = capturedEventsRequest as unknown as {
        url: string;
        headers: Record<string, string>;
        postData: Buffer | null;
      };
      expect(replay.postData).not.toBeNull();
      const authorization = replay.headers['authorization'];
      const contentType = replay.headers['content-type'];
      if (!authorization || !contentType) {
        throw new Error('captured /v1/events request is missing authorization/content-type headers');
      }
      const replayHeaders: Record<string, string> = { authorization, 'content-type': contentType };
      const contentEncoding = replay.headers['content-encoding'];
      if (contentEncoding) {
        replayHeaders['content-encoding'] = contentEncoding;
      }
      const replayResponse = await page.request.post(replay.url, {
        headers: replayHeaders,
        data: replay.postData as Buffer,
      });
      // Contract (`backend/docs/07` §7.5): "2xx = all accepted/deduped" — a
      // byte-identical replay (same event_id) must still 2xx, not error, which
      // is the externally-observable half of "duplicates are deduped, not
      // rejected" available without a staging/production introspection
      // endpoint.
      expect(replayResponse.status()).toBeGreaterThanOrEqual(200);
      expect(replayResponse.status()).toBeLessThan(300);

      // --- 5. CORS note ---
      // Whether the browser's own CORS enforcement let the cross-origin
      // `fetch`/`sendBeacon` calls through is visible in `requestFailures`
      // (a CORS block surfaces there as a failed request, not as an HTTP
      // status) — asserted below so a regression here fails the test loudly
      // instead of silently swallowing a blocked call as "no event arrived".
      // Origin-*binding* (D10 allowlist enforcement) is not exercised here:
      // as of this run, no web-facing endpoint exists to configure a
      // per-key allowed-origins list (see web-sdk-workflow.md Phase 11), so
      // there is nothing to bind against yet — only the permissive CORS
      // headers are being checked.
      test.info().annotations.push({
        type: 'cors-note',
        description: `target=${target.label} requestFailures=${JSON.stringify(requestFailures)} consoleErrors=${JSON.stringify(consoleErrors)}`,
      });
      expect(requestFailures, `CORS or network failures: ${JSON.stringify(requestFailures)}`).toEqual([]);
    });
  });
}
