# 13. Web SDK — Operations Runbooks

> **Owner: Web SDK team** (matching this repo's own header in
> `web-sdk-workflow.md` — no individual on-call rotation exists yet; this is a
> placeholder for whoever staffs on-call when the team adopts a rotation, not a
> commitment that one exists today).
>
> Written in Workflow Phase 15. The kill-switch mechanism this runbook drills is
> **real and already working** — verified against the actual backend code and the
> actual SDK behavior below, not assumed from earlier phases' notes. What's new here is
> the runbook itself (the exact steps, and the honest timing/verification story), not
> the underlying mechanism.

## 13.1 Kill-switch drill — disabling a bad release in the field

### What actually flips (verified against the real backend code)

There are **two** independent switches, at very different blast radii. Use the
narrower one unless the situation genuinely calls for the broader one.

| Switch | Where | Scope | How fast to change it |
|--------|-------|-------|------------------------|
| **`Environment.ingest_enabled`** | A boolean field on the `Environment` model (`backend/apps/accounts/models.py`), one row per `{project, environment}` (e.g. a project's `production` environment) | One project's one environment | Seconds — a database row flip via Django admin, no deploy |
| **`INGEST_GLOBALLY_ENABLED`** | A Django settings flag (`backend/codeskop/settings/base.py`), sourced from an env var (`env.bool("INGEST_GLOBALLY_ENABLED", default=True)`) | **Every** tenant, every project, every environment, everywhere | Minutes — requires changing the env var in the deploy platform (Render, per `backend/render.yaml`) and a restart/redeploy of the ingest service |

Both feed the same computed field: `_is_enabled()` in `backend/apps/ingest/config.py`
computes `enabled = INGEST_GLOBALLY_ENABLED and environment.ingest_enabled` — either
one being `false` makes `GET /v1/config` return `"enabled": false` for that request.

**For "a bad release is misbehaving for one customer" — always use the per-environment
flag, not the global one.** The global flag is a platform-wide emergency stop, not a
per-incident tool.

### Step-by-step: disabling one project's environment

1. **Identify the exact target.** Get the project and environment name
   (`test`/`staging`/`production`, or a custom name) from the customer report or the
   dashboard. Confirm you have the right organization — `Environment` rows are scoped
   `{project, name}` uniquely (`unique_environment_name_per_project` constraint), not
   globally unique by name alone.
2. **Log into Django admin** at `https://api.codeskop.com/admin/` (production) or
   `https://staging.api.codeskop.com/admin/` (staging) with a **staff** account.
   *(Prerequisite this drill assumes but doesn't grant: whoever is on-call needs a
   staff Django account provisioned in advance — this is an internal-operator tool by
   design, per `backend/apps/accounts/admin.py`'s own module docstring: "intended for
   internal operators (us), not customers." There is no customer-facing or dashboard
   toggle for this today — see §13.1's "known gap" below.)*
3. Navigate to **Accounts → Environments**, find the row for the target
   `{project, environment}`.
4. Uncheck **`ingest_enabled`**, save.
5. **Verify server-side that it took:**
   ```bash
   curl -s https://api.codeskop.com/v1/config \
     -H "Authorization: Bearer <the affected environment's cs_*_pk_... key>"
   ```
   Confirm the JSON body's `"enabled"` field is now `false`. Do this before declaring
   the drill/incident action complete — a typo'd environment name in step 3 (e.g.
   flipping `staging` when the report was about `production`) is a real failure mode
   this step catches immediately.

### How fast clients actually pick this up — the part most likely to surprise you

**This is not a live push.** Read this before promising a customer "it's off now":

- The SDK fetches `GET /v1/config` **exactly once**, inside `CodeskopClient`'s
  constructor, i.e. once per `init()` call (`src/runtime/client.ts`:
  `refreshRemoteConfig()` runs once, at construction; there is no `setInterval`/polling
  loop anywhere in the client that re-fetches config during a live session — verified
  by grep, the only call site of `refreshRemoteConfig` is the constructor).
- **A tab that already has the SDK running keeps capturing under its last-fetched
  config until that page is reloaded or `init()` is called again.** For a long-lived
  SPA session, that can be hours. There is no mechanism — today — to reach into an
  already-open tab and flip it live. If the "bad release" is actively harming a
  customer's page performance or sending bad data *right now, in already-open tabs*,
  this kill-switch does not stop that in real time — it only prevents *newly loading*
  pages from starting to capture.
- **Newly loading pages** (a fresh navigation, a new tab, a hard refresh) pick up the
  change on their one `GET /v1/config` call — **modulo the response's HTTP caching**:
  the endpoint sets `Cache-Control: max-age={INGEST_CONFIG_MAX_AGE}`
  (`backend/apps/ingest/views.py`, default `INGEST_CONFIG_MAX_AGE=300` — 5 minutes,
  `backend/codeskop/settings/base.py`). A browser that fetched config from the same
  URL (same key) within the last 5 minutes may serve that response straight from its
  local HTTP cache **without even contacting the server**, so a page loaded shortly
  after the flip can still observe the *old* value for up to 5 minutes. After that
  window, every fresh page load gets the current value (the client also sends
  `If-None-Match` with its cached ETag, so even a validated re-fetch is cheap, but a
  *within-max-age* load may skip the round-trip to the server entirely, per standard
  HTTP cache semantics).
- **Practical summary to give an incident channel:** "New sessions stop capturing
  within roughly 5 minutes; already-open tabs keep going until reloaded — there is no
  faster path today."

### Verifying it actually took effect for a real client

1. Open the affected app in a **fresh, uncached** context (incognito/private window,
   or DevTools "Disable cache" + hard reload) using the affected key.
2. In the Network tab, confirm the `GET /v1/config` response body has
   `"enabled": false`.
3. Deliberately trigger something the SDK would normally capture — e.g. run
   `window.__yourAppGlobal.recordException?.(new Error('kill-switch verification'))`
   if you have console access, or just trigger a real error path — then confirm **no**
   `POST /v1/events` request fires at all. (`emitEvent`'s guard,
   `src/runtime/client.ts`, checks `this.featureGate.isKillSwitched()` before ever
   enqueuing — a killed client doesn't even queue locally, so there's nothing for a
   later `flush()` to send either.)

**Known gap, stated plainly:** this exact live-browser verification (flip a real
`Environment.ingest_enabled` row, then watch a real browser stop sending) is **not**
covered by an existing automated test. What *is* covered today:
- The remote kill-switch's *logic* at the unit level:
  `src/runtime/client.test.ts`'s *"is a no-op once the remote kill-switch has
  tripped"* and *"leaves a tripped kill-switch tripped even after `setEnabled(true)`"*,
  plus `src/config/featureGate.test.ts` and `src/config/remoteConfigClient.test.ts`.
- The backend's computation of `enabled` at the unit level:
  `backend/apps/ingest/tests/test_config.py`.
- `setEnabled(false)` — the SDK's *local* pause, a different mechanism — end-to-end
  against real staging/production (`e2e/staging-smoke.spec.ts`,
  `scripts/staging-smoke.mjs`, Phase 11).

What is **not** covered anywhere: an automated end-to-end test that flips a real
`Environment.ingest_enabled` row via the backend and watches a real browser's `GET
/v1/config` response and subsequent (non-)capture. Manually performing the steps above
is, today, the closest thing to a rehearsal of this drill — treat a first real
execution of this runbook as the first rehearsal, not as "surely already proven."
Building the automated version of this check is a natural follow-up, not done here.

### Re-enabling

Reverse step 4 above (check `ingest_enabled` back on, save), then repeat the `curl`
verification to confirm `"enabled": true` again. The same "new sessions pick it up
within ~5 minutes, open tabs need a reload" timing applies symmetrically to
re-enabling.

### Known gap: no customer/dashboard-facing toggle

Today the *only* way to flip this is Django admin, a staff-only tool. There is no
dashboard UI, and no API endpoint, that lets a customer (or even a non-staff internal
person) toggle their own environment's kill-switch. Building one is out of scope here
but worth tracking as a real product gap — right now, every kill-switch drill requires
a staff engineer with Django admin access, which is also a single point of
process-friction during an actual incident.

## 13.2 Deprecation / yank policy

This SDK's SemVer and breaking-change classification already live in
[`07-semver-policy.md`](./07-semver-policy.md) — this section adds only the
release-cadence specifics that doc's §7.5 deferred to "the current
release-engineering policy (`web-sdk-workflow.md` Phase 15)":

- **Deprecation window:** per `docs/07` §7.5, a breaking removal is never shipped in
  the same release it's decided. The support window, now specified:
  - **Pre-1.0** (superseded 2026-07-15 — the SDK shipped `1.0.0` directly, skipping any
    intermediate `0.x` release): a deprecated export would have been kept functioning
    for **at least one MINOR release** after the release that first marked it
    `@deprecated`. No longer applicable.
  - **Post-1.0** (current state, `1.0.0`): a deprecated export is kept functioning for
    **at least one full MAJOR version's support window** — i.e. it survives every
    MINOR/PATCH release within the major version it was deprecated in, and is only
    eligible for removal in the *next*
    MAJOR.
- **Yanking a bad release** (distinct from planned deprecation — an already-published
  version turns out to be actively harmful, e.g. a regression that breaks capture or
  leaks data): `npm deprecate @codeskop/tracker@<bad-version> "<reason>"` marks it in
  the registry (visible to anyone running `npm install`, doesn't block already-locked
  installs) — this requires the same Automation-token publish access as a real release
  (`docs/10` §10.2(b)), so it has the same "human with npmjs.com access" prerequisite
  Phase 14 already identified as the one manual gap. There is no "unpublish" step
  planned or recommended — npm's own unpublish policy for packages with existing
  dependents is restrictive by design, and deprecating + shipping a fixed release is
  the safer, standard path. **The kill-switch (§13.1) is the correct *immediate* lever
  for "a bad release is actively hurting customers right now"** — it works regardless
  of what version customers have installed, since it's server-side and version-blind.
  Yanking/fixing the package is the *follow-up*, not the first response.
- **Changelog:** every deprecation and every yank gets an explicit changelog entry
  (`docs/07` §7.5 already requires this for deprecations; extending the same rule to
  yanks here). No automated changelog generation exists in this repo today — see the
  explicit scope note in the Phase 15 tracker entry.

## 13.3 On-call ownership

**Web SDK team** (this doc's own header, matching `web-sdk-workflow.md`'s
`**Owner:**` line) — no named individual, no rotation tooling, and no paging
integration exist in this workspace. This is a deliberate placeholder, not an
oversight: inventing a specific person's name here would be fabricating an on-call
assignment that doesn't exist. Whoever staffs this in practice should:

- Have (or be grantable) Django admin **staff** access to both
  `staging.api.codeskop.com/admin/` and `api.codeskop.com/admin/` — §13.1's drill is
  unusable without it.
- Have (or know who holds) npmjs.com `@codeskop` org access for a yank/deprecate action
  (§13.2) — this is the same access gap `docs/10-publishing-setup.md` already flags for
  the initial publish.
- Own watching whatever health signal exists once `docs/12-sdk-health-telemetry-spec.md`
  is actually wired to a real backend — **which it is not, today** (see that doc's
  §12.5). Until it is, "on-call" for this SDK means responding to customer-reported
  issues and dashboard-observed traffic anomalies, not an alert firing.
