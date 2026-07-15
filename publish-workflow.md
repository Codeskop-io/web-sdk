# Web SDK Publish & Release Workflow (`@codeskop-io/tracker` + `@codeskop-io/tracker-react`)

> The operational counterpart to [`web-sdk-workflow.md`](./web-sdk-workflow.md): not
> "how the SDK was built" but **"how a commit becomes a version someone can
> `npm install`."** Covers the three GitHub Actions workflows, the manual
> version-bump-then-tag release process, the `next`/`latest` dist-tag scheme, the
> `NPM_TOKEN` secret they all depend on, and what to do when a published version turns
> out to be bad.
>
> Written against the gap `web-sdk-workflow.md` Phase 15 flagged explicitly: *"no
> `.github/workflows/` directory exists anywhere in this repo, despite the docs
> describing CI steps as already wired."* That gap is now closed — this doc is the
> reference for the three workflow files that closed it.

- **Owner:** Web SDK team
- **Packages:** `@codeskop-io/tracker` (root) · `@codeskop-io/tracker-react` (`react/`) —
  separate publishable units, separate SemVer lines (`docs/07-semver-policy.md` §7.1).
- **Workflow files:** [`.github/workflows/ci.yml`](./.github/workflows/ci.yml) ·
  [`.github/workflows/publish-dev.yml`](./.github/workflows/publish-dev.yml) ·
  [`.github/workflows/release.yml`](./.github/workflows/release.yml)
- **Convention matched:** this repo is one of five independent repos in the workspace
  (`backend`, `landing`, `android`, `ui`, `webpack`) that share one release convention —
  plain-SemVer tags (`vX.Y.Z`, no prefix inside the version itself), a manual version
  bump in the manifest before tagging (no changesets, no semantic-release anywhere in
  this workspace), and `push: tags: ["v*"]` triggering `gh release create
  "$GITHUB_REF_NAME" --generate-notes --title "$GITHUB_REF_NAME"`. This doc adapts that
  convention for an **npm package** rather than a deployed service — the new part is
  the `npm publish` step (and the `next`/`latest` dist-tag scheme it needs), not the
  tagging convention itself.

## 1. The three workflows, at a glance

| File | Trigger | What it does | Needs `NPM_TOKEN`? |
|------|---------|---------------|---------------------|
| [`ci.yml`](./.github/workflows/ci.yml) | `pull_request` → `development` | Full gate suite (below). Nothing is published. | No |
| [`publish-dev.yml`](./.github/workflows/publish-dev.yml) | `push` → `development` (i.e. every merge) | Full gate suite, then publishes a **prerelease** to the `next` dist-tag under a version computed at publish time — no manual bump needed for this path. | Yes — fails loudly if missing |
| [`release.yml`](./.github/workflows/release.yml) | `push` → tag `v*` | Full gate suite, verifies the tag matches the manually-bumped version, then publishes to the `latest` dist-tag and cuts a GitHub Release. | Yes — fails loudly if missing |

All three run the **same gate suite** — there's no reusable/composite workflow
abstracting it out (matching how `backend`'s and `landing`'s `ci.yml`/`release.yml`/
`deploy.yml` are each self-contained too), so the step list is duplicated across the
three files on purpose. If you change a gate, change it in all three.

### 1.1 The gate suite (identical in all three files)

1. `npm ci` (root — installs both workspaces, `react` and `react/example`, via the
   root `package-lock.json`).
2. `npx playwright install --with-deps chromium` (only the e2e step needs this).
3. `npm run lint` — ESLint over the whole tree (core, react adapter, and the demo
   example under `react/example`).
4. `npm run typecheck` (core) → `npm test` (core) → **`npm run build` (core)** →
   `npm run typecheck --workspace=@codeskop-io/tracker-react` (adapter) → `npm run test
   --workspace=@codeskop-io/tracker-react` (adapter) → `npm run build
   --workspace=@codeskop-io/tracker-react` (adapter). **Core's build has to happen before
   the adapter's typecheck/test, not after** — the `react/` workspace resolves
   `@codeskop-io/tracker` through an npm workspace symlink to the repo root, and that
   package's `exports`/`types` fields point at `dist/`, not `src/`; on a clean
   checkout, `react/`'s typecheck and tests fail with "Cannot find module
   '@codeskop-io/tracker'" until core's own `dist/` exists. (This was caught for real —
   see §6 — not just reasoned about: the first live CI run against
   `Codeskop-io/web-sdk` failed on exactly this before the step order was fixed.)
   **Note:** always target the workspace by its full package name
   (`@codeskop-io/tracker-react`), never by directory (`--workspace=react`) — the latter
   also matches the nested `react/example` demo workspace and fails on its missing
   `typecheck`/`lint` scripts. Every workspace-scoped command in these workflows uses
   the full name for this reason. `vitest run --coverage` **fails the job itself** if
   the 80% lines/statements/functions/branches threshold in `vitest.config.ts` isn't
   met — that's the coverage gate; it isn't a separate step.
5. `npm run api:check:all` — the Phase 13 API-freeze check (`api-extractor` against
   the committed baselines `etc/tracker.api.md` / `react/etc/tracker-react.api.md`);
   fails on any undocumented signature drift. Runs after both builds, since its entry
   point is each package's built `dist/index.d.ts`.
6. `npm run size` (core, 12 KB gzipped budget) + `npm run size
   --workspace=@codeskop-io/tracker-react` (adapter, 2.5 KB gzipped budget).
7. `npx playwright test` — real Chromium against the vendored mock ingest server
   (§1.2). `e2e/staging-smoke.spec.ts` is opt-in (`test.skip` unless
   `STAGING_TEST_KEY`/`PRODUCTION_TEST_KEY` is set) and never runs live in any of
   these three workflows.

### 1.2 The vendored mock ingest server

`e2e/fixtures/env.ts` spawns a real Python process to serve `POST /v1/events` +
`GET /v1/config` for the e2e suite. Before this phase, that pointed at
`../backend/mock-ingest-server/server.py` — a relative path that only worked because
`backend` and `webpack` were siblings on someone's laptop. Now that `web-sdk` is its
own GitHub repo (`Codeskop-io/web-sdk`), CI can't reach across to a sibling repo that
doesn't exist in its checkout, so `backend/mock-ingest-server/server.py` (stdlib-only
Python, no dependencies) is **vendored into this repo** at
[`test/mock-ingest-server/server.py`](./test/mock-ingest-server/server.py), and
`e2e/fixtures/env.ts` spawns that copy instead.

**This is a vendored copy, not a shared source of truth** — it can drift from
`backend`'s own copy of `mock-ingest-server/server.py` over time (e.g. if the backend
team changes the mock's behavior to track a contract change). If `docs/07 §7.5`'s
locked ingest contract changes, re-sync this file by hand from `backend`'s copy; there
is no automation tying the two together.

## 2. The dist-tag scheme: `next` vs `latest`

| dist-tag | Published by | Version shape | Who installs it |
|----------|---------------|----------------|-------------------|
| `next` | `publish-dev.yml`, on every merge to `development` | `<package.json version>-dev.<short-sha>`, e.g. `1.0.0-dev.a1b2c3d` | Internal dogfooding / anyone who explicitly opts in with `npm install @codeskop-io/tracker@next` |
| `latest` | `release.yml`, on a `vX.Y.Z` tag | Exactly `package.json`'s version (e.g. `1.0.0`) | Everyone — the default `npm install @codeskop-io/tracker` resolves to whatever `latest` points at |

The `next` version is **computed at publish time**, not written back to
`development` — `publish-dev.yml` mutates `package.json`'s (and
`react/package.json`'s) `version` field in its own checkout, publishes, and then the
job ends; nothing is committed. That's deliberate: `next` exists purely so `next`
always tracks the newest `development` commit without anyone hand-bumping a version
for every single merge — the real, meaningful version bump only happens for a
`latest` release (§3).

**Known limitation:** `src/core/version.ts`'s `SDK_VERSION` literal (stamped into
every event's `context.app.sdk_version`, `docs/03` §3.3) is a manual literal that
mirrors `package.json`'s version **and is only bumped as part of the manual release
process (§3)** — it is *not* touched by `publish-dev.yml`'s computed version. A `next`
prerelease's telemetry `sdk_version` field will therefore read the last hand-bumped
release version (e.g. `1.0.0`), not the synthetic `-dev.<sha>` suffix. This is
a cosmetic gap in an internal-only channel, not a customer-facing one — `latest`
releases don't have this problem, since `release.yml`'s version-match check (§3.2)
fails the release if `SDK_VERSION` wasn't bumped too.

## 3. Cutting a real release (`latest`)

### 3.1 Before tagging (manual)

1. On `development` (or a release branch off it), bump:
   - `package.json`'s `"version"` (core).
   - `react/package.json`'s `"version"` (adapter) — **only if the adapter itself
     changed**; per `docs/07-semver-policy.md` §7.1 the two packages have independent
     SemVer lines, so a core-only release can tag/publish core without also bumping
     the adapter.
   - `src/core/version.ts`'s `SDK_VERSION` literal to match the **core** version
     exactly (this is the one easy-to-forget step — there's no codegen tying it to
     `package.json`, see the file's own doc comment).
2. Commit that bump (e.g. `chore: release v0.2.0`), push, merge to `development`
   through the normal PR flow (so `ci.yml` and then `publish-dev.yml` both run against
   it like any other merge).
3. Tag the merged commit: `git tag v0.2.0 && git push origin v0.2.0` — note **no `v`**
   inside `package.json`'s version, but the git tag **does** carry the `v` prefix, per
   this workspace's shared convention.

### 3.2 What the tag triggers

`release.yml` runs the full gate suite (§1.1), then:

- **Verifies the tag matches `package.json`'s version** (core) and
  `src/core/version.ts`'s `SDK_VERSION` literal — **fails the release** if either was
  missed. (`react/package.json`'s version is checked too, but only produces a
  `::warning::`, not a failure — see the independent-versioning note in §3.1.)
- Publishes `@codeskop-io/tracker` to the `latest` dist-tag:
  `npm publish --tag latest --provenance --access public`.
- Publishes `@codeskop-io/tracker-react` the same way, at **its own** current
  `react/package.json` version (`npm publish --workspace=@codeskop-io/tracker-react
  --tag latest --provenance --access public`).
- Runs `gh release create "$GITHUB_REF_NAME" --generate-notes --title
  "$GITHUB_REF_NAME"` — same convention as `backend`'s and `landing`'s `release.yml`.

`--provenance` and `--access public` here are actually redundant with both
packages' committed `publishConfig` (`docs/10-publishing-setup.md` §10.1) — they're
spelled out explicitly in the workflow anyway so the publish command is
self-documenting without needing to cross-reference `package.json`.

> **2026-07-15: distribution reversed from private/restricted to public** (D11) — see
> `docs/04-security-and-licensing.md` §4.6. `--access public` replaces the original
> `--access restricted` throughout this file and both workflow ymls; the packages are
> MIT-licensed and installable without a token.

## 4. The `NPM_TOKEN` secret

Both `publish-dev.yml` and `release.yml` need an `NPM_TOKEN` repository secret — an
npm **Automation** token scoped to `@codeskop-io/*` with publish rights. **This does not
exist yet** — creating it requires a human with npmjs.com account access, which no
agent or CI job in this workspace has or should have.

**Full one-time setup steps are in
[`docs/10-publishing-setup.md`](./docs/10-publishing-setup.md)** — summarized:

1. Create/confirm the `codeskop-io` npm org (a free org — public scoped packages don't
   require a paid plan).
2. Generate an **Automation** access token (not "Publish") scoped to `@codeskop-io/*`.
3. Add it as a GitHub Actions secret on `Codeskop-io/web-sdk`: **Settings → Secrets
   and variables → Actions → New repository secret**, named exactly `NPM_TOKEN`.

Until that secret exists, both `publish-dev.yml` and `release.yml` are wired
correctly but their publish steps **fail on purpose** with an explicit
`::error::NPM_TOKEN repository secret is not set...` message pointing back at
`docs/10-publishing-setup.md` — not a silent skip. `ci.yml` never touches this secret
and is unaffected.

## 5. Rollback / yank procedure

**Prefer `npm deprecate`, not `npm unpublish`** — this matches
[`docs/13-operations-runbooks.md`](./docs/13-operations-runbooks.md) §13.2, which this
section doesn't duplicate but does ground in npm's actual, current policy (checked
against `docs.npmjs.com`'s unpublish policy directly, not assumed):

- **`npm unpublish` is time- and popularity-gated, not a general-purpose rollback
  tool:**
  - Within **72 hours** of publishing a given version, `npm unpublish
    @codeskop-io/tracker@<version>` is allowed unconditionally, **provided no other
    package depends on it** — the exact scenario a bad `next` prerelease published
    minutes ago by `publish-dev.yml` would be in.
  - After 72 hours, npm only permits it if the package has **no dependents**, **fewer
    than 300 downloads in the trailing week**, and a **single owner** — a real
    `latest` release with any uptake at all will not qualify.
  - Once a specific `name@version` has ever been unpublished, **that exact version
    number can never be reused** — a fixed release needs a new version number, not a
    republish of the old one.
  - If **every** version of a package is unpublished, npm blocks any new publish of
    that package name for **24 hours** afterward.
- **`npm deprecate @codeskop-io/tracker@<bad-version> "<reason>"`** is the practical
  rollback lever for anything already past the unpublish window (i.e. almost any
  `latest` release): it leaves the version installable (so existing lockfiles/CI
  don't break) but prints the given warning on every `npm install` that resolves it,
  and is visible on the npmjs.com package page. Requires the same `NPM_TOKEN`-level
  Automation access as a real publish.
- **The kill-switch is the correct *first* response to "a bad release is actively
  hurting customers right now"** — `docs/13-operations-runbooks.md` §13.1's
  `Environment.ingest_enabled` flip is server-side, version-blind, and takes effect
  for every installed version within the SDK's `GET /v1/config` cache window (≈5
  minutes), with no npm action required at all. Unpublishing/deprecating a bad
  version is the necessary **follow-up** (so nobody installs it again), not the
  incident response.
- **Practical guidance for this repo's two channels:**
  - A bad `next` prerelease (published minutes ago, no realistic external dependents):
    `npm unpublish @codeskop-io/tracker@<version>` is genuinely usable — it's within the
    72-hour/no-dependents case almost by construction, given `next` is meant for
    internal dogfooding. Re-running `publish-dev.yml` (e.g. by pushing another commit
    to `development`) produces a new `-dev.<sha>` version to replace it, since the old
    exact version can't be reused.
  - A bad `latest` release: assume it's outside the unpublish window in practice the
    moment any customer could plausibly have installed it. Flip the kill-switch first,
    `npm deprecate` the bad version with a clear message, then cut a new patch/minor
    release through the normal §3 process.

## 6. Current status

- `ci.yml` is confirmed live and green against the real `Codeskop-io/web-sdk` remote —
  verified with a throwaway PR (opened, run to completion, then closed, with its
  branch deleted): [run
  29339218324](https://github.com/Codeskop-io/web-sdk/actions/runs/29339218324), all
  17 steps green (lint → typecheck → test+coverage → build → typecheck/test/build for
  the react adapter → `api:check:all` → both size budgets → Playwright e2e).
  - That verification run caught two real bugs the first (also-throwaway) attempt
    surfaced, both now fixed on `development`: (1) all three workflows ran the react
    adapter's typecheck/test *before* core's build, but the adapter resolves
    `@codeskop-io/tracker` through a workspace symlink whose `exports`/`types` point at
    `dist/`, which doesn't exist yet on a clean checkout — reordered so core builds
    first; (2) three integration test files
    (`src/config/remoteConfigClient.integration.test.ts`,
    `src/transport/fetchTransport.integration.test.ts`,
    `src/transport/beaconTransport.test.ts`) computed their "is the mock server
    reachable" flag inside a `beforeAll`, but `describe.runIf`/`describe.skipIf`
    evaluate synchronously at file-collection time, before any `beforeAll` runs — so
    the gate always saw the stale `true` default and ran for real against a
    nonexistent server on any checkout without one manually left running. Fixed with a
    top-level `await` instead. Neither bug was previously catchable — there was no CI
    to run either workflow before this phase.
- `publish-dev.yml` and `release.yml` share the identical gate suite (§1.1) that just
  passed for real in the above run, so both are expected to pass their own gate stage
  too — but neither has ever actually published anything, and **cannot** yet: both are
  blocked on §4's `NPM_TOKEN` secret, which is a deliberate, human-only manual step,
  not an oversight. No tag has been pushed to exercise `release.yml` end-to-end, on
  purpose — doing so before `NPM_TOKEN` exists would only reproduce the same,
  already-understood, correctly-loud failure.
