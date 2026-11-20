# AH-4 · Run workspace hooks under explicit controls

- **Scope:** [Planning boundaries](../../reference/README.md#planning-boundaries)
- **Created:** 2026-11-20
- **Dependencies:** none
- **Cost:** —
- **Previous order:** 40
- **Taken:** 2026-11-20

## Context

Applying workspace resources and executing a hook have different effects. Hook execution needs a separate control and observable outcomes.

## Work to do

- Define when hooks run and how the workspace enables or disables them.
- Report hook failures and prevent execution when hooks are disabled.

## Out of scope

Background job scheduling and application of workspace resources.

## Verification

- Use a local fixture hook that records invocation. With hooks disabled it does not run; when enabled for the event it runs once.
- Make the fixture exit unsuccessfully. Verify that the failure identifies the hook, reports the exit status and follows the documented failure behavior.
