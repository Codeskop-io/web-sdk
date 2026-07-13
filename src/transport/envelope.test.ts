import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodeskopEvent, DeviceContext } from '../model/types.js';
import { buildBatches, eventByteSize, type BuildBatchesContext } from './envelope.js';

const device: DeviceContext = {
  install_id: 'inst_1',
  platform: 'web',
  user_agent: 'vitest',
  locale: 'en-KE',
  screen: '1920x1080',
  viewport: '1280x720',
};

function baseContext(origin?: string): BuildBatchesContext {
  return {
    device,
    app: { page: '/checkout', sdk_version: '0.1.0-beta.0', origin },
  };
}

function makeEvent(id: string, extraBytes = 0): CodeskopEvent {
  return {
    event_id: id,
    type: 'heartbeat',
    occurred_at: '2026-07-01T12:00:00.000Z',
    severity: 'low',
    payload: { session_id: `s_${id}`, visible: true, padding: 'x'.repeat(extraBytes) },
  } as unknown as CodeskopEvent;
}

describe('eventByteSize', () => {
  it('matches the UTF-8 byte length of the serialized event', () => {
    const event = makeEvent('e1');
    expect(eventByteSize(event)).toBe(new TextEncoder().encode(JSON.stringify(event)).length);
  });
});

describe('buildBatches — envelope shape', () => {
  it('builds a single envelope with sent_at, context, and batch per docs/03 §3.2', async () => {
    const clock = { now: () => Date.parse('2026-07-13T09:00:00.000Z') };
    const events = [makeEvent('e1'), makeEvent('e2')];

    const { batches, droppedOversized } = await buildBatches(
      events,
      baseContext('https://app.customer.com'),
      {
        clock,
      },
    );

    expect(droppedOversized).toEqual([]);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({
      sent_at: '2026-07-13T09:00:00.000Z',
      batch: events,
    });
    expect(batches[0]?.context.device).toEqual(device);
  });

  it('returns no batches for empty input', async () => {
    const { batches, droppedOversized } = await buildBatches([], baseContext());
    expect(batches).toEqual([]);
    expect(droppedOversized).toEqual([]);
  });
});

describe('buildBatches — origin resolution (D10)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fills context.app.origin from window.location.origin, overriding a caller-supplied fallback', async () => {
    const { batches } = await buildBatches(
      [makeEvent('e1')],
      baseContext('https://ignored.example'),
    );
    expect(batches[0]?.context.app.origin).toBe(window.location.origin);
  });

  it('falls back to the caller-supplied origin when there is no window', async () => {
    vi.stubGlobal('window', undefined);
    const { batches } = await buildBatches(
      [makeEvent('e1')],
      baseContext('https://app.customer.com'),
    );
    expect(batches[0]?.context.app.origin).toBe('https://app.customer.com');
  });

  it('leaves origin undefined when there is neither a window nor a caller-supplied fallback', async () => {
    vi.stubGlobal('window', undefined);
    const { batches } = await buildBatches([makeEvent('e1')], baseContext(undefined));
    expect(batches[0]?.context.app.origin).toBeUndefined();
  });
});

describe('buildBatches — per-event size cap (≤64 KB)', () => {
  it('drops a single event over maxEventBytes rather than sending it', async () => {
    const small = makeEvent('small');
    const huge = makeEvent('huge', 100_000);

    const { batches, droppedOversized } = await buildBatches([small, huge], baseContext(), {
      maxEventBytes: 64 * 1024,
    });

    expect(droppedOversized).toEqual(['huge']);
    const allSentIds = batches.flatMap((b) => b.batch.map((e) => e.event_id));
    expect(allSentIds).toEqual(['small']);
  });

  it('drops every event when all are oversized, producing zero batches', async () => {
    const events = [makeEvent('a', 100_000), makeEvent('b', 100_000)];
    const { batches, droppedOversized } = await buildBatches(events, baseContext(), {
      maxEventBytes: 64 * 1024,
    });
    expect(batches).toEqual([]);
    expect(droppedOversized.sort()).toEqual(['a', 'b']);
  });
});

describe('buildBatches — per-batch event-count cap (≤100)', () => {
  it('chunks events into groups no larger than maxEventsPerBatch, preserving order and content', async () => {
    const events = [
      makeEvent('e1'),
      makeEvent('e2'),
      makeEvent('e3'),
      makeEvent('e4'),
      makeEvent('e5'),
    ];

    const { batches } = await buildBatches(events, baseContext(), { maxEventsPerBatch: 2 });

    expect(batches.map((b) => b.batch.map((e) => e.event_id))).toEqual([
      ['e1', 'e2'],
      ['e3', 'e4'],
      ['e5'],
    ]);
  });

  it('defaults the cap to 100', async () => {
    const events = Array.from({ length: 150 }, (_, i) => makeEvent(`e${i}`));
    const { batches } = await buildBatches(events, baseContext());
    expect(batches).toHaveLength(2);
    expect(batches[0]?.batch).toHaveLength(100);
    expect(batches[1]?.batch).toHaveLength(50);
  });
});

describe('buildBatches — compressed-size cap (≤1 MB), measured via an injectable compressor', () => {
  it('halves a batch until every resulting envelope reports a compressed size under the cap', async () => {
    const events = [makeEvent('a'), makeEvent('b'), makeEvent('c'), makeEvent('d')];
    // A fake compressor that reports "too big" for any group of more than one
    // event, forcing the builder to keep splitting down to singletons.
    const compress = vi.fn(async (json: string) => {
      const parsed = JSON.parse(json) as { batch: unknown[] };
      const over = parsed.batch.length > 1;
      return { body: new Uint8Array(over ? 2_000_000 : 10) };
    });

    const { batches } = await buildBatches(events, baseContext(), {
      maxCompressedBytes: 1024 * 1024,
      compress,
    });

    expect(batches).toHaveLength(4);
    expect(batches.every((b) => b.batch.length === 1)).toBe(true);
    expect(batches.flatMap((b) => b.batch.map((e) => e.event_id)).sort()).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
    // Singletons are never re-measured (see module doc) — only the three
    // multi-event candidates (4 → two 2s → four 1s, but 1s are never
    // measured) were ever passed to the compressor.
    expect(compress).toHaveBeenCalledTimes(3);
  });

  it('keeps a batch intact when the (real) compressor reports it fits', async () => {
    const events = [makeEvent('a'), makeEvent('b'), makeEvent('c')];
    const { batches } = await buildBatches(events, baseContext(), {
      maxCompressedBytes: 1024 * 1024,
    });
    expect(batches).toHaveLength(1);
    expect(batches[0]?.batch).toHaveLength(3);
  });
});
