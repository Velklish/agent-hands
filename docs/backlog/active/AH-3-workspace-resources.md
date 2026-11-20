# AH-3 · Apply workspace resources with explicit ownership

- **Scope:** [Planning boundaries](../../reference/README.md#planning-boundaries)
- **Created:** 2026-11-20
- **Dependencies:** none
- **Cost:** —
- **Previous order:** 30
- **Taken:** 2026-11-20

## Context

Skills, agent definitions, rules and tool connections must reach their intended targets without taking ownership of manually maintained files.

## Work to do

- Apply explicitly selected resources to their intended workspace or repository targets.
- Record ownership and use it to distinguish managed output from files maintained by the user.

## Out of scope

Executing hooks, storing credentials and defining a default voice.

## Verification

- Apply a mixed selection twice to a temporary workspace. Only selected resources appear, and the second pass leaves the same content and ownership records.
- Change the selection and verify that stale managed outputs are removed while unmanaged files remain unchanged. A conflicting unmanaged file must be reported and preserved.
