# Codeskop Web SDK (`@codeskop/tracker`)

[![npm version](https://img.shields.io/npm/v/@codeskop/tracker.svg)](https://www.npmjs.com/package/@codeskop/tracker)
[![license](https://img.shields.io/npm/l/@codeskop/tracker.svg)](./LICENSE)
[![bundle size](https://img.shields.io/bundlephobia/minzip/@codeskop/tracker)](https://bundlephobia.com/package/@codeskop/tracker)

A tiny, tree-shakeable TypeScript library that captures uncaught errors, unhandled
promise rejections, `fetch`/XHR failures and latency, and presence heartbeats from a
browser app, and sends them to [Codeskop](https://www.codeskop.com). Zero runtime
dependencies.

**Free and open to install.** `@codeskop/tracker` is MIT-licensed and published to the
public npm registry — no signup or token required to install or read the source.
Initialize it with a public key from an active [Codeskop](https://www.codeskop.com)
plan to start sending data; without one, it safely does nothing.

## Quick start

```bash
npm install @codeskop/tracker
```

```ts
import { init } from "@codeskop/tracker";

init({ apiKey: "cs_live_pk_…" });
```

Get a public key from your [Codeskop](https://www.codeskop.com) dashboard — only
needed for capture to reach your account, not to install or try the library.

## Without a bundler (script tag)

For server-rendered sites (Django, Rails, Laravel, ASP.NET), WordPress, Webflow, Shopify or plain HTML, add one tag to `<head>`. No build step and no JavaScript to write:

```html
<script src="https://cdn.jsdelivr.net/npm/@codeskop/tracker@1/dist/codeskop.min.js"
        data-codeskop-key="cs_live_pk_…"></script>
```

Optional attributes: `data-codeskop-user-id` (the signed-in user's ID, rendered by your server), `data-codeskop-release`, `data-codeskop-environment`, `data-codeskop-endpoint`, and `data-codeskop-network` / `-errors` / `-page-views` set to `"false"` to turn a capture off. The API is on `window.Codeskop` (`identify`, `track`, `screen`, `recordException`, `reset`, `setEnabled`, `flush`).

To load it `async` and still call the API from inline scripts before it arrives, define the stub first; queued calls are replayed on load:

```html
<script>
  window.Codeskop = window.Codeskop || { q: [] };
  ['identify', 'track', 'screen', 'recordException'].forEach(function (m) {
    Codeskop[m] = Codeskop[m] || function () { Codeskop.q.push([m, [].slice.call(arguments)]); };
  });
</script>
<script async src="https://cdn.jsdelivr.net/npm/@codeskop/tracker@1/dist/codeskop.min.js"
        data-codeskop-key="cs_live_pk_…"></script>
```

## What it captures

- Uncaught errors and unhandled promise rejections
- `fetch`/XHR failures, plus request latency
- Presence heartbeats
- Anything you want to report yourself, via `recordException()`

## Product analytics

On Growth and Scale plans, page views are captured automatically and you can
track your own events and user traits:

```ts
import { identify, track } from "@codeskop/tracker";

identify(user.id, { plan: "pro" });   // your own id; never emails or phone numbers
track("order_completed", { value: 49.99, currency: "KES" });
```

Codeskop builds funnels, retention, paths and segments from them.

A [React adapter](https://www.npmjs.com/package/@codeskop/tracker-react) is available
as a separate package, with a provider, an error boundary, and a hook.

## Links

- Website: [codeskop.com](https://www.codeskop.com)
- GitHub: [github.com/Codeskop-io](https://github.com/Codeskop-io)
- License: [MIT](./LICENSE)
