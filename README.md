<p align="center">
  <a href="https://www.codeskop.com/?utm_source=npm&utm_medium=readme&utm_campaign=tracker">
    <img src="https://www.codeskop.com/media/product-tour-poster.jpg" alt="Codeskop dashboard: crash-free users, active users, open issues and API latency" width="720">
  </a>
</p>

# @codeskop/tracker

**See the JavaScript errors and failing API calls your users hit, before they report them.**

[![npm version](https://img.shields.io/npm/v/@codeskop/tracker.svg)](https://www.npmjs.com/package/@codeskop/tracker)
[![bundle size](https://img.shields.io/bundlephobia/minzip/@codeskop/tracker)](https://bundlephobia.com/package/@codeskop/tracker)
[![license](https://img.shields.io/npm/l/@codeskop/tracker.svg)](./LICENSE)

`@codeskop/tracker` is the browser SDK for [Codeskop](https://www.codeskop.com/?utm_source=npm&utm_medium=readme&utm_campaign=tracker). Add it to any web app and Codeskop groups every error into an issue with its stack trace, the browser and the release it started in, then shows which API calls fail or slow down.

- **Errors:** uncaught errors and unhandled promise rejections, grouped into issues.
- **API monitoring:** failing and slow `fetch`/XHR calls, per endpoint.
- **Product analytics:** page views, custom events, funnels and retention.
- **Small and safe:** about 12 KB gzipped, zero dependencies. Every call is a no-op if anything goes wrong, so it can never break your app.

Works with React, Next.js, Vue, Svelte, Angular, plain JavaScript, or a single [`<script>` tag](#no-bundler-one-script-tag) on any site.

## Get started in 2 minutes

**1. Create a free account** at **[dashboard.codeskop.com/signup](https://dashboard.codeskop.com/signup?utm_source=npm&utm_medium=readme&utm_campaign=tracker)**. No credit card. You get a project and its public key (`cs_live_pk_…`) straight away.

**2. Install:**

```bash
npm install @codeskop/tracker
```

**3. Initialize once, as early as possible:**

```ts
import { init } from "@codeskop/tracker";

init({
  apiKey: "cs_live_pk_…",   // your project's public key
  release: "1.0.0",         // optional: your app's version
});
```

Throw an error in your app and it shows up in your dashboard within seconds.

> Using React? Use [`@codeskop/tracker-react`](https://www.npmjs.com/package/@codeskop/tracker-react) for a provider, error boundary and hook.

## No bundler? One script tag

For server-rendered sites (Django, Rails, Laravel, ASP.NET), WordPress, Webflow, Shopify or plain HTML, paste this into `<head>`. No build step:

```html
<script src="https://cdn.jsdelivr.net/npm/@codeskop/tracker@1/dist/codeskop.min.js"
        data-codeskop-key="cs_live_pk_…"
        data-codeskop-user-id="<signed-in user's id, optional>"></script>
```

The API is on `window.Codeskop`. See the [script tag guide](https://www.codeskop.com/docs/web/script-tag?utm_source=npm&utm_medium=readme&utm_campaign=tracker) for every attribute, async loading and CSP.

## Common tasks

```ts
import { identify, reset, recordException, track } from "@codeskop/tracker";

identify(user.id);                 // after login: your own ID, never an email
reset();                           // on logout

try {
  await checkout(cart);
} catch (error) {
  recordException(error);          // report a handled error
}

track("order_completed", { value: 49.99, currency: "KES" });  // product analytics
```

## Plans

| | Free | Starter | Growth |
|---|---|---|---|
| Errors and crashes | ✓ | ✓ | ✓ |
| API monitoring (fetch/XHR) | | ✓ | ✓ |
| Alerts | | ✓ | ✓ |
| Product and user analytics | | | ✓ |
| Events per month | 10,000 | 100,000 | 1,000,000 |

The SDK is the same on every plan; your plan decides what's kept. See [pricing](https://www.codeskop.com/pricing?utm_source=npm&utm_medium=readme&utm_campaign=tracker).

## Privacy

No third-party cookies and no fingerprinting: an anonymous install ID lives in `localStorage` (a first-party cookie only if storage is unavailable). Request and response bodies, `Authorization` and `Cookie` headers and query strings are never sent, and error messages are redacted by default. You choose the user ID. Details: [Privacy & Security](https://www.codeskop.com/docs/privacy?utm_source=npm&utm_medium=readme&utm_campaign=tracker).

## Documentation

- [Installation & setup](https://www.codeskop.com/docs/web/installation?utm_source=npm&utm_medium=readme&utm_campaign=tracker)
- [React](https://www.codeskop.com/docs/web/react?utm_source=npm&utm_medium=readme&utm_campaign=tracker) and [script tag](https://www.codeskop.com/docs/web/script-tag?utm_source=npm&utm_medium=readme&utm_campaign=tracker)
- [All configuration options](https://www.codeskop.com/docs/web/configuration?utm_source=npm&utm_medium=readme&utm_campaign=tracker)
- [Troubleshooting](https://www.codeskop.com/docs/troubleshooting?utm_source=npm&utm_medium=readme&utm_campaign=tracker)

Also monitoring a backend or mobile app? Codeskop has SDKs for [Android, iOS, Flutter](https://www.codeskop.com/docs?utm_source=npm&utm_medium=readme&utm_campaign=tracker), and [Python, Node.js, Java, Go and PHP](https://www.codeskop.com/docs/server?utm_source=npm&utm_medium=readme&utm_campaign=tracker), all in the same dashboard.

## Help

Questions or a bug? [Contact us](https://www.codeskop.com/contact?utm_source=npm&utm_medium=readme&utm_campaign=tracker) or email plinqdevelopers@gmail.com.

MIT licensed.
