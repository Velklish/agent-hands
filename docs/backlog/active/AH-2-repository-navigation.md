# AH-2 · Locate and inspect workspace repositories

- **Scope:** [Planning boundaries](../../reference/README.md#planning-boundaries)
- **Created:** 2026-11-20
- **Dependencies:** none
- **Cost:** —
- **Previous order:** 20
- **Taken:** 2026-11-20

## Context

People and tools need to find a checkout without remembering its location on disk.

## Work to do

- Define how a workspace identifies its repositories and resolves repository names.
- Provide a read-only lookup that reports a match, ambiguity or a missing checkout.
- Support explicit cloning, freshness checks and inspection of workspace zones. Resolve repository identity before changing a checkout.

## Out of scope

Applying workspace resources and configuring a hosting account.

## Verification

- Use a workspace fixture with a unique name, duplicate short names and a missing name. Verify that the unique name resolves, ambiguity lists candidates without choosing one, and the missing name produces a clear diagnostic.
- Compare Git status and refs before and after lookup; neither changes.
- Use local remotes to exercise clone and update, including a failed fetch, competing origins and filesystem boundaries.
