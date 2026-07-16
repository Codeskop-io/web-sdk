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

## What it captures

- Uncaught errors and unhandled promise rejections
- `fetch`/XHR failures, plus request latency
- Presence heartbeats
- Anything you want to report yourself, via `recordException()`

A [React adapter](https://www.npmjs.com/package/@codeskop/tracker-react) is available
as a separate package, with a provider, an error boundary, and a hook.

## Links

- Website: [codeskop.com](https://www.codeskop.com)
- GitHub: [github.com/Codeskop-io](https://github.com/Codeskop-io)
- License: [MIT](./LICENSE)
