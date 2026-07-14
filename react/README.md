# `@codeskop/tracker-react`

First-class React integration for [`@codeskop/tracker`](https://www.npmjs.com/package/@codeskop/tracker)
— a provider, an error boundary, and a hook. Same commercial, licensed
distribution as the core package (private registry + per-customer token +
runtime plan gate) — see
[`docs/04-security-and-licensing.md`](https://github.com/Codeskop-io/web-sdk/blob/main/docs/04-security-and-licensing.md).

## Install

```bash
npm install @codeskop/tracker @codeskop/tracker-react
```

Requires the same private-registry `.npmrc` as the core package — see
[`docs/06-integration-guide.md`](https://github.com/Codeskop-io/web-sdk/blob/main/docs/06-integration-guide.md).

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

See the full [integration guide](https://github.com/Codeskop-io/web-sdk/blob/main/docs/06-integration-guide.md#64-react) for
initialization order, staging vs. production, and troubleshooting.
