# 4. Web SDK — Security, Restrictions & Licensing

> The web SDK runs inside untrusted, publicly-inspectable pages. Like Android, it is
> **published publicly and free to install** (D11, revised) — the restriction lives
> entirely on the **ingest side**: without an active plan's public key, the SDK
> installs and initializes but never captures or sends anything. This doc covers the
> **runtime** security posture (mirroring Android) and how that server-side gate makes
> the library commercially restricted despite open distribution.

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

## 4.6 Distribution & licensing (D11, revised 2026-07-15) — restricted at ingest, not install

**Original D11** published `@codeskop/tracker`/`-react` to a private, token-gated npm
scope. That was reversed before the first real publish (nothing had shipped to
npmjs.com yet): the code is already fully inspectable in any browser running it, so a
private registry never protected anything — it only added install friction (per-customer
tokens, `.npmrc` management, a paid npm org) with no corresponding security benefit.
Android was never gated this way either (public Maven Central since day one). The
revised model puts both SDKs on the same footing:

### Public install, no gate

- `@codeskop/tracker` (and `-react`) publish to the **public npm registry**
  (`publishConfig.access: "public"`), MIT-licensed. `npm install @codeskop/tracker` works
  for anyone, no token, no `.npmrc` entry, no org membership.

### Runtime plan gate (the actual restriction)

- The SDK's behaviour is **server-gated**: `GET /v1/config` returns the plan's
  entitlements for the public key passed at `init`. An **inactive/unlicensed
  plan — or no valid key at all** — yields `enabled:false` → the SDK degrades to a
  **no-op** (it initializes, never captures, never sends — the same shape as Android's
  `:tracker-noop`).
- Feature tiers (`features`, `sample_rates`, `max_queue_mb`) are applied per plan, so a
  lower tier is functionally thinner even while installed.

> **Net effect:** anyone can `npm install` and read the source; nobody gets working
> capture without a valid public key tied to an active plan. This is the same
> boundary the mobile SDK already relies on — the package is free, the **ingest** is
> the product.

## 4.7 Supply-chain integrity (Workflow Phase 13–14)

- **SBOM** generated; dependency + license audit in CI.
- **npm pack audited** so no secrets ship in the tarball. **No npm provenance
  attestation** — deliberately removed 2026-07-16: it requires the GitHub source repo
  to be public, and `Codeskop-io/web-sdk` is private (see
  `docs/10-publishing-setup.md` §10.6.2).
- **CSP-friendly**: no `eval`, no dynamic code injection; optional **Subresource
  Integrity** hash for any licensed CDN build.

## 4.8 Comparison to Android

| Concern | Android | Web |
|---------|---------|-----|
| Key | `cs_*_pk_` bearer, secret never sent | Same |
| Identity binding | `{package, signing_cert_sha256}` | `{origin}` via unforgeable `Origin` header (D10) |
| Feature gating | Server-side via `GET /v1/config` | Same |
| Kill-switch | `enabled:false` | Same |
| Distribution | **Public** (Maven Central), free to install | **Public** (npm, MIT), free to install; runtime no-op if unlicensed (D11) |
