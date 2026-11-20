# ADR-001: Tasks and decisions are managed with backslop

**Status:** Accepted
**Date:** 2026-11-20
**Deciders:** the project owner

## Context

The project needs a task tracker and decision log that live alongside code, can be read by an agent without external services, and do not conflict when branches are worked on in parallel. A task list in one file conflicts on every closure; decisions scattered across chats cannot be found when needed.

## Decision

Tasks and decisions are managed with Backslop. `backslop.json` records the layout version and uses the locally installed CLI. `package.json` pins the exact GitHub tag, and `package-lock.json` records the archive integrity. To upgrade, update the dependency and lockfile to the chosen tag first, then run `npx --no-install backslop upgrade --to <version>` to update the tracker layout.

The mechanics are not repeated here: see [backlog/README.md](../backlog/README.md), [archive/README.md](../archive/README.md) and the backslop section of `AGENTS.md`.

## Consequences

- The cost is discipline: `lint` maintains links, numbers, and fields, but authors maintain the substance of task definitions and results.
