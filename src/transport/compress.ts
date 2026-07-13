/**
 * Gzip compression of the outgoing envelope body via the global
 * `CompressionStream` (present in Node ≥ 18 and evergreen browsers), with an
 * uncompressed fallback for any host that lacks it (`docs/02` §2.6 platform
 * seams). The wire contract never *requires* compression — `Content-Encoding`
 * is simply omitted on the fallback path — but the ≤ 1 MB cap (`docs/03` §3.2)
 * applies to whatever is actually sent, compressed or not.
 */

const textEncoder = new TextEncoder();

/** The result of attempting to compress an outgoing body. */
export interface CompressedBody {
  /** The bytes to send as the request body. */
  body: Uint8Array<ArrayBuffer>;
  /** `'gzip'` when compression ran; `undefined` when the caller must send `body` uncompressed (omit `Content-Encoding`). */
  contentEncoding?: 'gzip';
}

function hasCompressionStream(): boolean {
  return typeof CompressionStream === 'function';
}

// `ReadableStream<Uint8Array<ArrayBuffer>>` (not the bare, `ArrayBufferLike`-backed
// `Uint8Array`) is what `CompressionStream`/`DecompressionStream`'s `writable` side
// (`WritableStream<BufferSource>`) actually accepts (`lib.dom.d.ts`) — matching it
// exactly here is what lets `.pipeThrough(compressionStream)` type-check.
async function readAllChunks(
  stream: ReadableStream<Uint8Array<ArrayBuffer>>,
): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of chunks) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Gzips `json` (UTF-8 encoded first). Falls back to the raw UTF-8 bytes,
 * uncompressed, when `CompressionStream` is unavailable or compression itself
 * fails for any reason — a compression bug must degrade to "send it plain",
 * never to "fail to send at all" (the prime directive, `docs/01` §1.2).
 */
export async function compressJson(json: string): Promise<CompressedBody> {
  const raw = textEncoder.encode(json);

  if (!hasCompressionStream()) {
    return { body: raw };
  }

  try {
    const compressionStream = new CompressionStream('gzip');
    const readable = new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(controller) {
        controller.enqueue(raw);
        controller.close();
      },
    });
    const body = await readAllChunks(readable.pipeThrough(compressionStream));
    return { body, contentEncoding: 'gzip' };
  } catch {
    return { body: raw };
  }
}
