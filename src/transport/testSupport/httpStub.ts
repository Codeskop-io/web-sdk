/**
 * A tiny real HTTP server for transport integration tests — used only for the
 * one scenario the mock ingest server (`backend/mock-ingest-server/`) cannot
 * produce on demand: a transient `5xx` followed by success, to prove
 * `FetchTransport`'s retry/backoff actually recovers. Also doubles as a
 * request recorder so tests can assert on real wire bytes/headers (gzip,
 * `Authorization`, split-batch counts) without stubbing `fetch` itself — the
 * request travels a real socket to a real listener.
 */
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export interface StubResponse {
  status: number;
  body?: string;
}

export interface HttpStub {
  baseUrl: string;
  requests: RecordedRequest[];
  /** Queues responses to return in arrival order; once exhausted, `200 {}` repeats. */
  queueResponses(responses: StubResponse[]): void;
  close(): Promise<void>;
}

/** Starts the stub on an OS-assigned free port and resolves once it is listening. */
export async function startHttpStub(): Promise<HttpStub> {
  const requests: RecordedRequest[] = [];
  let queue: StubResponse[] = [];

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on('end', () => {
      requests.push({
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: req.headers,
        body: Buffer.concat(chunks),
      });
      const next = queue.shift() ?? { status: 200, body: '{}' };
      res.writeHead(next.status, { 'Content-Type': 'application/json' });
      res.end(next.body ?? '');
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    queueResponses(responses: StubResponse[]) {
      queue = [...responses];
    },
    close() {
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
