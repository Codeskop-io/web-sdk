# Codeskop Web SDK — Documentation

Reference docs for `@codeskop/tracker`, the Codeskop **web** SDK. The tracked build →
release plan lives one level up in [`../web-sdk-workflow.md`](../web-sdk-workflow.md).

| Doc | What it covers |
|-----|----------------|
| [01 · Blueprint & Decisions](./01-blueprint-and-decisions.md) | Vision, scope, footprint budgets, decision log (D1–D11) |
| [02 · Architecture](./02-architecture.md) | Package layout, runtime flow, IndexedDB queue, unload delivery, seams |
| [03 · Capture & Event Model](./03-capture-and-event-model.md) | Web event taxonomy + the shared §7.5 wire contract + redaction/fingerprint |
| [04 · Security & Licensing](./04-security-and-licensing.md) | Public-key auth, origin binding (D10), kill-switch, **private licensed distribution (D11)** |
| [05 · API Reference](./05-api-reference.md) | Public API surface (frozen in Phase 13, SemVer'd) |
| [06 · Integration Guide](./06-integration-guide.md) | Licensed install (token), init, React, CDN, troubleshooting |
| [07 · SemVer Policy](./07-semver-policy.md) | Breaking vs. safe change matrix, release process, deprecation window |
| [08 · Security & Privacy Audit](./08-security-privacy-audit.md) | End-to-end audit against the built code: secret-key rejection, redaction, PII |
| [09 · Supply Chain](./09-supply-chain.md) | Dependency/license audit, SBOM, zero-runtime-deps verification, CSP |
| [10 · Publishing Setup](./10-publishing-setup.md) | **Manual, human-only step:** npmjs.com org, Automation token, `NPM_TOKEN` CI secret |
| [11 · Troubleshooting & FAQ](./11-troubleshooting-faq.md) | Token setup, why events aren't showing up (ranked by likelihood), redaction config, CORS, React gotchas |
| [12 · SDK Health Telemetry Spec](./12-sdk-health-telemetry-spec.md) | What to measure (self-error/ingest/config-fetch/queue-drop rates) and which existing hooks would need wiring — **a spec, not a build; no metrics backend exists** |
| [13 · Operations Runbooks](./13-operations-runbooks.md) | Kill-switch drill (with real propagation timing), deprecation/yank policy, on-call ownership placeholder |

## Context

- **Same contract as everything else:** the web SDK produces the identical wire events
  as the Android SDK and backend — [`backend/docs/07` §7.5](../../backend/docs/07-mobile-sdk-ingest-readiness.md#75-the-locked-contract-build-to-this).
- **Backend deployment** (real-endpoint phases): [`backend/docs/08`](../../backend/docs/08-backend-api-deployment.md).
- **Mobile counterpart:** [`android/docs/10`](../../android/docs/10-sdk-build-workflow.md) +
  [`android/docs/11`](../../android/docs/11-sdk-production-readiness.md).
