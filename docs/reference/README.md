# Reference

How agent-hands works today — from the code, not intention. Intent and rationale are in [ADRs](../README.md); this reference describes only the behaviour of the running version. It is organised by subsystem so each file can be edited independently. The “Scope” field of tasks links here.

| Section | About |
|---|---|
| [Foundation](#foundation) | Current repository contents and verification |
| [Workspace resources](layout.md) | Prepared input, native layouts and ownership |
| [Planning boundaries](#planning-boundaries) | Areas reserved for future implementation |

## Foundation

The repository contains an MIT license, a TypeScript library and the Backslop development
workflow. `npm ci --registry=https://registry.npmjs.org` installs the locked runtime and development dependencies.
`npx --no-install backslop lint` checks the documentation and tracker;
`npx --no-install backslop status` shows planned work. Neither command tests a product.

Backslop `v1.0.0` resolves to commit `202c91f2639ba28a7a02996eaf1cd82a357705d0`
in its public GitHub repository. The dependency uses the tag's public HTTPS archive;
the lockfile records its integrity. Updating it is an explicit project decision.

## Planning boundaries

Other areas include repository navigation, runtime and hooks, configurable voice, and
release packaging. Task cards define acceptance checks without prescribing speculative
command names or APIs.
