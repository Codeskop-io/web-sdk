<p align="center">
  <a href="https://www.codeskop.com/?utm_source=npm&utm_medium=readme&utm_campaign=tracker-react">
    <img src="https://www.codeskop.com/media/product-tour-poster.jpg" alt="Codeskop dashboard: crash-free users, active users, open issues and API latency" width="720">
  </a>
</p>

# @codeskop/tracker-react

**React error tracking and analytics in three lines: a provider, an error boundary and a hook.**

[![npm version](https://img.shields.io/npm/v/@codeskop/tracker-react.svg)](https://www.npmjs.com/package/@codeskop/tracker-react)
[![license](https://img.shields.io/npm/l/@codeskop/tracker-react.svg)](./LICENSE)

The React adapter for [`@codeskop/tracker`](https://www.npmjs.com/package/@codeskop/tracker). [Codeskop](https://www.codeskop.com/?utm_source=npm&utm_medium=readme&utm_campaign=tracker-react) groups every render error, uncaught error and failing API call into issues with stack traces, the browser and the release, so you can fix what your users actually hit. Works with Next.js App Router (ships `"use client"`), Vite and Create React App. React 18 and 19.

## Get started in 2 minutes

**1. Create a free account** at **[dashboard.codeskop.com/signup](https://dashboard.codeskop.com/signup?utm_source=npm&utm_medium=readme&utm_campaign=tracker-react)**. No credit card. Copy your project's public key (`cs_live_pk_…`).

**2. Install both packages:**

```bash
npm install @codeskop/tracker @codeskop/tracker-react
```

**3. Wrap your app:**

```tsx
import { CodeskopProvider, CodeskopErrorBoundary } from "@codeskop/tracker-react";

createRoot(document.getElementById("root")!).render(
  <CodeskopProvider config={{ apiKey: "cs_live_pk_…", release: "1.0.0" }}>
    <CodeskopErrorBoundary fallback={<p>Something went wrong.</p>}>
      <App />
    </CodeskopErrorBoundary>
  </CodeskopProvider>,
);
```

Render errors caught by the boundary, uncaught errors and unhandled rejections now show up in your dashboard.

### Next.js App Router

```tsx
// app/providers.tsx
"use client";
import { CodeskopProvider } from "@codeskop/tracker-react";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <CodeskopProvider config={{ apiKey: process.env.NEXT_PUBLIC_CODESKOP_KEY! }}>
      {children}
    </CodeskopProvider>
  );
}
```

Then wrap `{children}` with `<Providers>` in `app/layout.tsx`.

## The hook

`useCodeskop()` gives you `identify`, `reset`, `recordException`, `track`, `screen`, `setEnabled` and `flush`. Every call is a safe no-op, even without a provider above it.

```tsx
import { useCodeskop } from "@codeskop/tracker-react";

function Checkout({ user }) {
  const { identify, recordException, track } = useCodeskop();
  useEffect(() => identify(user.id), [user.id]);   // your own ID, never an email

  async function pay() {
    try {
      await submitPayment();
      track("order_completed", { value: 49.99 });
    } catch (error) {
      recordException(error);
    }
  }
  // ...
}
```

## Plans

Errors are on every plan, including Free (10,000 events a month). API monitoring and alerts start on Starter, product and user analytics on Growth. See [pricing](https://www.codeskop.com/pricing?utm_source=npm&utm_medium=readme&utm_campaign=tracker-react).

## Documentation

- [React guide](https://www.codeskop.com/docs/web/react?utm_source=npm&utm_medium=readme&utm_campaign=tracker-react)
- [Configuration options](https://www.codeskop.com/docs/web/configuration?utm_source=npm&utm_medium=readme&utm_campaign=tracker-react)
- [Troubleshooting](https://www.codeskop.com/docs/troubleshooting?utm_source=npm&utm_medium=readme&utm_campaign=tracker-react)

Questions? [Contact us](https://www.codeskop.com/contact?utm_source=npm&utm_medium=readme&utm_campaign=tracker-react) or email plinqdevelopers@gmail.com. MIT licensed.
