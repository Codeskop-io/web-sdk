# 10. Web SDK — Publishing Setup (npmjs.com)

> **This entire document is a manual runbook for a human with npmjs.com account
> access.** Nothing in it can be done by an agent working in this repo — there are no
> real npmjs.com credentials in this environment, and none should ever be added to it.
> Everything on the *code* side of Phase 14 (package.json readiness, `npm pack`
> validation, docs) is already done; the one remaining step is below, and it is
> **not done** until a human completes it.

## 10.1 Decision

Per Phase 14: `@codeskop/tracker` and `@codeskop/tracker-react` publish to the
**private npm registry** (`registry.npmjs.org`, `@codeskop` scope,
`publishConfig.access: "restricted"`) — not GitHub Packages. Both package.json files
already carry:

```json
"publishConfig": {
  "access": "restricted",
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

## 10.2 One-time manual setup (human with npmjs.com access only)

### (a) Create the `@codeskop` org/scope

1. Sign in to [npmjs.com](https://www.npmjs.com/) with an account that will administer
   the organization.
2. Create the **`codeskop`** organization (Settings → Organizations → Create
   Organization) if it doesn't already exist. This is what makes `@codeskop/...`
   package names resolvable as a scope you control.
3. Confirm the org is on a **paid plan that supports private packages**
   (`publishConfig.access: "restricted"` requires this — the free npm org tier only
   allows public scoped packages). Upgrade if needed.
4. Add any teammates who need publish rights as org members with the appropriate role.

### (b) Generate an Automation access token

1. From the `codeskop` org (or a machine/bot account with publish rights to it), go to
   **Access Tokens** in npmjs.com account settings.
2. Generate a new **Automation** token (not "Publish" — Automation tokens are the type
   meant for unattended CI publishing and bypass 2FA-on-publish prompts).
3. Scope it to the `@codeskop` packages/org only (not "all packages" on the account),
   with publish permission.
4. Copy the token immediately — npmjs.com shows it only once.

> This is a **different** token from the per-customer **read-only install tokens**
> described in [`docs/04-security-and-licensing.md`](./04-security-and-licensing.md)
> §4.6 and [`docs/06-integration-guide.md`](./06-integration-guide.md) §6.2. This one
> is org-side and can publish; those are customer-side and can only install.

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
- run: npm publish --workspace=. # @codeskop/tracker
  env:
    NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
- run: npm publish --workspace=react # @codeskop/tracker-react
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

- `npm view @codeskop/tracker` (with a token that can read it) resolves and shows the
  published version.
- The npmjs.com package page shows a "Provenance" badge with a link to the GitHub
  Actions run and source commit.
- A throwaway project with the customer `.npmrc` from `docs/06` §6.2 (a **read-only**
  token, not the Automation one) can `npm install @codeskop/tracker`.

## 10.6 Status

**Not done.** This is the one remaining manual step blocking an actual publish; see the
Phase 14 tracker entry in [`../web-sdk-workflow.md`](../web-sdk-workflow.md). Everything
else in Phase 14 — `package.json` publish readiness, `npm publish --dry-run`, `npm pack`
tarball audit, the customer `.npmrc` snippet, and the runtime plan-gate re-verification —
is done and doesn't require npmjs.com access.
