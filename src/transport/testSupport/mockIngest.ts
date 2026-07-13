/**
 * Shared helper for integration tests that talk to the real
 * `backend/mock-ingest-server/` process, mirroring the convention already
 * established in `src/config/remoteConfigClient.integration.test.ts`: point at
 * `MOCK_INGEST_URL` (default `http://localhost:8080`) and let the suite skip
 * itself gracefully when nothing is listening there, rather than failing a
 * run where the mock hasn't been started.
 */

export const MOCK_INGEST_URL = process.env.MOCK_INGEST_URL ?? 'http://localhost:8080';

export async function isMockReachable(url: string = MOCK_INGEST_URL): Promise<boolean> {
  try {
    const response = await fetch(`${url}/v1/config`);
    return response.ok;
  } catch {
    return false;
  }
}
