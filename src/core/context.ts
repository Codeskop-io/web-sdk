/**
 * Context collector (`docs/03` §3.3, `web-sdk-workflow.md` Phase 4): builds
 * the `device`/`app` fields sent once per batch. Everything here is read
 * exactly once, synchronously, at `init` — never re-read per event — the
 * "per-page-load stable" context cache in the architecture diagram
 * (`docs/02` §2.3).
 *
 * Every field read is individually guarded: a missing/throwing platform API
 * degrades that one field to an empty string rather than failing the whole
 * collector (`init` must never throw, `docs/01` §1.2).
 */
import type { AppContext, CodeskopConfig, DeviceContext } from '../model/types.js';
import { SDK_VERSION } from './version.js';

/** The slice of the experimental `NavigatorUAData` this module reads. Not yet in `lib.dom.d.ts`. */
interface NavigatorUserAgentData {
  brands?: { brand: string; version: string }[];
  platform?: string;
  mobile?: boolean;
}

/** Prefers the low-entropy UA-Client-Hints brand/platform string; falls back to `navigator.userAgent`. */
function collectUserAgent(): string {
  try {
    const uaData = (navigator as Navigator & { userAgentData?: NavigatorUserAgentData }).userAgentData;
    if (uaData?.brands && uaData.brands.length > 0) {
      const brands = uaData.brands.map((brand) => `${brand.brand} ${brand.version}`).join(', ');
      const platform = uaData.platform ? `; ${uaData.platform}` : '';
      const mobile = uaData.mobile ? '; Mobile' : '';
      return `${brands}${platform}${mobile}`;
    }
  } catch {
    // fall through to navigator.userAgent
  }
  try {
    return typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string' ? navigator.userAgent : '';
  } catch {
    return '';
  }
}

function collectLocale(): string {
  try {
    if (typeof navigator === 'undefined') return '';
    return navigator.language ?? navigator.languages?.[0] ?? '';
  } catch {
    return '';
  }
}

function collectScreenSize(): string {
  try {
    if (typeof screen === 'undefined') return '';
    return `${screen.width}x${screen.height}`;
  } catch {
    return '';
  }
}

function collectViewportSize(): string {
  try {
    if (typeof window === 'undefined') return '';
    return `${window.innerWidth}x${window.innerHeight}`;
  } catch {
    return '';
  }
}

/** Path only — the query string is always dropped (`docs/03` §3.5). */
function collectPage(): string {
  try {
    if (typeof window === 'undefined' || !window.location) return '';
    return window.location.pathname || '/';
  } catch {
    return '';
  }
}

/** Origin + path; query/fragment dropped — a referrer's query string carries the same secret risk as any other URL's. */
function collectReferrer(): string | undefined {
  try {
    if (typeof document === 'undefined' || !document.referrer) return undefined;
    const parsed = new URL(document.referrer);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return undefined;
  }
}

/** `AppContext` minus `origin`, which `transport/envelope.ts` resolves per-batch from `window.location.origin` (D10). */
export type CollectedAppContext = Omit<AppContext, 'origin'>;

export interface CollectedContext {
  device: DeviceContext;
  app: CollectedAppContext;
}

/**
 * Collects the browser/page context exactly once, at `init` time.
 *
 * @param config Supplies `release` (`docs/03` §3.3 `app.release`).
 * @param installId The already-resolved install id (`core/installId.ts`),
 *   read once and threaded through rather than re-resolved here.
 */
export function collectContext(config: CodeskopConfig, installId: string): CollectedContext {
  const device: DeviceContext = {
    install_id: installId,
    platform: 'web',
    user_agent: collectUserAgent(),
    locale: collectLocale(),
    screen: collectScreenSize(),
    viewport: collectViewportSize(),
  };

  const app: CollectedAppContext = {
    page: collectPage(),
    referrer: collectReferrer(),
    release: config.release,
    // Mirrors `release` under the name the mobile SDKs use, so the dashboard's
    // app-version columns and release health work for web apps too.
    ...(config.release ? { version_name: config.release } : {}),
    sdk_version: SDK_VERSION,
  };

  return { device, app };
}
