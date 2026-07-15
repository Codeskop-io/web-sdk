# `@codeskop/tracker-react`

[![npm version](https://img.shields.io/npm/v/@codeskop/tracker-react.svg)](https://www.npmjs.com/package/@codeskop/tracker-react)
[![license](https://img.shields.io/npm/l/@codeskop/tracker-react.svg)](./LICENSE)

First-class React integration for [`@codeskop/tracker`](https://www.npmjs.com/package/@codeskop/tracker)
— a provider, an error boundary, and a hook. Same free, MIT-licensed public
distribution as the core package — installing needs no token or signup; a
runtime plan gate is what actually restricts capture (invalid/unlicensed key
⇒ safe no-op) — see
[`docs/04-security-and-licensing.md`](https://github.com/Codeskop-io/web-sdk/blob/main/docs/04-security-and-licensing.md).

## Install

```bash
npm install @codeskop/tracker @codeskop/tracker-react
```

No `.npmrc` or install token needed — both packages are public. See
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
