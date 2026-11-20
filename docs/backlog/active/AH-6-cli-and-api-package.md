# AH-6 · Package the CLI and JavaScript API for clean installs

- **Scope:** [Planning boundaries](../../reference/README.md#planning-boundaries)
- **Created:** 2026-11-20
- **Dependencies:** none
- **Cost:** —
- **Previous order:** 60
- **Taken:** 2026-11-20

## Context

The package needs to support both command-line use and JavaScript consumers without depending on a contributor checkout.

## Work to do

- Expose the `agent-hands` executable and a documented JavaScript entry point from the same package.
- Have the CLI and installed library consumers call the same public, harness-independent operations through the package root. Keep native adapter modules outside the public package exports.
- Document installation from an exact GitHub release tag and keep development tooling out of consumer runtime dependencies.

## Out of scope

Publishing a release as part of repository bootstrap.

## Verification

- Inspect the package contents and install a candidate artifact into a clean project on Node.js 26. Verify that executable discovery and JavaScript import work and that both can perform the same supported repository lookup.
- Run a compiled external TypeScript consumer against at least two supported harnesses. Change only the selected target and assert the same input and result types. Verify that unexported adapter paths cannot be imported through package subpaths.
- Confirm the documented exact-tag install produces a usable package when a release is available. Verify that a consumer does not need Backslop, development dependencies or local source paths.
