/**
 * Events v2 (`backend/docs/11-events-v2-contract.md`) at the client level:
 * session id and seq on every event, session rollover, lifecycle events,
 * the anonymous id, track categories, click capture and deep links.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AnalyticsPayload,
  BatchEnvelope,
  CodeskopConfig,
  CodeskopEvent,
  QueueLike,
  RemoteConfig,
  Transport,
} from '../model/types.js';
import { DEFAULT_REMOTE_CONFIG } from '../config/index.js';
import { SESSION_TIMEOUT_MS } from '../core/session.js';
import { pageLoad } from '../capture/lifecycle.js';
import { CodeskopClient, setActiveClient } from './client.js';

const config: CodeskopConfig = {
  apiKey: 'cs_test_pk_v2',
  endpoint: 'https://ingest.example.com',
  capturePageViews: false,
};
const ANALYTICS_ON: RemoteConfig = {
  ...DEFAULT_REMOTE_CONFIG,
  features: { analytics: true },
  autocapture: { clicks: true },
};
const ANALYTICS_OFF: RemoteConfig = {
  ...DEFAULT_REMOTE_CONFIG,
  features: { analytics: false },
  autocapture: { clicks: false },
};

function memoryQueue(): QueueLike & { events: CodeskopEvent[]; acked: string[] } {
  const events: CodeskopEvent[] = [];
  const acked: string[] = [];
  return {
    events,
    acked,
    async enqueue(event) {
      events.push(event);
    },
    async peekBatch(max) {
      return events.slice(0, max);
    },
    async ack(ids) {
      acked.push(...ids);
    },
    async size() {
      return events.length;
    },
  };
}

function recordingTransport(): Transport & { sent: BatchEnvelope[] } {
  const sent: BatchEnvelope[] = [];
  return {
    sent,
    async send(batch) {
      sent.push(batch);
      return { ok: true, retryable: false };
    },
  };
}

let client: CodeskopClient | undefined;

function start(remote: RemoteConfig = ANALYTICS_ON, extra: Partial<CodeskopConfig> = {}) {
  const queue = memoryQueue();
  const beacon = recordingTransport();
  client = new CodeskopClient(
    { ...config, ...extra },
    {
      installId: 'inst_v2',
      queue,
      fetchTransport: recordingTransport(),
      beaconTransport: beacon,
      configSource: { fetchConfig: async () => remote },
      heartbeatCapture: { start() {}, stop() {} },
    },
  );
  return { queue, beacon, client };
}

/** Lets the remote config apply and any deferred (`whenLoaded`) events land. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(20);
}

function named(queue: { events: CodeskopEvent[] }, name: string): CodeskopEvent[] {
  return queue.events.filter((e) => (e.payload as AnalyticsPayload).name === name);
}

function props(event: CodeskopEvent | undefined): Record<string, unknown> {
  return (event?.payload as AnalyticsPayload).properties;
}

function bySeq(events: CodeskopEvent[]): CodeskopEvent[] {
  return [...events].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  });
  vi.setSystemTime(new Date('2026-10-20T10:00:00.000Z'));
});

afterEach(() => {
  client?.dispose();
  client = undefined;
  setActiveClient(undefined);
  vi.useRealTimers();
  vi.restoreAllMocks();
  sessionStorage.clear();
  localStorage.clear();
  pageLoad.opened = false;
  pageLoad.screened = false;
  Reflect.deleteProperty(document, 'visibilityState');
  Reflect.deleteProperty(document, 'referrer');
  history.replaceState(null, '', '/');
  document.body.innerHTML = '';
});

describe('session id and seq', () => {
  it('are on every event type, with seq counting up within the session', async () => {
    const { queue, client } = start();
    client.emitEvent({
      type: 'heartbeat',
      severity: 'low',
      payload: { session_id: 'own', visible: true },
    });
    client.emitEvent({
      type: 'exception',
      severity: 'high',
      payload: { exception_class: 'E', message: 'm', stacktrace: [], handled: true, page: '/' },
    });
    client.emitEvent({
      type: 'api_error',
      severity: 'high',
      payload: { method: 'GET', host: 'h', path: '/', duration_ms: 1, error_kind: 'network' },
    });
    client.emitEvent({
      type: 'api_timing',
      severity: 'low',
      payload: { method: 'GET', host: 'h', path: '/', duration_ms: 1 },
    });
    client.track('order_completed');
    client.screen('/checkout');
    client.identify('u_1', { plan: 'pro' });
    await settle();

    const events = bySeq(queue.events);
    const session = events[0]!.session_id;
    expect(session).toMatch(/^sess_[0-9a-f]{32}$/);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    expect(new Set(events.map((e) => e.session_id))).toEqual(new Set([session]));
    expect(new Set(events.map((e) => e.type))).toEqual(
      new Set(['track', 'heartbeat', 'exception', 'api_error', 'api_timing', 'screen', 'identify']),
    );
    // Payloads that carry a session id carry the same one (the payload value wins on the server).
    for (const e of events) {
      if ('session_id' in e.payload) expect(e.payload.session_id).toBe(session);
    }
  });

  it('continue across page loads in the tab, and restart in a new session after 30 idle minutes', async () => {
    const first = start();
    first.client.track('a');
    await settle();
    const firstSession = first.queue.events[0]!.session_id;
    const lastSeq = Math.max(...first.queue.events.map((e) => e.seq ?? 0));
    first.client.dispose();

    // Next page load in the same tab: same session, seq continues, warm launch.
    pageLoad.opened = false;
    const second = start();
    second.client.track('b');
    await settle();
    const opened = named(second.queue, '$app_opened')[0];
    expect(props(opened)).toEqual({ launch_type: 'warm' });
    expect(named(second.queue, '$session_started')).toHaveLength(0);
    expect(opened?.session_id).toBe(firstSession);
    expect(opened?.seq).toBe(lastSeq + 1);

    const lastActivity = Date.now();
    second.client.screen('/a');
    vi.setSystemTime(lastActivity + SESSION_TIMEOUT_MS + 1000);
    second.client.track('after_idle');
    await settle();

    const ended = named(second.queue, '$session_ended')[0];
    expect(ended?.session_id).toBe(firstSession);
    expect(ended?.occurred_at).toBe(new Date(lastActivity).toISOString());
    expect(props(ended)).toEqual({ duration_s: 0, screens: 1, end_reason: 'inactive' });
    expect((ended?.payload as AnalyticsPayload).category).toBe('lifecycle');

    const started = named(second.queue, '$session_started')[0];
    const after = named(second.queue, 'after_idle')[0];
    expect(started?.session_id).not.toBe(firstSession);
    expect(props(started)).toEqual({ launch_type: 'warm' });
    expect([started?.seq, after?.seq]).toEqual([0, 1]);
    expect(after?.session_id).toBe(started?.session_id);
  });
});

describe('lifecycle events', () => {
  it('open the app (cold) and start a session on the first load in a tab, with load_ms', async () => {
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      { loadEventEnd: 640.2, type: 'navigate' } as unknown as PerformanceEntry,
    ]);
    const { queue } = start();
    await settle();
    const [started, opened] = bySeq(queue.events);
    expect(started?.payload as AnalyticsPayload).toMatchObject({
      name: '$session_started',
      category: 'lifecycle',
      properties: { launch_type: 'cold' },
    });
    expect(opened?.payload as AnalyticsPayload).toMatchObject({
      name: '$app_opened',
      category: 'lifecycle',
      properties: { launch_type: 'cold', load_ms: 640 },
    });
    expect(opened?.type).toBe('track');
  });

  it('are sent even when the plan has no product analytics, unlike track, screen and clicks', async () => {
    const { queue, client } = start(ANALYTICS_OFF);
    await settle();
    client.track('order_completed');
    client.screen('/x');
    setVisibility('hidden');
    setVisibility('visible');
    await settle();
    expect(queue.events.map((e) => (e.payload as AnalyticsPayload).name)).toEqual([
      '$session_started',
      '$app_opened',
      '$app_backgrounded',
      '$app_foregrounded',
    ]);
  });

  it('are never sampled out', async () => {
    const { queue } = start({ ...ANALYTICS_ON, sample_rates: { track: 0 } });
    await settle();
    expect(named(queue, '$app_opened')).toHaveLength(1);
  });

  it('report backgrounded and foregrounded from visibility changes', async () => {
    history.replaceState(null, '', '/orders');
    const { queue } = start();
    await settle();
    setVisibility('hidden');
    vi.setSystemTime(Date.now() + 90_000);
    setVisibility('visible');
    await settle();
    expect(props(named(queue, '$app_backgrounded')[0])).toEqual({ screen: '/orders' });
    expect(props(named(queue, '$app_foregrounded')[0])).toEqual({ background_s: 90 });
  });

  it('end the session as closed on pagehide, sent straight away by beacon, and start a new one after', async () => {
    const { queue, beacon, client } = start(ANALYTICS_ON);
    await settle();
    client.screen('/one');
    client.screen('/two');
    vi.setSystemTime(Date.now() + 75_000);
    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new Event('pagehide')); // only once
    await settle();

    const ended = named(queue, '$session_ended');
    expect(ended).toHaveLength(1);
    expect(props(ended[0])).toEqual({ duration_s: 75, screens: 2, end_reason: 'closed' });
    // Sent by beacon straight away (the queue's own unload drain may send it too; the server dedups by event_id).
    const beaconed = beacon.sent
      .flatMap((b) => b.batch)
      .filter((e) => e.event_id === ended[0]!.event_id);
    expect(beaconed.length).toBeGreaterThanOrEqual(1);
    expect(queue.acked).toContain(ended[0]!.event_id);

    // The page came back (or the next page in the tab): a fresh session, no second end.
    window.dispatchEvent(new Event('pageshow'));
    client.track('again');
    await settle();
    expect(named(queue, '$session_ended')).toHaveLength(1);
    const again = named(queue, 'again')[0];
    expect(again?.session_id).not.toBe(ended[0]!.session_id);
    expect(named(queue, '$session_started').map((e) => e.session_id)).toContain(again?.session_id);
  });

  it('end an already idle session as inactive when the tab closes', async () => {
    const { queue } = start();
    await settle();
    vi.setSystemTime(Date.now() + SESSION_TIMEOUT_MS + 5000);
    window.dispatchEvent(new Event('pagehide'));
    await settle();
    expect(props(named(queue, '$session_ended')[0])).toMatchObject({
      end_reason: 'inactive',
      duration_s: 0,
    });
  });

  it('send nothing while paused or kill-switched', async () => {
    const { queue, client } = start({ ...ANALYTICS_ON, enabled: false });
    await settle();
    queue.events.length = 0;
    window.dispatchEvent(new Event('pagehide'));
    setVisibility('hidden');
    client.setEnabled(false);
    await settle();
    expect(queue.events).toHaveLength(0);
  });

  it('send $app_opened once per page load, even when init() runs again', async () => {
    const first = start();
    await settle();
    first.client.dispose();
    const second = start();
    await settle();
    expect(named(first.queue, '$app_opened')).toHaveLength(1);
    expect(named(second.queue, '$app_opened')).toHaveLength(0);
  });
});

describe('screen views', () => {
  it('carry previous_screen, and the referrer and load_ms on the first one of the page load', async () => {
    Object.defineProperty(document, 'referrer', {
      configurable: true,
      value: 'https://news.example/story?id=9#c',
    });
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      { loadEventEnd: 300, type: 'reload' } as unknown as PerformanceEntry,
    ]);
    const { queue, client } = start();
    client.screen('/home');
    client.screen('/cart', { step: 1 });
    await settle();
    const [home, cart] = bySeq(queue.events.filter((e) => e.type === 'screen'));
    expect(props(home)).toEqual({ referrer: 'https://news.example/story', load_ms: 300 });
    expect(props(cart)).toEqual({ step: 1, previous_screen: '/home' });
  });

  it('keep previous_screen across page loads in the same session', async () => {
    const first = start();
    first.client.screen('/a');
    await settle();
    first.client.dispose();
    pageLoad.opened = false;
    const second = start();
    second.client.screen('/b');
    await settle();
    expect(props(second.queue.events.find((e) => e.type === 'screen'))).toMatchObject({
      previous_screen: '/a',
    });
  });

  it('come from automatic page views too', async () => {
    const { queue } = start(ANALYTICS_ON, { capturePageViews: true });
    await settle();
    expect(
      queue.events
        .filter((e) => e.type === 'screen')
        .map((e) => (e.payload as AnalyticsPayload).name),
    ).toEqual(['/']);
  });
});

describe('track', () => {
  it('sends a valid category', async () => {
    const { queue, client } = start();
    client.track('login_failed', { reason: 'invalid_password' }, { category: 'identity' });
    client.track('order_completed');
    await settle();
    expect(named(queue, 'login_failed')[0]?.payload).toMatchObject({
      category: 'identity',
      properties: { reason: 'invalid_password' },
    });
    expect(named(queue, 'order_completed')[0]?.payload).not.toHaveProperty('category');
  });

  it('drops an unknown category with a console warning and still sends the event', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { queue, client } = start();
    client.track('signup_started', {}, { category: 'technical' as never });
    await settle();
    expect(named(queue, 'signup_started')[0]?.payload).not.toHaveProperty('category');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('"technical"');
  });

  it('rejects reserved $ names from callers, like other invalid names', async () => {
    const { queue, client } = start();
    await settle();
    const before = queue.events.length;
    client.track('$app_opened');
    client.track('  $custom ');
    client.track('   ');
    client.screen('$screen');
    await settle();
    expect(queue.events).toHaveLength(before);
  });
});

describe('anonymous id and identify', () => {
  it('links the anonymous id from before login, once per user, and rotates it on reset', async () => {
    const { queue, client } = start();
    await settle();
    const anonymousId = localStorage.getItem('codeskop:anonymous_id:v1');
    expect(anonymousId).toMatch(/^a_[0-9a-f]{32}$/);
    expect(queue.events[0]?.user).toEqual({ anonymous_id: anonymousId, is_anonymous: true });

    client.identify('u_7');
    client.identify('u_7'); // already linked: nothing new to send
    await settle();
    const identifies = queue.events.filter((e) => e.type === 'identify');
    expect(identifies).toHaveLength(1);
    expect(identifies[0]).toMatchObject({
      user: { id: 'u_7', anonymous_id: anonymousId },
      payload: { traits: {} },
    });

    client.reset();
    const rotated = localStorage.getItem('codeskop:anonymous_id:v1');
    expect(rotated).not.toBe(anonymousId);
    client.track('after_logout');
    client.identify('u_8');
    await settle();
    expect(named(queue, 'after_logout')[0]?.user).toEqual({
      anonymous_id: rotated,
      is_anonymous: true,
    });
    expect(queue.events.filter((e) => e.type === 'identify')[1]).toMatchObject({
      user: { id: 'u_8', anonymous_id: rotated },
    });
  });

  it('does not relink on the next page load for the same user', async () => {
    const first = start();
    first.client.identify('u_1');
    await settle();
    first.client.dispose();
    const second = start();
    second.client.identify('u_1');
    await settle();
    expect(first.queue.events.filter((e) => e.type === 'identify')).toHaveLength(1);
    expect(second.queue.events.filter((e) => e.type === 'identify')).toHaveLength(0);
  });

  it('ignores an empty or non-string user id', async () => {
    const { queue, client } = start();
    client.identify('');
    client.identify(42 as unknown as string);
    await settle();
    expect(queue.events.filter((e) => e.type === 'identify')).toHaveLength(0);
  });
});

describe('$click autocapture', () => {
  function clickButton(): void {
    const host = document.createElement('div');
    host.innerHTML = '<button id="buy">Buy now</button>';
    document.body.appendChild(host);
    host.querySelector('button')!.click();
  }

  it('is captured when the remote config allows it', async () => {
    history.replaceState(null, '', '/shop');
    const { queue } = start(ANALYTICS_ON);
    await settle();
    clickButton();
    await settle();
    const [click] = named(queue, '$click');
    expect(click?.payload).toMatchObject({
      category: 'interaction',
      properties: { element: 'button', label: 'Buy now', element_id: 'buy', screen: '/shop' },
    });
  });

  it('is off when the remote config says so, before it has loaded, or without analytics', async () => {
    for (const remote of [
      { ...ANALYTICS_ON, autocapture: { clicks: false } },
      { ...ANALYTICS_ON, autocapture: undefined },
      { ...ANALYTICS_ON, features: { analytics: false } },
    ]) {
      const { queue, client } = start(remote);
      await settle();
      clickButton();
      vi.advanceTimersByTime(1000);
      await settle();
      expect(named(queue, '$click')).toHaveLength(0);
      client.dispose();
    }
  });

  it('is off with autocapture: { clicks: false }, whatever the remote config says', async () => {
    const { queue } = start(ANALYTICS_ON, { autocapture: { clicks: false } });
    await settle();
    clickButton();
    await settle();
    expect(named(queue, '$click')).toHaveLength(0);
  });
});

describe('$deep_link_opened', () => {
  it('is sent on load for utm params, with only the allowed query kept', async () => {
    history.replaceState(
      null,
      '',
      '/promo?utm_source=newsletter&utm_medium=email&email=jo%40x.com',
    );
    const { queue } = start();
    await settle();
    const [link] = named(queue, '$deep_link_opened');
    expect(link?.payload).toMatchObject({
      category: 'navigation',
      properties: { url: '/promo?utm_source=newsletter&utm_medium=email', source: 'newsletter' },
    });
  });

  it('is not sent for a plain load', async () => {
    const { queue } = start();
    await settle();
    expect(named(queue, '$deep_link_opened')).toHaveLength(0);
  });
});
