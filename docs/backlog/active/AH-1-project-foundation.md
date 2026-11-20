# AH-1 · Establish the project foundation

- **Scope:** [Foundation](../../reference/README.md#foundation)
- **Created:** 2026-11-20
- **Dependencies:** none
- **Cost:** —
- **Previous order:** 10
- **Taken:** 2026-11-20

## Context

The repository needs a development baseline that contributors can reproduce without installing a global tool.

## Work to do

- Record the package identity, supported Node.js version and license.
- Initialize an English Backslop tracker with no adapters or hooks, and queue the first product milestones.

## Out of scope

Product code, tests, release tags and publication.

## Verification

- In a clean checkout with an empty npm cache, install the tracker with `npm ci --registry=https://registry.npmjs.org`.
- Confirm the installed Backslop version and upstream tag, then run lint, status and the configured gates. The queue must show the planned milestones in English.
