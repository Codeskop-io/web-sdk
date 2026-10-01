/**
 * Automatic page views for product analytics: one `screen` event for the first
 * page and for every in-app navigation — `history.pushState` / `replaceState`
 * (React Router, Next.js, Vue Router…), `popstate` (back/forward) and
 * `hashchange`. The name is the path only: query strings and fragments are
 * never sent (they often carry tokens or personal data).
 */
import { safely } from '../core/safely.js';

type Emit = (name: string) => void;

interface HistoryLike {
  pushState: History['pushState'];
  replaceState: History['replaceState'];
}

export interface PageViewCaptureOptions {
  emit: Emit;
  win?: Window | undefined;
}

export class PageViewCapture {
  private readonly emit: Emit;
  private readonly win: Window | undefined;
  private lastPath: string | undefined;
  private originals: Pick<HistoryLike, 'pushState' | 'replaceState'> | undefined;
  private started = false;

  private readonly check = (): void => {
    safely(() => {
      const path = this.win?.location?.pathname || '/';
      if (path === this.lastPath) return;
      this.lastPath = path;
      this.emit(path);
    }, { context: 'pageviews.check' })();
  };

  constructor(options: PageViewCaptureOptions) {
    this.emit = options.emit;
    this.win = options.win ?? (typeof window !== 'undefined' ? window : undefined);
  }

  readonly start = safely((): void => {
    if (this.started || !this.win?.history) return;
    this.started = true;
    const history = this.win.history;
    const check = this.check;
    this.originals = { pushState: history.pushState, replaceState: history.replaceState };
    const { pushState, replaceState } = this.originals;
    history.pushState = function (this: History, ...args: Parameters<History['pushState']>) {
      const result = pushState.apply(this, args);
      check();
      return result;
    };
    history.replaceState = function (this: History, ...args: Parameters<History['replaceState']>) {
      const result = replaceState.apply(this, args);
      check();
      return result;
    };
    this.win.addEventListener('popstate', check);
    this.win.addEventListener('hashchange', check);
    check();
  }, { context: 'pageviews.start' });

  readonly stop = safely((): void => {
    if (!this.started || !this.win) return;
    this.started = false;
    if (this.originals) {
      this.win.history.pushState = this.originals.pushState;
      this.win.history.replaceState = this.originals.replaceState;
    }
    this.win.removeEventListener('popstate', this.check);
    this.win.removeEventListener('hashchange', this.check);
  }, { context: 'pageviews.stop' });
}
