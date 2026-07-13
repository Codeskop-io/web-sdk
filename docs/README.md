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

## Context

- **Same contract as everything else:** the web SDK produces the identical wire events
  as the Android SDK and backend — [`backend/docs/07` §7.5](../../backend/docs/07-mobile-sdk-ingest-readiness.md#75-the-locked-contract-build-to-this).
- **Backend deployment** (real-endpoint phases): [`backend/docs/08`](../../backend/docs/08-backend-api-deployment.md).
- **Mobile counterpart:** [`android/docs/10`](../../android/docs/10-sdk-build-workflow.md) +
  [`android/docs/11`](../../android/docs/11-sdk-production-readiness.md).
