---
title: "Runtime Upgrade Regression Hardening"
id: runtime-upgrade-regression-hardening
status: planning
informed_by: []
section: "Runtime"
depends_on:
  - "signet-runtime"
success_criteria:
  - "CLI hook commands continue to reach daemon hook endpoints after runtime transport refactors"
  - "Published daemon-bearing packages always include the bundled dashboard assets required for `/` to serve the UI"
  - "Regression tests fail when `npm pack --dry-run` for `@signet/daemon` or `signetai` omits `dashboard/index.html`"
scope_boundary: "Hook transport wiring and dashboard packaging guardrails only; does not redesign the runtime or dashboard app"
draft_quality: "incident-driven planning stub"
---

# Runtime Upgrade Regression Hardening

## Problem

The March 29, 2026 upgrade path from `0.83.0` to `0.85.3` exposed two
runtime regressions at once:

1. `signet hook user-prompt-submit` could lose access to the daemon client
   function it needed after the hook transport refactor.
2. `@signet/daemon` package publishes could omit the bundled dashboard
   entirely, leaving the daemon in API-only mode even though the runtime
   expected dashboard assets to exist.

Both failures broke core runtime surfaces immediately after upgrade and both
escaped because the build and test contracts were too implicit.

## Goals

1. Keep CLI hook commands stable across daemon transport refactors.
2. Make dashboard bundling an explicit publish-time contract for every
   daemon-bearing package.
3. Add regression checks that fail before publish when either contract drifts.

## Proposed guardrails

### 1) Hook transport contract

Hook commands should depend on a single daemon fetch contract where possible.
If session-start needs richer failure classification, the remaining hook
commands must either use the same transport or be covered by an integration
test that proves registration still provides the required client methods.

### 2) Dashboard publish contract

Any package that ships a daemon entrypoint and claims to serve the dashboard
must build and copy dashboard assets as part of its own build pipeline. Silent
"dashboard not built yet" success paths are not acceptable for publish flows.

### 3) Pack-time regression checks

`npm pack --dry-run --json` becomes the package-level source of truth for this
incident class. Regression tests should assert that `dashboard/index.html` is
present in the tarball for `@signet/daemon` and `signetai`.

## Validation

- Hook command regression tests prove `user-prompt-submit` still reaches the
  daemon and prints returned injection content.
- Package regression tests prove both daemon-bearing tarballs include
  `dashboard/index.html`.
- Build scripts fail fast when the dashboard bundle cannot be built or copied.
