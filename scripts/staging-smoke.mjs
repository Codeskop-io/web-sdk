#!/usr/bin/env node
/**
 * Phase 11 (`web-sdk-workflow.md`) standalone Node harness: exercises the
 * real, built `dist/index.js` package (not source, not a mock) against the
 * real staging ingest backend, in a jsdom-backed DOM (so `init`'s browser
 * feature-detection and the capture modules' `window`/`document` access all
 * work), while keeping Node's own global `fetch` (undici) as the transport —
 * deliberately, since Node's `fetch` does not enforce CORS, which lets this
 * harness isolate "does the SDK's wire behavior match the contract?" from
 * "does a real browser's CORS enforcement additionally block it?" (answered
 * separately by `e2e/staging-smoke.spec.ts`, a real-Chromium Playwright test).
 *
 * Requires the package to be built first (`npm run build`).
 *
 * Usage:
 *   STAGING_TEST_KEY=cs_test_pk_... node scripts/staging-smoke.mjs
 *   STAGING_TEST_KEY=cs_test_pk_... STAGING_ENDPOINT=https://staging.api.codeskop.com node scripts/staging-smoke.mjs
 */
import { JSDOM } from 'jsdom';
import 'fake-indexeddb/auto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API_KEY = process.env.STAGING_TEST_KEY;
const ENDPOINT = process.env.STAGING_ENDPOINT ?? 'https://staging.api.codeskop.com';

if (!API_KEY) {
  console.error('STAGING_TEST_KEY env var is required (a cs_test_pk_... key).');
  process.exit(1);
}

// --- jsdom globals: the SDK expects a browser (window/document/navigator/location). ---
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://127.0.0.1.invalid/staging-smoke',
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
// Node 22 ships its own read-only global `navigator` getter (for
// `navigator.userAgent` et al.) — `Object.defineProperty` overrides it where
// plain assignment throws `TypeError: Cannot set property navigator`.
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
globalThis.location = dom.window.location;
globalThis.XMLHttpRequest = dom.window.XMLHttpRequest;
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.CustomEvent = dom.window.CustomEvent;

// Deliberately NOT overriding `globalThis.fetch`/`sendBeacon` with jsdom's —
// jsdom has neither; Node's native `fetch` (undici, no CORS enforcement)
// stays in place, which is the whole point of this harness (see header).
const realFetch = globalThis.fetch;
const requestLog = [];

globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  const method = init?.method ?? 'GET';
  const response = await realFetch(input, init);
  const clone = response.clone();
  const entry = { url, method, status: response.status, headers: init?.headers, body: init?.body };
  if (url.includes('/v1/config') || url.includes('/v1/events')) {
    entry.responseBody = await clone.text().catch(() => null);
    requestLog.push(entry);
  }
  return response;
};

// `navigator.sendBeacon` isn't in jsdom; the SDK's beacon transport is only
// used on unload, which this harness never triggers, but stub it defensively
// so nothing throws if a code path checks for its existence.
if (!globalThis.navigator.sendBeacon) {
  globalThis.navigator.sendBeacon = () => false;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const distPath = path.resolve(__dirname, '../dist/index.js');
  const sdk = await import(distPath);
  const { init, identify, recordException, setEnabled, flush } = sdk;

  const results = { endpoint: ENDPOINT, steps: [] };

  // --- 1. init + GET /v1/config ---
  init({ apiKey: API_KEY, endpoint: ENDPOINT });
  identify('staging-node-smoke-user');
  await wait(1500); // config fetch is async, fired from the constructor

  const configCalls = requestLog.filter((e) => e.url.includes('/v1/config'));
  results.steps.push({
    step: 'GET /v1/config',
    ok: configCalls.length > 0 && configCalls[0].status === 200,
    status: configCalls[0]?.status,
    body: configCalls[0]?.responseBody,
  });

  // --- 2. a captured event round-trips through POST /v1/events ---
  recordException(new Error('phase11 staging node-harness smoke exception'), { smoke_test: true });
  const firstFlushOk = await flush();
  await wait(500);
  const firstEventsCall = requestLog.filter((e) => e.url.includes('/v1/events')).at(-1);
  results.steps.push({
    step: 'POST /v1/events (recordException -> flush)',
    ok: firstFlushOk && !!firstEventsCall && firstEventsCall.status >= 200 && firstEventsCall.status < 300,
    flushOk: firstFlushOk,
    status: firstEventsCall?.status,
    body: firstEventsCall?.responseBody,
  });

  // --- 3. setEnabled(false): a locally-paused client emits nothing ---
  const countBeforePause = requestLog.filter((e) => e.url.includes('/v1/events')).length;
  setEnabled(false);
  recordException(new Error('should NOT be sent — setEnabled(false)'));
  await flush();
  await wait(500);
  const countWhilePaused = requestLog.filter((e) => e.url.includes('/v1/events')).length;
  results.steps.push({
    step: 'setEnabled(false) suppresses capture',
    ok: countWhilePaused === countBeforePause,
    countBeforePause,
    countWhilePaused,
  });

  // --- resume ---
  setEnabled(true);
  recordException(new Error('phase11 staging node-harness smoke — resumed after setEnabled(true)'));
  await flush();
  await wait(500);
  const countAfterResume = requestLog.filter((e) => e.url.includes('/v1/events')).length;
  results.steps.push({
    step: 'setEnabled(true) resumes capture',
    ok: countAfterResume > countWhilePaused,
    countAfterResume,
  });

  // --- 4. duplicate event_id dedup: replay the exact last accepted request bytes ---
  const lastEventsCall = requestLog.filter((e) => e.url.includes('/v1/events')).at(-1);
  let dedupResult = { ok: false, note: 'no prior /v1/events call captured to replay' };
  if (lastEventsCall) {
    const replayHeaders = { ...lastEventsCall.headers };
    const replay = await realFetch(`${ENDPOINT}/v1/events`, {
      method: 'POST',
      headers: replayHeaders,
      body: lastEventsCall.body,
    });
    dedupResult = {
      ok: replay.status >= 200 && replay.status < 300,
      status: replay.status,
      body: await replay.text().catch(() => null),
      note: 'byte-identical replay of the same event_id; contract (backend/docs/07 §7.5) says 2xx = accepted/deduped',
    };
  }
  results.steps.push({ step: 'duplicate event_id replay', ...dedupResult });

  console.log(JSON.stringify(results, null, 2));

  const allOk = results.steps.every((s) => s.ok);
  process.exit(allOk ? 0 : 1);
}

main().catch((error) => {
  console.error('staging-smoke harness crashed:', error);
  process.exit(1);
});
