# `@codeskop/tracker-react`

[![npm version](https://img.shields.io/npm/v/@codeskop/tracker-react.svg)](https://www.npmjs.com/package/@codeskop/tracker-react)
[![license](https://img.shields.io/npm/l/@codeskop/tracker-react.svg)](./LICENSE)

First-class React integration for
[`@codeskop/tracker`](https://www.npmjs.com/package/@codeskop/tracker) — a provider, an
error boundary, and a hook. Same free, MIT-licensed public distribution as the core
package — no token or signup needed to install. A public key from an active
[Codeskop](https://www.codeskop.com) plan is what enables capture; without one, it
safely does nothing.

## Install

```bash
npm install @codeskop/tracker @codeskop/tracker-react
```

## Usage

```tsx
import { CodeskopProvider, CodeskopErrorBoundary } from "@codeskop/tracker-react";

createRoot(el).render(
  <CodeskopProvider config={{ apiKey: "cs_live_pk_…" }}>
    <CodeskopErrorBoundary fallback={<Oops />}>
      <App />
    </CodeskopErrorBoundary>
  </CodeskopProvider>,
);
```

Inside the tree, `useCodeskop()` gives you `recordException`, `identify`,
`reset`, `setEnabled`, and `flush` — safe no-ops even without a
`CodeskopProvider` above it.

```tsx
import { useCodeskop } from "@codeskop/tracker-react";

function Profile() {
  const { identify } = useCodeskop();
  useEffect(() => identify(user.id, { plan: user.plan }), [user]);
  // ...
}
```

## Peer dependencies

`react` `^18.0.0 || ^19.0.0`.

## Links

- Website: [codeskop.com](https://www.codeskop.com)
- GitHub: [github.com/Codeskop-io](https://github.com/Codeskop-io)
- License: [MIT](./LICENSE)
