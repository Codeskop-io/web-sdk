# 7. Web SDK — SemVer & Compatibility Policy

> The compatibility contract for `@codeskop/tracker` and `@codeskop/tracker-react`,
> effective once the surface is frozen in Workflow Phase 13. Applies to **exactly** the
> API documented in [`05-api-reference`](./05-api-reference.md) §5.1–5.5 — anything not
> listed there (any module path other than the package root, any symbol the barrel
> (`src/index.ts` / `react/src/index.ts`) doesn't re-export) is internal and carries no
> compatibility guarantee at all, even between patch releases.

## 7.1 Versioning scheme

Standard [SemVer 2.0.0](https://semver.org/), `MAJOR.MINOR.PATCH`:

| Bump | When |
|------|------|
| **MAJOR** | Any breaking change (§7.2), or a change to the wire contract that requires a coordinated backend/SDK rollout |
| **MINOR** | Any additive, backward-compatible change (§7.3) |
| **PATCH** | Bug fixes and internal changes with **no** effect on the public API's types or documented runtime behavior |

Pre-1.0 (`0.x.y`, current: `0.1.0-beta.0`) follows the same MAJOR/MINOR/PATCH mapping
one column shifted, per SemVer's own pre-1.0 convention — a `0.x` **MINOR** bump may
still contain what would be a breaking change post-1.0. Phase 14 (licensed publishing)
is the intended `1.0.0` cut; from that tag on, the mapping above is exact and a breaking
change is never shipped in a `MINOR`/`PATCH`.

The core (`@codeskop/tracker`) and the React adapter (`@codeskop/tracker-react`) are
versioned **independently** — they are separate packages (`docs/02` §2.1) with separate
`api-extractor` baselines (§7.4) — but a `tracker-react` release always declares a
[`peerDependencies`](../react/package.json) range wide enough to cover every
`@codeskop/tracker` version it was actually tested against; narrowing that range to drop
support for an old core version is itself a breaking change for `tracker-react`.

## 7.2 Breaking changes (require a MAJOR bump)

Anything that could make previously-valid customer code fail to compile, fail to run, or
silently start behaving differently:

- **Removing** a public export (a function, type, class, or the whole `CodeskopContext`
  default value shape) — e.g. dropping `flush()`.
- **Renaming** a public export — a rename is a remove + an add, and the remove half is
  breaking on its own.
- **Narrowing** a type:
  - A parameter type becoming *more specific* (e.g. `attributes?: Record<string, unknown>`
    → `attributes?: { tag: string }`) can reject a caller's previously-valid argument.
  - A return type becoming *more specific* is also breaking for any caller that assigned
    the old, wider return type to a variable/parameter typed against it.
  - Turning an optional field/parameter **required** (`release?: string` → `release:
    string`) is a narrowing of the accepted input shape.
  - Removing a member from a union (`EventType`, `Severity`) is narrowing.
- **Changing a documented default behavior** — e.g. `captureNetwork` defaulting to
  `true` today; shipping a release where it silently defaults to `false` changes what
  every existing `init({ apiKey })` call (no explicit `captureNetwork`) does, with no
  signature change at all. `docs/05` §5.2's default column is part of the frozen
  contract, not just the type.
- **Changing a function's runtime contract** without a type change — e.g. `flush()`
  starting to `throw` instead of resolving `false`, or `identify()` starting to *create*
  a new user on repeat instead of updating (`docs/05` §5.3 names this the backend rule
  explicitly).
- **Changing the wire shape** a documented config field maps to, in a way the backend
  doesn't accept from older SDK versions (coordinate with `backend/docs/07` §7.5 before
  any such change — this is a cross-repo breaking change, not just a package one).
- **Tightening** `peerDependencies` (`tracker-react`'s `react` range) to exclude a
  previously-supported version.

## 7.3 Safe changes (MINOR or PATCH, non-breaking)

- **Additive exports** — a new function, type, or React hook that no existing code could
  already be referencing.
- **Additive, optional fields** — a new optional key on `CodeskopConfig`
  (`docs/05` §5.2) or a new optional prop on `CodeskopProviderProps`/
  `CodeskopErrorBoundaryProps`, with a default that preserves today's behavior for
  callers who don't pass it.
- **Widening a type**:
  - A parameter type becoming *more permissive* (e.g. `userId: string` →
    `userId: string | number`) — every existing call site still type-checks.
  - Adding a member to a union that is only ever **produced** by the SDK and consumed via
    exhaustive `switch`/matching by the caller is breaking for that caller (see §7.2);
    adding a member to a union that only ever **accepted** as input (never matched
    exhaustively downstream) is safe. `EventType`/`Severity` are output-only from the
    caller's perspective (the SDK produces events; the caller doesn't construct them) —
    a new value there is treated as breaking anyway (§7.2) if any documented example
    exhaustively switches on it; today none does, so this is evaluated case-by-case at
    review time, not assumed safe by default.
- **Loosening required → optional** (e.g. a parameter gaining a default value) — every
  existing call site still compiles and behaves the same.
- **Widening `peerDependencies`** (supporting a newer `react` major in addition to the
  existing range).
- **Bug fixes** that make behavior match what was already documented (a bug fix that
  changes *documented* behavior is judged like any other behavior change, per §7.2 — the
  fact that the old behavior was a bug doesn't exempt it if customers were relying on the
  documented — even if wrong — contract; that case ships as a MAJOR with a changelog
  callout, not a silent PATCH).
- **Internal refactors** with zero change to `etc/tracker.api.md` /
  `react/etc/tracker-react.api.md` (§7.4) and zero change to bundle-visible runtime
  behavior — includes performance improvements, dependency swaps behind the same
  interface, and doc-comment edits.
- **Changing anything not in `docs/05`** — an un-exported helper, an internal module
  path, a private class field — is never a compatibility event at all, at any bump
  level, because it was never part of the contract.

## 7.4 Enforcement — the API report is the source of truth

A human classifying a diff as "safe" is necessary but not sufficient — the frozen
surface is machine-checked:

- [`@microsoft/api-extractor`](https://api-extractor.com/) runs against each package's
  rolled-up `dist/index.d.ts` and produces a Markdown-diffable **API report** committed
  at `etc/tracker.api.md` (core) and `react/etc/tracker-react.api.md` (react).
- `npm run api:check` (root) / `npm run api:check` (in `react/`) — or `npm run
  api:check:all` from the root for both at once — regenerates the report and **fails
  (non-zero exit)** if it differs from the committed baseline. This is wired as a
  merge-blocking CI step alongside `lint → typecheck → test → build → size-limit`
  (`web-sdk-workflow.md` Phase 0), so an accidental or unreviewed surface change cannot
  land silently.
- `npm run api:update` (`--local`) regenerates and overwrites the baseline — the only
  sanctioned way to accept a surface change. Every PR that touches the baseline must
  say, in its description, which §7.2/§7.3 bucket the change falls into and (if §7.2)
  what MAJOR version it ships in.
- The report diff is *necessary* evidence for a release's version bump but not
  sufficient on its own: a diff can be purely additive (→ MINOR) or can hide a breaking
  narrowing that still round-trips through the type checker in a way that only a human
  (or the categories in §7.2) catches — e.g. a default-value change in a doc comment
  doesn't show up as a `.d.ts` diff at all, so `docs/05` and the release notes are
  checked by hand every release, not inferred from the report alone.

## 7.5 Deprecation before removal

A breaking removal is never shipped in the same release it's decided:

1. Mark the export `@deprecated` in its TSDoc comment (surfaces in editor tooltips) and
   note it in the changelog, pointing at the replacement.
2. Keep it functioning, unchanged, for at least one MINOR release (pre-1.0) or one MAJOR
   release's full support window (post-1.0) — whichever the current release-engineering
   policy (`web-sdk-workflow.md` Phase 15) specifies at the time.
3. Remove it only in a MAJOR bump, with the removal called out explicitly in that
   release's changelog and the `api:update`'d baseline diff as the paper trail.

## 7.6 Scope note

This policy governs `@codeskop/tracker` and `@codeskop/tracker-react`'s **own** public
API surface only. It does not change, and is not a substitute for, the versioning of the
shared ingest wire contract (`backend/docs/07` §7.5), which the Android SDK, the web
SDK, and the backend all depend on jointly — a wire-contract change is coordinated
cross-repo regardless of what this document says about the SDK's own types.
