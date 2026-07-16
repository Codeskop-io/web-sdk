# 10. Web SDK — Publishing Setup (npmjs.com)

> **This entire document is a manual runbook for a human with npmjs.com account
> access.** Nothing in it can be done by an agent working in this repo — there are no
> real npmjs.com credentials in this environment, and none should ever be added to it.
> Everything on the *code* side (package.json readiness, `npm pack` validation, docs)
> is already done; the one remaining step is below, and it is **not done** until a
> human completes it.

## 10.0 Step-by-step: publishing v1.0.0 (start here)

You've already created the **`codeskop`** npm org — the package scope is `@codeskop`,
matching what's already in every doc, `package.json`, import, and CI workflow in this
repo (a brief attempt to use `@codeskop-io` instead, on the assumption `codeskop` was
taken, was fully reverted once `codeskop` turned out to be available after all — see
`web-sdk-workflow.md` Phase 14's revision note). Everything on the *code* side of
this release is done and verified: both packages are at `1.0.0`, scoped
`@codeskop/tracker` / `@codeskop/tracker-react`, public + MIT, build clean, full
test suite green (403 core + 15 react), `api:update:all` baselines regenerated with
zero surface drift, SBOM regenerated, `npm publish --dry-run` confirms `public access`
for both packages. What's left is entirely manual, on npmjs.com and GitHub — nothing
past this point can be done by an agent:

1. **Generate a granular access token** (§10.2(b)) from the `codeskop` org: Access
   Tokens → **Generate New Token** → **Granular Access Token** → Read and write →
   scope it to `@codeskop`/`codeskop` → copy it (shown once).
2. **Add it as a GitHub Actions secret** (§10.2(c)): `Codeskop-io/web-sdk` → Settings →
   Secrets and variables → Actions → New repository secret → name it exactly
   `NPM_TOKEN` → paste the token.
3. **Merge the PR carrying this rename + version bump** into `development`. That merge
   alone triggers `publish-dev.yml`, which publishes a `next`-tagged **prerelease** for
   both packages — treat this as your first real signal that steps 1–2 actually work,
   before cutting the real release.
4. **Verify the prerelease published:** `npm view @codeskop/tracker@next` and
   `npm view @codeskop/tracker-react@next` should both resolve to a
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
7. **Verify the real publish** (§10.5): `npm view @codeskop/tracker` shows `1.0.0`
   under `dist-tags.latest`, no auth needed — it's a public package. Then do a real
   install check in a throwaway project: `npm install @codeskop/tracker` with **no
   `.npmrc` entry at all**, and confirm `import { init } from "@codeskop/tracker"`
   resolves.
8. **Confirm the actual restriction is the runtime gate, not the install:**
   `init()` that fresh install against a valid staging/production key (should capture
   and send) and separately against an inactive/garbage key (should be a silent no-op)
   — see `docs/04-security-and-licensing.md` §4.6. This is the check that actually
   matters: anyone can now install the package, but only an active plan makes it do
   anything.

## 10.1 Decision

Per Phase 14 (revised 2026-07-15, D11): `@codeskop/tracker` and `@codeskop/tracker-react`
publish to the **public npm registry** (`registry.npmjs.org`, `@codeskop` scope,
`publishConfig.access: "public"`) — not GitHub Packages, and not a private/restricted
scope. Anyone can `npm install` either package; no per-customer install token exists.
The commercial restriction lives entirely in the runtime plan gate (`docs/04` §4.6),
not in install access. Both package.json files carry:

```json
"publishConfig": {
  "access": "public",
  "registry": "https://registry.npmjs.org/"
}
```

> **No `provenance: true` here — deliberately removed 2026-07-16.** npm provenance
> attestations require GitHub's OIDC build metadata to be recorded in the *public*
> Sigstore transparency log, which npm can only verify when the **source repository
> itself is public**. `Codeskop-io/web-sdk` is private (matching every other repo in
> this workspace), so a real publish with `--provenance` fails
> at the registry-verification step with `422 ... Unsupported GitHub Actions source
> repository visibility: "private"`. See §10.6.2 for the incident and the two options
> that were on the table (drop provenance vs. make the repo public) — dropping
> provenance was chosen to keep the source private. If this repo is ever made public,
> provenance can be turned back on (`publishConfig.provenance: true` + `--provenance`
> in both workflows + `id-token: write` in their `permissions:` blocks — see git history
> for the exact prior state).

> **Note on the reversal:** the original Phase 14 plan published these packages to a
> private, restricted scope behind per-customer install tokens. That was reversed
> before any real publish happened, once it was clear the private registry protected
> nothing the browser doesn't already expose (the SDK's source is inspectable on any
> page that runs it) — it only added install friction. See `docs/04-security-and-licensing.md`
> §4.6 and `web-sdk-workflow.md` Phase 14 for the full rationale. Public, MIT-licensed
> distribution puts this SDK on the same footing as the Android SDK (public Maven
> Central).

## 10.2 One-time manual setup (human with npmjs.com access only)

### (a) Create the `@codeskop` org/scope

1. Sign in to [npmjs.com](https://www.npmjs.com/) with an account that will administer
   the organization.
2. Create the **`codeskop`** organization (Settings → Organizations → Create
   Organization) if it doesn't already exist. This is what makes `@codeskop/...`
   package names resolvable as a scope you control. **Public scoped packages are free**
   on npm — no paid plan is required for `publishConfig.access: "public"` (that
   requirement only applies to *private/restricted* packages, which this scope no
   longer publishes).
3. Add any teammates who need publish rights as org members with the appropriate role.

### (b) Generate a CI publish token

npmjs.com's current token UI is **granular access tokens** — there is no explicit
"Automation" token type to pick anymore (that was the legacy token system). A granular
token is still subject to your **account-level** two-factor setting, which is the part
that actually determines whether CI can publish without a live OTP:

1. **First, set the account's 2FA mode to "Authorization only"** (not "Authorization
   and Publishing"): npmjs.com → your avatar → **Account Settings** → **Two-Factor
   Authentication** → change the mode. This still requires 2FA to log in and manage the
   account; it's specifically the *publish* action that stops demanding a live OTP —
   which is what CI needs, since no GitHub Actions runner has an authenticator.
   **Skipping this step is the #1 cause of CI publish failing with `npm error code
   EOTP` / "This operation requires a one-time password"** — confirmed for real: the
   first `publish-dev.yml` run against a granular token with the account still on
   "Authorization and Publishing" failed exactly this way (see §10.6.1 below).
2. From the `codeskop` org (or a machine/bot account with publish rights to it), go to
   **Access Tokens** in npmjs.com account settings → **Generate New Token** → **Granular
   Access Token**.
3. Permissions: **Read and write**. Under **Packages and scopes**, choose "Only select
   packages and scopes" and select the **`@codeskop`** scope (not "All packages"). Under
   **Organizations**, select **`codeskop`**. This token is **org-side, publish-only** —
   there is no customer-facing counterpart anymore, since installing the package
   requires no token at all.
4. Copy the token immediately — npmjs.com shows it only once.

### (c) Add it as a GitHub Actions secret

1. In `Codeskop-io/web-sdk` on GitHub: **Settings → Secrets and variables → Actions →
   New repository secret**.
2. Name it exactly **`NPM_TOKEN`**.
3. Paste the token from (b) as the value. Save.
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
- run: npm publish --workspace=. # @codeskop/tracker
  env:
    NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
- run: npm publish --workspace=react # @codeskop/tracker-react
  env:
    NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

## 10.4 Provenance's extra CI requirement (historical — provenance is now off)

**Provenance was removed 2026-07-16 (see §10.1's note and §10.6.2) — neither workflow
needs `id-token: write` anymore.** This section is kept as a pointer for whoever
revisits this if the repo is ever made public and provenance is turned back on: it
requires `publishConfig.provenance: true` in both `package.json`s, `--provenance` added
back to both `npm publish` commands, and `id-token: write` added back to each
workflow's top-level `permissions:` block (alongside whatever `contents:` level that
workflow already needs) — the OIDC token minting only happens with that permission
present, and a real (non-dry-run) `npm publish --provenance` fails without it.

## 10.5 Verifying it worked (for whoever does this)

- `npm view @codeskop/tracker` resolves and shows the published version — no auth
  needed, it's a public package.
- A throwaway project can `npm install @codeskop/tracker` with **no `.npmrc` entry at
  all** — the fastest real-world check that public distribution actually works.
- Initializing that install against a real key confirms the runtime gate is what's
  actually doing the restricting: an inactive/unlicensed key should still yield a
  silent no-op (`docs/04` §4.6), even though the install itself succeeded.
- There is **no "Provenance" badge** on the npmjs.com package page — that's expected,
  not a sign something's wrong; provenance is deliberately off (§10.1, §10.6.2).

## 10.6 Status

**Not done — the `codeskop` org exists, a real publish has been attempted three times
and hasn't succeeded yet** (§10.6.1, §10.6.2). §10.0 is the concrete remaining
checklist, now with provenance removed from both workflows and both `package.json`s —
the next `publish-dev.yml` run (with a still-valid, non-EOTP'd `NPM_TOKEN`) should get
past both prior failure points. See the Phase 14 tracker entry in
[`../web-sdk-workflow.md`](../web-sdk-workflow.md) for the fuller history. Everything
on the code side — the `@codeskop` rename, the `1.0.0` version bump (both
`package.json`s + `src/core/version.ts`'s `SDK_VERSION`), public access + MIT license
without provenance, `npm publish --dry-run`, `npm pack` tarball audit, regenerated API
reports/SBOM, and the runtime plan-gate re-verification — is done and doesn't require
npmjs.com access.

### 10.6.1 Real incident: first two `publish-dev.yml` runs failed with `EOTP`

The first live CI publish attempt (merge to `development`, triggering `publish-dev.yml`'s
`next`-tag prerelease) got all the way through building the tarball, signing provenance,
and starting the actual registry write — then failed:

```
npm error code EOTP
npm error This operation requires a one-time password from your authenticator.
```

First attempted fix: switched the npm account's 2FA mode from "Authorization and
Publishing" to "Authorization only" (§10.2(b) step 1), then re-ran the same failed job
against the **same** existing `NPM_TOKEN`. **This did not clear the error** — the
re-run failed with the identical `EOTP` error. So the account-level 2FA mode alone was
not sufficient (or didn't take effect for that specific already-issued token — not
fully confirmed which). What actually cleared it: generating a **brand-new granular
access token** after the 2FA mode change, and replacing the `NPM_TOKEN` secret with it.
That run got past authentication cleanly and failed on a different, later error
instead (§10.6.2) — confirming `EOTP` was resolved. **Takeaway: if `EOTP` persists
after changing the account's 2FA mode, don't just re-run the same job — generate a
fresh token and update the secret before retrying.**

### 10.6.2 Real incident: `EOTP` fixed, next run failed with `422` on provenance

With a fresh token, the next `publish-dev.yml` run authenticated fine, built the
tarball, and even successfully **signed** the provenance attestation — then failed at
the registry's verification step:

```
npm error code E422
npm error 422 Unprocessable Entity - PUT https://registry.npmjs.org/@codeskop%2ftracker
npm error Error verifying sigstore provenance bundle: Unsupported GitHub Actions source
npm error repository visibility: "private". Only public source repositories are
npm error supported when publishing with provenance.
```

Root cause: npm provenance requires the GitHub Actions OIDC attestation to be recorded
in the **public** Sigstore transparency log, which npm can only verify against a
**public** source repository. `Codeskop-io/web-sdk` is private (by design — every repo
in this workspace is), so provenance can never succeed here regardless of tokens, 2FA,
or permissions — this was a structural incompatibility, not a misconfiguration.

Two options existed: make the repo public (keeps provenance, reverses this workspace's
private-repos convention for the SDK's actual source), or drop provenance (keeps the
repo private, loses the "Provenance" badge/attestation). **Decision: drop provenance**
— removed `publishConfig.provenance` from both `package.json`s, `--provenance` from
both `npm publish` commands in `publish-dev.yml`/`release.yml`, and the now-unneeded
`id-token: write` permission from both workflows. Nothing else about the publish
changed. See §10.1's note for how to turn it back on if this repo is ever made public.
