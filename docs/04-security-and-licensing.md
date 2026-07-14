# 4. Web SDK — Security, Restrictions & Licensing

> The web SDK runs inside untrusted, publicly-inspectable pages, and — unlike the
> Android SDK — it is a **commercial, licensed** library, not a free public dependency.
> This doc covers both: the **runtime** security posture (mirroring Android) and the
> **distribution/licensing** restrictions that make it "not free" (D11).

## 4.1 Threat model in one line

Everything the SDK ships to the browser is **public** — source is inspectable, requests
are observable. So security cannot rely on secrecy of the SDK code or the key; it relies
on the key being a **public, low-privilege** credential, on **origin binding**, on
**server-side** entitlements, and on **install-time licensing**.

## 4.2 Key handling (D5, D7)

- The SDK authenticates with the **public ingest key** `cs_*_pk_…` as the bearer
  credential. The **secret key** `cs_*_sk_…` must **never** appear in web code.
- At `init`, the key is validated: a `cs_*_sk_` or malformed key is rejected
  **fail-soft** — the SDK disables itself and records an internal diagnostic; it never
  throws into the page.
- The SDK sends **only the key**. Scopes (`"ingest"`) are enforced **server-side** from
  `APIKey.scopes` — never declared by the client.

## 4.3 Origin binding (D10) — the web app-identity binding

Because the public key is visible in page source, anyone could copy it into another
site. Android defends this by binding a key to `{package_name, signing_cert_sha256}`.
The web equivalent:

- Each key carries an **allowlist of registered web origins** (e.g.
  `https://app.customer.com`).
- The browser attaches an **`Origin`** header to the cross-origin ingest request that
  page JavaScript **cannot forge**. The SDK also mirrors it into `context.app.origin`.
- The backend enforces the allowlist in its auth layer (the same **enforce-if-configured**
  fallback as Android — no allowlist ⇒ check skipped, so the contract works before a
  customer configures origins), and **CORS** is scoped to the registered origins.
- A key used from an unregistered origin is rejected `403`.

> This makes a lifted key useless on an attacker's origin, without any client-side
> secret.

> **Status as of Workflow Phase 11/15: designed, not yet implemented server-side.**
> There is no `allowed_origins`-style field on `APIKey`, no create/update API or
> dashboard control to set one, and no enforcement of it in the ingest auth/CORS layer
> — confirmed directly against `backend/apps/accounts/models.py` and
> `backend/apps/ingest/cors.py` (see `web-sdk-workflow.md` Phase 11's exit-gate note).
> Everything above this line describes the intended design so it is the SDK's target
> contract; treat the `Origin` header mirroring (`context.app.origin`) as already done
> on the SDK side, but the backend does not yet reject an unregistered origin.

## 4.4 Privacy & redaction (D3)

- Metadata-first: no request/response **bodies** are ever captured — there is
  currently **no opt-in** for this (a `captureBodies` config field existed pre-freeze
  but was removed before the Phase 13 API baseline was committed, since it was never
  wired to any real capture behavior — see `docs/08-security-privacy-audit.md` §8.6).
  If body capture is wanted later, it needs new, tested code and a new API surface, not
  a flag flip.
- `Authorization`/`Cookie` never captured; header capture is an allowlist; URL query
  strings are always dropped **entirely** (not selectively masked — same §8.6 history
  killed the `redactQueryKeys` field for the same reason); error messages redacted by
  default (unconditionally — see `docs/11-troubleshooting-faq.md` §11.3 for the exact
  current behavior);
  `identify` traits redacted.
- No PII leaves the device by default; this is audited end-to-end in Workflow Phase 13.

## 4.5 Host-safety guards (D4)

- Every entrypoint/hook runs inside `safely()` — a defect becomes a dropped event + a
  diagnostic, never a page error.
- Instrumentation of `fetch`/XHR always returns the original response/rejection unchanged
  and never instruments the ingest endpoint (no feedback loop).
- The **remote kill-switch** (`GET /v1/config` → `enabled:false`) disables all capture in
  the field without a customer redeploy.

## 4.6 Distribution & licensing (D11) — "not free"

Two enforcement layers so the library is genuinely restricted:

### Layer 1 — Install access (private package + token)

- `@codeskop/tracker` (and `-react`) are published to the **`@codeskop` scope on the
  private npm registry** (`registry.npmjs.org`, `publishConfig.access: "restricted"`),
  **not** the public npm registry — decided over GitHub Packages so customers use the
  npm registry they already authenticate against for every other dependency.
- Each licensed customer gets a **read-only install token tied to their active
  subscription** (an npm granular access token scoped to the `@codeskop` packages,
  issued/revoked from the dashboard). They add it to a project `.npmrc`:

  ```ini
  # .npmrc  (per licensed customer; token issued from the dashboard)
  @codeskop:registry=https://registry.npmjs.org/
  //registry.npmjs.org/:_authToken=${CODESKOP_TOKEN}
  ```

- Tokens are **revocable** — churn/expiry revokes install access. CI reads the token
  from a secret, never committed.

### Layer 2 — Runtime plan gate

- Even with the package installed, the SDK's behaviour is **server-gated**: `GET /v1/config`
  returns the plan's entitlements. An **inactive/unlicensed plan** yields
  `enabled:false` → the SDK degrades to a **no-op** (it initializes, never captures,
  never sends — the same shape as Android's `:tracker-noop`).
- Feature tiers (`features`, `sample_rates`, `max_queue_mb`) are applied per plan, so a
  lower tier is functionally thinner even while installed.

> **Net effect:** you cannot obtain the library without a licensed token, and a copy
> obtained illicitly still won't function without an active plan on a registered origin.

## 4.7 Supply-chain integrity (Workflow Phase 13–14)

- **SBOM** generated; dependency + license audit in CI.
- **npm provenance**/signing on publish; `npm pack` audited so no secrets ship in the
  tarball.
- **CSP-friendly**: no `eval`, no dynamic code injection; optional **Subresource
  Integrity** hash for any licensed CDN build.

## 4.8 Comparison to Android

| Concern | Android | Web |
|---------|---------|-----|
| Key | `cs_*_pk_` bearer, secret never sent | Same |
| Identity binding | `{package, signing_cert_sha256}` | `{origin}` via unforgeable `Origin` header (D10) |
| Feature gating | Server-side via `GET /v1/config` | Same |
| Kill-switch | `enabled:false` | Same |
| Distribution | **Public** (Maven Central), free to install | **Private + licensed** token; runtime no-op if unlicensed (D11) |
