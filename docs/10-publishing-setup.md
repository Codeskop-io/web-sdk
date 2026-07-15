# 10. Web SDK — Publishing Setup (npmjs.com)

> **This entire document is a manual runbook for a human with npmjs.com account
> access.** Nothing in it can be done by an agent working in this repo — there are no
> real npmjs.com credentials in this environment, and none should ever be added to it.
> Everything on the *code* side (package.json readiness, `npm pack` validation, docs)
> is already done; the one remaining step is below, and it is **not done** until a
> human completes it.

## 10.0 Step-by-step: publishing v1.0.0 (start here)

You've already created the **`codeskop-io`** npm org (the name `codeskop` was taken,
hence the scope is `@codeskop-io`, not `@codeskop` — every doc, `package.json`, import,
and CI workflow in this repo was updated to match). Everything on the *code* side of
this release is done and verified: both packages are at `1.0.0`, scoped
`@codeskop-io/tracker` / `@codeskop-io/tracker-react`, public + MIT, build clean, full
test suite green (403 core + 15 react), `api:update:all` baselines regenerated with
zero surface drift, SBOM regenerated, `npm publish --dry-run` confirms `public access`
for both packages. What's left is entirely manual, on npmjs.com and GitHub — nothing
past this point can be done by an agent:

1. **Generate the Automation token** (§10.2(b)) from the `codeskop-io` org: Access
   Tokens → new **Automation** token → scope it to `@codeskop-io/*` with publish
   rights → copy it (shown once).
2. **Add it as a GitHub Actions secret** (§10.2(c)): `Codeskop-io/web-sdk` → Settings →
   Secrets and variables → Actions → New repository secret → name it exactly
   `NPM_TOKEN` → paste the token.
3. **Merge the PR carrying this rename + version bump** into `development`. That merge
   alone triggers `publish-dev.yml`, which publishes a `next`-tagged **prerelease** for
   both packages — treat this as your first real signal that steps 1–2 actually work,
   before cutting the real release.
4. **Verify the prerelease published:** `npm view @codeskop-io/tracker@next` and
   `npm view @codeskop-io/tracker-react@next` should both resolve to a
   `1.0.0-dev.<sha>`-shaped version, no auth needed.
5. **Tag the merged commit** to cut the real release:
   ```bash
   git checkout development && git pull
   git tag v1.0.0
   git push origin v1.0.0
   ```
   This triggers `release.yml`.
6. **Watch the `release.yml` run** in GitHub Actions (`Codeskop-io/web-sdk` → Actions).
   It re-runs the full gate suite (lint/typecheck/test/build/api-check/size-limit/e2e),
   verifies the tag matches `package.json`'s version (`1.0.0`, already bumped, along
   with `src/core/version.ts`'s `SDK_VERSION` literal), publishes both packages to the
   `latest` dist-tag, and cuts a GitHub Release via `gh release create`.
7. **Verify the real publish** (§10.5): `npm view @codeskop-io/tracker` shows `1.0.0`
   under `dist-tags.latest`, no auth needed — it's a public package. Then do a real
   install check in a throwaway project: `npm install @codeskop-io/tracker` with **no
   `.npmrc` entry at all**, and confirm `import { init } from "@codeskop-io/tracker"`
   resolves.
8. **Confirm the actual restriction is the runtime gate, not the install:**
   `init()` that fresh install against a valid staging/production key (should capture
   and send) and separately against an inactive/garbage key (should be a silent no-op)
   — see `docs/04-security-and-licensing.md` §4.6. This is the check that actually
   matters: anyone can now install the package, but only an active plan makes it do
   anything.

If `release.yml` fails specifically on the provenance step, check
`.github/workflows/release.yml`'s top-level `permissions:` block still has
`id-token: write` (§10.4) — it's already present as of this release, called out here
in case a future workflow edit accidentally drops it.

## 10.1 Decision

Per Phase 14 (revised 2026-07-15, D11): `@codeskop-io/tracker` and `@codeskop-io/tracker-react`
publish to the **public npm registry** (`registry.npmjs.org`, `@codeskop-io` scope,
`publishConfig.access: "public"`) — not GitHub Packages, and not a private/restricted
scope. Anyone can `npm install` either package; no per-customer install token exists.
The commercial restriction lives entirely in the runtime plan gate (`docs/04` §4.6),
not in install access. Both package.json files carry:

```json
"publishConfig": {
  "access": "public",
  "registry": "https://registry.npmjs.org/",
  "provenance": true
}
```

`provenance: true` is a genuine, documented `publishConfig` key (not just a CLI flag) —
npm builds and attaches a signed provenance attestation automatically on publish. It
only works when the publish is run from a **supported cloud CI provider** (GitHub
Actions or GitLab CI/CD) with OIDC — see §10.4. A local `npm publish` (even with real
credentials) will not satisfy it; that's expected and by design — provenance is meant
to prove the package came from CI, not from someone's laptop.

> **Note on the reversal:** the original Phase 14 plan published these packages to a
> private, restricted scope behind per-customer install tokens. That was reversed
> before any real publish happened, once it was clear the private registry protected
> nothing the browser doesn't already expose (the SDK's source is inspectable on any
> page that runs it) — it only added install friction. See `docs/04-security-and-licensing.md`
> §4.6 and `web-sdk-workflow.md` Phase 14 for the full rationale. Public, MIT-licensed
> distribution puts this SDK on the same footing as the Android SDK (public Maven
> Central).

## 10.2 One-time manual setup (human with npmjs.com access only)

### (a) Create the `@codeskop-io` org/scope

1. Sign in to [npmjs.com](https://www.npmjs.com/) with an account that will administer
   the organization.
2. Create the **`codeskop-io`** organization (Settings → Organizations → Create
   Organization) if it doesn't already exist. This is what makes `@codeskop-io/...`
   package names resolvable as a scope you control. **Public scoped packages are free**
   on npm — no paid plan is required for `publishConfig.access: "public"` (that
   requirement only applies to *private/restricted* packages, which this scope no
   longer publishes).
3. Add any teammates who need publish rights as org members with the appropriate role.

### (b) Generate an Automation access token

1. From the `codeskop-io` org (or a machine/bot account with publish rights to it), go to
   **Access Tokens** in npmjs.com account settings.
2. Generate a new **Automation** token (not "Publish" — Automation tokens are the type
   meant for unattended CI publishing and bypass 2FA-on-publish prompts).
3. Scope it to the `@codeskop-io` packages/org only (not "all packages" on the account),
   with publish permission. This token is **org-side, publish-only** — there is no
   customer-facing counterpart anymore, since installing the package requires no token
   at all.
4. Copy the token immediately — npmjs.com shows it only once.

### (c) Add it as a GitHub Actions secret

1. In `Codeskop-io/web-sdk` on GitHub: **Settings → Secrets and variables → Actions →
   New repository secret**.
2. Name it exactly **`NPM_TOKEN`**.
3. Paste the Automation token from (b) as the value. Save.
4. Confirm no other workflow or log ever echoes this value; rotate it (repeat (b)–(c))
   if it's ever exposed.

## 10.3 What CI does with it (once (a)–(c) are done)

A publish workflow reads the secret into the standard npm CI auth env var and runs the
usual publish command per package:

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: 22
    registry-url: https://registry.npmjs.org/
- run: npm ci
- run: npm publish --workspace=. # @codeskop-io/tracker
  env:
    NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
- run: npm publish --workspace=react # @codeskop-io/tracker-react
  env:
    NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

## 10.4 Provenance's extra CI requirement

Because both packages set `publishConfig.provenance: true`, the publish job also needs
OIDC token permission so npm can mint the attestation:

```yaml
permissions:
  id-token: write
  contents: read
```

Without this permission block, a real (non-dry-run) `npm publish` from GitHub Actions
will fail specifically on the provenance step even with a valid `NPM_TOKEN` — that
failure mode is expected until this permission is added to the workflow.

## 10.5 Verifying it worked (for whoever does this)

- `npm view @codeskop-io/tracker` resolves and shows the published version — no auth
  needed, it's a public package.
- The npmjs.com package page shows a "Provenance" badge with a link to the GitHub
  Actions run and source commit.
- A throwaway project can `npm install @codeskop-io/tracker` with **no `.npmrc` entry at
  all** — the fastest real-world check that public distribution actually works.
- Initializing that install against a real key confirms the runtime gate is what's
  actually doing the restricting: an inactive/unlicensed key should still yield a
  silent no-op (`docs/04` §4.6), even though the install itself succeeded.

## 10.6 Status

**Not done — the `codeskop-io` org exists, the actual `v1.0.0` publish doesn't yet.**
§10.0 is the concrete remaining checklist; see the Phase 14 tracker entry in
[`../web-sdk-workflow.md`](../web-sdk-workflow.md) for the fuller history. Everything
on the code side — the `@codeskop-io` rename, the `1.0.0` version bump (both
`package.json`s + `src/core/version.ts`'s `SDK_VERSION`), public access + MIT license,
`npm publish --dry-run`, `npm pack` tarball audit, regenerated API reports/SBOM, and
the runtime plan-gate re-verification — is done and doesn't require npmjs.com access.
