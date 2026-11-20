# Workspace resources

Import `planLayout`, `parseLayout`, `applyLayout` and `readLayoutState` from `agent-hands`.
`planLayout` accepts typed input. `parseLayout` validates the same shape from an unknown value
and produces an applicable plan; it does not deserialize a plan. Both take an absolute workspace
root, one selected harness and explicit lists of skills, agents, servers and rule files. They do not
discover a repository, read a workspace manifest, resolve versions or run a harness.

Planning reads selected sources and does not write the workspace. `files` previews generated
resources; for a shared JSON document it shows only the generated fragment, before merging.
The plan is an in-memory value; pass the exact returned object to `applyLayout`. Replan after a source change.
`requiredVars` names unresolved references from values, and may not be present. Supply environment
values only when they may be written into the resulting configuration. Do not log plans that contain secrets.

`resources` describes each prepared skill file, shared supporting file and subagent by logical owner.
Match a record's `path` to `files`, and use `relativePath` within that resource rather than parsing a
harness path. Shared files point to the corresponding `sharedDirs` input by zero-based `sourceIndex`.
If several sources supply the same shared file with identical bytes and mode, the first source owns
the preview record. Rules and MCP previews are not selected content resources.

By default a linked or special file in a source tree is an error. An integrating caller that already
warns and skips such supporting files can opt in with `supportingFiles: 'skip-nonregular'`. `notices`
names each skipped resource without opening it. A selected skill still needs a regular `SKILL.md`.

| Target | Skill and agent directories | Tool server document |
|---|---|---|
| Claude Code | `.claude/skills/`, `.claude/agents/` | `.mcp.json`, owned server keys |
| Cursor | `.cursor/skills/`, `.cursor/agents/` | `.cursor/mcp.json`, owned server keys |
| Codex | `.codex/skills/`, `.codex/agents/` | `.codex/config.toml`, whole file; refuses a foreign file |
| OpenCode | `.opencode/skills/`, `.opencode/agents/` | `opencode.json`, owned server keys |

The adapter for the selected target renders its own format. Rules are copied in order to
`.agents/rules/<target>/0001.md`, `.agents/rules/<target>/0002.md`, and so on. Select these files
explicitly in the session; applying a layout does not instruct a running agent to read them.

Save the returned `state` in trusted caller-controlled storage, separately for each root and target.
Decode it with `readLayoutState` and pass it back when updating or retiring a delivery. The library
does not read or write a state file. Matching output bytes do not prove ownership. If an unmanaged
file or key conflicts, or if an owned output changed since the previous application, the library
refuses the conflicting change. Apply an empty selection with its previous state to retire that
delivery. Files and ownership records from other targets are not part of that operation.

See [bundled instructions and example](../../assets/README.md) for a nonempty rule and skill selection.
Run `npm run test:layout` for the strict build, declaration consumer, native format fixtures and
adapter isolation checks. These tests do not launch agents or verify a harness's discovery on startup.
