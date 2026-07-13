import { afterEach, describe, expect, it, vi } from 'vitest';
import { compressJson } from './compress.js';

const textDecoder = new TextDecoder();

async function gunzip(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const ds = new DecompressionStream('gzip');
  const readable = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const reader = readable.pipeThrough(ds).getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return textDecoder.decode(out);
}

describe('compressJson', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('gzips the JSON and round-trips back to the original text', async () => {
    const json = JSON.stringify({ hello: 'world', repeated: 'x'.repeat(2000) });

    const { body, contentEncoding } = await compressJson(json);

    expect(contentEncoding).toBe('gzip');
    // Gzip's magic number (RFC 1952 §2.3.1) confirms this is real gzip output,
    // not just relabeled bytes.
    expect(body[0]).toBe(0x1f);
    expect(body[1]).toBe(0x8b);
    expect(await gunzip(body)).toBe(json);
  });

  it('compresses a highly repetitive payload to well under its raw size', async () => {
    const json = JSON.stringify({ padding: 'a'.repeat(50_000) });
    const rawBytes = new TextEncoder().encode(json).length;

    const { body } = await compressJson(json);

    expect(body.length).toBeLessThan(rawBytes / 10);
  });

  it('falls back to raw UTF-8 bytes when CompressionStream is unavailable', async () => {
    vi.stubGlobal('CompressionStream', undefined);
    const json = JSON.stringify({ hello: 'world' });

    const { body, contentEncoding } = await compressJson(json);

    expect(contentEncoding).toBeUndefined();
    expect(textDecoder.decode(body)).toBe(json);
  });

  it('falls back to raw bytes rather than rejecting when compression itself throws', async () => {
    class ThrowingCompressionStream {
      constructor() {
        throw new Error('simulated compression failure');
      }
    }
    vi.stubGlobal('CompressionStream', ThrowingCompressionStream);
    const json = JSON.stringify({ hello: 'world' });

    const { body, contentEncoding } = await compressJson(json);

    expect(contentEncoding).toBeUndefined();
    expect(textDecoder.decode(body)).toBe(json);
  });
});
