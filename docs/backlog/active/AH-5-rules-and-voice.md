# AH-5 · Provide English rules and configurable voice

- **Scope:** [Planning boundaries](../../reference/README.md#planning-boundaries)
- **Created:** 2026-11-20
- **Dependencies:** none
- **Cost:** —
- **Previous order:** 50
- **Taken:** 2026-11-20

## Context

A workspace needs shared English rules without making an individual writing preference part of the project defaults.

## Work to do

- Provide English user-facing rules and diagnostics.
- Allow an optional voice profile without replacing project rules or changing behavior when no profile is configured.

## Out of scope

Inferring a voice from personal data and distributing personal profiles.

## Verification

- Compare generated instructions with no profile and with a sample profile. The default is English and the sample profile appears only when selected.
- Remove the selection and verify that the generated instructions return to their English defaults without altering project rules.
