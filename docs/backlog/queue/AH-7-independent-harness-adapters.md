# AH-7 · Keep each harness adapter independent

- **Order:** 70
- **Scope:** [Planning boundaries](../../reference/README.md#planning-boundaries)
- **Created:** 2026-11-20
- **Dependencies:** none
- **Cost:** —

## Context

A change to a native format or hook for one harness should be confined to that adapter. Shared workspace behavior needs a single implementation and test contract.

## Work to do

- Offer one public entry point at the package root. An application selects the target and calls the same operation using the same input and result contract. Keep adapter selection, construction and native data formats internal.
- Give each supported harness its own module for its native formats, paths, behavior and diagnostics. The application selects an adapter through typed interfaces for the operations it supports.
- Let adapters depend on shared contracts and tools. Keep sibling adapters independent, including transitive dependencies. Place harness-specific decisions in the adapter that owns them.
- Exercise shared guarantees through the same contract tests for each applicable adapter. Keep native-format fixtures and regression tests with their adapter. Cover differences in supported operations explicitly.

## Verification

- Enumerate every supported adapter and run its tests on their own. Load each adapter with the other adapters unavailable. Check its dependency graph and include a negative control for an accidental sibling import.
- In a workspace configured for multiple harnesses, change and apply the selection for one. Verify the exact expected native output and that the other harnesses retain their files and ownership data. Cover shared destinations at the level of the fields each adapter owns.
- Run the shared scenarios once as a parameterized suite against the public interface. Keep the native regression for each genuinely different behavior. Check that native-specific failures and unchanged sibling outputs are visible through the public entry points.
