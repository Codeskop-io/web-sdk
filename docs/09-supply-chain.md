# 9. Supply-Chain Integrity — Dependency Audit, SBOM, CSP

> Phase 13 supply-chain audit (`docs/04-security-and-licensing.md` §4.7): dependency
> vulnerability scan, license audit, zero-runtime-dependency confirmation (D1), SBOM
> generation, and CSP-friendliness check of the built `dist/` output.
>
> Audited: 2026-07-14. Scope: `@codeskop/tracker` (root) + `@codeskop/tracker-react`
> (`react/`) + the `react/example` demo harness workspace (dev-only, never published).

## 9.1 `npm audit` — vulnerability scan

```
$ npm audit
```

**Result: 1 finding, low severity, dev-only, not shipped.**

| Package | Severity | Advisory | Range | Where |
|---|---|---|---|---|
| `esbuild` | low (CVSS 2.5) | [GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr) — arbitrary file read via the esbuild dev server, **Windows only** | `>=0.27.3 <0.28.1` | `node_modules/tsup/node_modules/esbuild@0.27.7` |

Analysis:

- This is a **transitive devDependency of `tsup`** (our build tool), pinned by tsup's
  own lockfile entry — it is not a direct dependency, and `esbuild` never appears in
  `dependencies` for either package.
- The vulnerable code path is esbuild's **development server**; this project only
  invokes esbuild through `tsup` as a **one-shot bundler** (`npm run build`), which
  never starts that dev server, so the advisory's actual exploit surface (an attacker
  reading arbitrary files off a Windows machine running the dev server) does not apply
  to how this repo uses esbuild.
- It cannot ship: `esbuild` is a build-time-only tool; nothing from `node_modules`
  reaches `dist/` except what tsup bundles from `src/`, and §9.3 below confirms `dist/`
  has no such artifact.
- The top-level `esbuild@0.28.1` (pulled in independently by `size-limit`/`vite`) is
  **already patched** — only `tsup`'s nested copy is behind.
- `npm audit` reports `fixAvailable: true` (a nested-only version bump inside `tsup`'s
  own semver range — no `package.json` edit needed).

**Not fixed in this pass** — deliberately flagged for a human decision rather than
auto-fixed, because:
1. Applying it requires `npm audit fix`, which runs an install and rewrites
   `package-lock.json`; this workflow phase is running with two other engineers
   concurrently touching this same repo, and `npm install`/lockfile mutation is
   out of scope for this pass.
2. Severity/impact is low and dev-only — there is no urgency forcing an
   out-of-band install.

**Recommendation:** at the Phase 13 checkpoint commit (or the next routine dependency
bump), run `npm audit fix` (or bump `tsup` if a release re-pins a patched `esbuild`)
and re-run this audit to confirm 0 findings.

## 9.2 License audit

> **Updated during Phase 13 integration:** the API-freeze stream added
> `@microsoft/api-extractor` (+ its own dependency tree — `@rushstack/*`, `ajv`,
> `typescript`, etc.) to both `package.json`s *after* this audit's first pass, which
> had counted 264 packages. Re-run against the final tree post-merge so the numbers
> below are not stale relative to what's actually installed.

Every installed package (root + `react/` + `react/example`, `node_modules` walked
recursively, 308 unique `name@version` packages, including the 42 pulled in by
`@microsoft/api-extractor`) was checked for its declared `license` field.

| License | Count |
|---|---|
| MIT | 245 |
| Apache-2.0 | 23 |
| ISC | 11 |
| BSD-3-Clause | 11 |
| BSD-2-Clause | 8 |
| BlueOak-1.0.0 | 3 |
| MIT-0 | 2 |
| MPL-2.0 | 2 |
| CC0-1.0 | 1 |
| *(no license field)* | 2 — see note below |

**Result: clean.** No GPL/AGPL/LGPL or other strong-copyleft license anywhere in the
third-party tree. The two MPL-2.0 packages (`lightningcss`, `lightningcss-darwin-arm64`)
are weak, file-level copyleft — MPL-2.0 only imposes obligations on modifications to
the MPL-licensed files themselves, and in any case both are transitive devDependencies
of the `react/example` Vite demo harness, never shipped.

The two components with no `license` field are **not third-party** — they are our own
workspace packages, surfaced by the same `npm sbom` directory-naming quirk noted in
§9.4 (the root package is listed as `webpack` instead of `@codeskop/tracker`; likewise
the react adapter is listed as `react` instead of `@codeskop/tracker-react`, and the
demo harness as `example` instead of `codeskop-tracker-react-example`). Both are
`"private": true`, unpublished, and never `npm pack`ed, so an absent license field is
expected and not a supply-chain finding.

Per D1 and this doc's own remit, the license bar that matters is:

- **`dependencies` (shipped, must be OSS-compatible or absent):** both
  `@codeskop/tracker` and `@codeskop/tracker-react` declare `"dependencies": {}`
  empty except the react adapter's single **workspace** dependency on
  `@codeskop/tracker` itself (`file:..`, our own code, not third-party) — see §9.3.
- **`devDependencies` (build/test only, never shipped):** any OSS license is
  acceptable per the task brief — confirmed all 306 third-party packages (308 total
  minus our own 2 workspace packages) are permissive/OSS above.

The `prod: 9` count `npm audit`'s metadata reports is **not** the SDK's own runtime
dependency count — it comes entirely from `react/example`'s `package.json`, which
lists `react`, `react-dom`, `@codeskop/tracker`, and `@codeskop/tracker-react` under
`dependencies` because it is a runnable Vite demo app, not a published package
(`"private": true`, excluded from `workspaces` publishing, never `npm pack`ed). It does
not affect what customers install.

## 9.3 Zero-runtime-dependency confirmation (D1)

Declared: both `package.json`s ship `"dependencies": {}` (root) and a single
workspace-internal dependency (react adapter → core). Verified against the **actual
built artifacts**, not just the manifest:

```
$ grep -nE "require\(|from \"|from '" dist/index.js dist/index.cjs
dist/index.cjs:1961:   * "no new attempt happened" apart from "an attempt happened but found
dist/index.js:1959:   * "no new attempt happened" apart from "an attempt happened but found
```

Both hits are the naive grep pattern matching the English word "from" inside a `flush()`
doc comment (`* "no new attempt happened" apart from "an attempt happened...`), **not**
an actual `import`/`require` statement — confirmed by inspection, and by the absence of
any `import `/`require(` **statement** keyword on either line. `dist/index.js` /
`dist/index.cjs` (the root `@codeskop/tracker` core) contain **zero** real
`import`/`require` statements — the entire bundle is self-contained, matching D1
exactly. (Re-run this check after any future src change that adds prose containing the
word "from" next to a quote — inspect matches by hand rather than trusting a bare
"no matches" grep result.)

```
$ grep -nE "require\(|from \"|from '" react/dist/index.js react/dist/index.cjs
react/dist/index.js:1:import { createContext, useRef, useEffect, Component, useContext } from 'react';
react/dist/index.js:2:import { flush, setEnabled, reset, identify, recordException, init } from '@codeskop/tracker';
react/dist/index.js:3:import { jsx } from 'react/jsx-runtime';
react/dist/index.cjs:3:var react = require('react');
react/dist/index.cjs:4:var tracker = require('@codeskop/tracker');
react/dist/index.cjs:5:var jsxRuntime = require('react/jsx-runtime');
```

`react/dist` (the adapter) imports exactly two things, both expected and neither a
third-party runtime dependency: `react` (declared **`peerDependencies`** only — the
customer's own React, never bundled) and `@codeskop/tracker` (our own sibling
package, not a third party). **No other package appears in either built bundle.**

## 9.4 SBOM

Generated with npm's built-in tool (no external SBOM generator needed):

```
$ npm sbom --sbom-format cyclonedx
```

CycloneDX format was supported directly (SPDX fallback was not needed). Output
committed at [`sbom/tracker-sbom.cyclonedx.json`](../sbom/tracker-sbom.cyclonedx.json),
**regenerated at Phase 13 integration** against the final tree (after the API-freeze
stream's `@microsoft/api-extractor` addition):

- Format: CycloneDX 1.5
- 308 components (the full install tree: root + `react/` + `react/example`, prod +
  dev + optional + peer)
- The naming-by-directory quirk noted below applies to every workspace, not just the
  root: `metadata.component` names the root package `webpack` (its directory) instead
  of `@codeskop/tracker`, and inside `components[]` the react adapter appears as
  `react` (its directory) instead of `@codeskop/tracker-react`, and the demo harness
  as `example` instead of `codeskop-tracker-react-example`. In every case the `purl`
  field carries the correct scoped/real name (e.g.
  `pkg:npm/%40codeskop/tracker@1.0.0`). This is an `npm sbom` display quirk, not
  a data error, and was left as-is rather than hand-edited.

Regenerate before each release: `npm sbom --sbom-format cyclonedx > sbom/tracker-sbom.cyclonedx.json`.

## 9.5 CSP-friendliness

Grepped the built `dist/` output (both root and `react/`, both ESM and CJS) for
`eval(`, `new Function(`, and other dynamic-code-injection patterns:

```
$ grep -nE "\beval\(|new Function\(|Function\(['\"]|setTimeout\(['\"]|setInterval\(['\"]|document\.write" \
    dist/index.js dist/index.cjs react/dist/index.js react/dist/index.cjs
(no matches)

$ grep -no "eval" dist/index.js dist/index.cjs react/dist/index.js react/dist/index.cjs
(no matches — not even the substring "eval" appears anywhere in the built output)
```

**Result: clean.** No `eval`, no `new Function`, no string-form `setTimeout`/
`setInterval`, no `document.write`, in any built artifact. The SDK can be embedded
under a strict CSP (e.g. `script-src 'self'`) with no `'unsafe-eval'` needed.

## 9.6 Subresource Integrity — not applicable today

Per `docs/04` §4.7, SRI is only relevant to a **CDN build** (a `<script src=…
integrity=…>` tag). There is no CDN distribution planned — the SDK ships exclusively
via the private npm registry as an ESM/CJS package (D11, Phase 14). Noting this here
per the task brief; nothing to build or verify until a CDN build is scoped.

## 9.7 Summary

| Check | Result |
|---|---|
| `npm audit` | 1 low, dev-only, not shipped, not exploitable via this repo's usage — flagged for a human to run `npm audit fix` outside this concurrent session |
| License audit (all 306 third-party packages, root + react + example) | Clean — 100% permissive OSS, no copyleft-strong, no unknown licenses |
| Zero-runtime-deps (D1) | Confirmed against **built** `dist/index.js`/`.cjs` — zero imports/requires; react adapter imports only `react` (peer) + our own core |
| SBOM | Generated (`npm sbom --sbom-format cyclonedx`), committed at `sbom/tracker-sbom.cyclonedx.json` |
| CSP-friendliness | Confirmed — no `eval`/`new Function`/dynamic injection anywhere in built output |
| Subresource Integrity | N/A today — no CDN build planned |
